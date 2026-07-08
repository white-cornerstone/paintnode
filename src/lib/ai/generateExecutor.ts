import {
  codexConfigFromRunOptions,
  antigravityConfigFromRunOptions,
  generateCodexFillImage,
  generateCodexImage,
  generateAntigravityFillImage,
  generateAntigravityImage,
  generateImage,
  type ProjectAsset,
  type TargetDimensions,
} from '../integrations/desktop';
import { aiTasks, type AiTask } from '../state/aiTasks.svelte';
import { editor } from '../state/editor.svelte';
import { project } from '../state/project.svelte';
import { settings } from '../state/settings.svelte';
import { DEFAULT_CUSTOM_GENERATOR_ARGS, aiRunOptionsFromSettings } from '../state/settings';
import { AiProgressListener, createRunId, focusTaskDocument } from './taskSupport';

/**
 * Executor for `generate` tasks. Everything it needs comes from the task
 * record (detail + documentId) and the app stores, so Retry works for
 * restored tasks after an app restart — including ones interrupted by the
 * restart itself.
 */

export function defaultFillPrompt(): string {
  return 'Naturally extend the existing image into the masked transparent area, matching the original scene, perspective, lighting, color, grain, and camera style.';
}

function targetDimensions(): TargetDimensions | null {
  const doc = editor.doc;
  if (!doc) return null;
  return { width: doc.width, height: doc.height };
}

async function executeGenerateTask(task: AiTask): Promise<void> {
  const detail = task.detail.kind === 'generate' ? task.detail : null;
  if (!detail) return;
  // Tasks saved before run options were recorded fall back to current settings.
  const runOptions = detail.runOptions ?? aiRunOptionsFromSettings(settings.value);
  const customArgs =
    detail.customArgs ??
    (settings.value.ai.customGenerateArgsText || settings.value.ai.customArgsText || DEFAULT_CUSTOM_GENERATOR_ARGS);
  const fillMode = detail.fillMode;
  const userPrompt = detail.prompt;
  const references = detail.references ?? [];
  const taskProjectPath = task.projectPath;
  const progressListener = new AiProgressListener();
  aiTasks.setProgress(
    task.id,
    runOptions.provider === 'codex'
      ? 'Preparing Codex request...'
      : runOptions.provider === 'antigravity'
        ? 'Preparing Antigravity request...'
        : 'Running local generator...',
  );
  editor.flash(
    fillMode
      ? 'Preparing generative fill...'
      : runOptions.provider === 'codex'
        ? 'Generating with Codex...'
        : runOptions.provider === 'antigravity'
          ? 'Generating with Antigravity...'
          : 'Generating image...',
  );
  const runId =
    runOptions.provider === 'codex' || runOptions.provider === 'antigravity'
      ? task.runId ?? createRunId('generate')
      : '';
  if (runId && task.runId !== runId) aiTasks.setRunId(task.id, runId);
  if (runId) {
    progressListener.start(
      runId,
      (message, payload) => {
        aiTasks.setProgress(task.id, message);
        if (payload.partIndex && payload.partCount) {
          aiTasks.setPartProgress(task.id, payload.partIndex, payload.partCount);
        }
      },
      () =>
        aiTasks.setProgress(
          task.id,
          runOptions.provider === 'antigravity' ? 'Local Antigravity is running...' : 'Local Codex is running...',
        ),
    );
  }
  try {
    // Re-apply the dialog's provider guards: tasks saved without runOptions
    // fall back to current settings, which the dialog never vetted.
    if (fillMode && runOptions.provider === 'custom') {
      throw new Error('Mask-guided generative fill is currently available with Local Codex or Antigravity account.');
    }
    if (runOptions.provider === 'custom' && !runOptions.customBin.trim()) {
      throw new Error('Enter the generator command in AI settings.');
    }
    if (runOptions.provider === 'custom' && references.length) {
      throw new Error('Reference images are currently available with Local Codex or Antigravity account.');
    }
    // On retry another document may be active; the fill input must come from
    // the document the task was started in (null means the active document).
    focusTaskDocument(task.documentId);
    const fillInput = fillMode ? await editor.prepareGenerativeFillInput() : null;
    if (fillMode && !fillInput) throw new Error('The current selection has no editable pixels.');
    // If the user starts from a selection, keep the mask-guided fill path even
    // when the selected pixels are blank. The fill backends own ratio matching,
    // storyboard/draft planning, and paste-back masks for this workflow.
    const fillEdit = fillInput;
    const generationPrompt = userPrompt;
    const generationTarget = fillEdit ? null : targetDimensions();
    const keepJobDir = settings.value.workspace.keepAiRunInputs;
    const fillJobProjectPath = fillEdit && keepJobDir ? taskProjectPath : null;
    if (fillInput) {
      aiTasks.setProgress(
        task.id,
        'Starting mask-guided generative fill...',
      );
    }
    const generated =
      runOptions.provider === 'codex'
        ? fillEdit
          ? await generateCodexFillImage(
              codexConfigFromRunOptions(runOptions, fillJobProjectPath, runId, keepJobDir),
              fillEdit.sourcePng,
              fillEdit.editTargetPng,
              fillEdit.maskPng,
              generationPrompt,
              references,
              false,
            )
          : await generateCodexImage(
              codexConfigFromRunOptions(runOptions, taskProjectPath, runId, keepJobDir),
              generationPrompt,
              generationTarget,
              references,
            )
        : runOptions.provider === 'antigravity'
          ? fillEdit
            ? await generateAntigravityFillImage(
                antigravityConfigFromRunOptions(runOptions, fillJobProjectPath, runId, keepJobDir),
                fillEdit.sourcePng,
                fillEdit.editTargetPng,
                fillEdit.maskPng,
                generationPrompt,
                references,
                false,
              )
            : await generateAntigravityImage(
                antigravityConfigFromRunOptions(runOptions, taskProjectPath, runId, keepJobDir),
                generationPrompt,
                generationTarget,
                references,
              )
          : null;
    const generatedAssetIds = new Set<string>();
    if (generated?.asset?.id) generatedAssetIds.add(generated.asset.id);
    for (const asset of generated?.assets ?? []) generatedAssetIds.add(asset.id);
    for (const layer of generated?.layers ?? []) {
      if (layer.asset?.id) generatedAssetIds.add(layer.asset.id);
    }
    const generatedAssetCount = generatedAssetIds.size;
    if (generated?.asset || generatedAssetCount > 0) await project.refresh(taskProjectPath);
    const dataUrl =
      generated?.dataUrl ??
      (await generateImage(
        {
          bin: runOptions.customBin.trim(),
          args: customArgs
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        },
        generationPrompt,
      ));
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    let fillAsset: ProjectAsset | null = generated?.asset ?? null;
    if (fillInput && !fillAsset && !generated && taskProjectPath) {
      fillAsset = await project.storeGeneratedBlobAt(
        taskProjectPath,
        blob,
        `Generative fill ${generationPrompt.slice(0, 48) || 'outpaint'}.png`,
        generationPrompt,
        bmp.width,
        bmp.height,
      );
    }
    const customAsset =
      !fillInput && !generated && taskProjectPath
        ? await project.storeGeneratedBlobAt(taskProjectPath, blob, `AI ${userPrompt.slice(0, 48) || 'generated'}.png`, generationPrompt, bmp.width, bmp.height)
        : null;
    const sourceMeta = {
      assetId: fillAsset?.id ?? customAsset?.id ?? null,
      path: fillAsset?.relativePath ?? customAsset?.relativePath ?? null,
    };
    focusTaskDocument(task.documentId);
    const oversized = fillInput
      ? false
      : editor.placeImage(bmp, bmp.width, bmp.height, `AI: ${userPrompt.slice(0, 24)}`, sourceMeta).oversized;
    if (fillInput) {
      const layerResults = generated?.layers ?? [];
      if (layerResults.length) {
        bmp.close();
        for (const [index, layer] of layerResults.entries()) {
          const layerBmp = await createImageBitmap(await (await fetch(layer.dataUrl)).blob());
          const layerMaskBmp = layer.maskDataUrl
            ? await createImageBitmap(await (await fetch(layer.maskDataUrl)).blob())
            : null;
          const inserted = editor.insertGenerativeFillLayer(
            layerBmp,
            layerBmp.width,
            layerBmp.height,
            layerMaskBmp ?? fillInput.mask,
            layer.name || `Generative fill ${index + 1}`,
            {
              assetId: layer.asset?.id ?? null,
              path: layer.asset?.relativePath ?? null,
            },
          );
          layerMaskBmp?.close();
          layerBmp.close();
          if (!inserted) throw new Error('Unable to place the generated fill layer in the document.');
        }
      } else {
        const inserted = editor.insertGenerativeFillLayer(
          bmp,
          bmp.width,
          bmp.height,
          fillInput.mask,
          `Generative fill: ${generationPrompt.slice(0, 24)}`,
          sourceMeta,
        );
        bmp.close();
        if (!inserted) throw new Error('Unable to place the generated fill layer in the document.');
      }
    } else {
      bmp.close();
    }
    editor.flash(
      fillInput
        ? generatedAssetCount > 1
          ? `Generative fill added; ${generatedAssetCount} generated assets saved`
          : 'Generative fill added'
        : oversized
          ? 'Image generated full-size; use Move or Image > Reveal All to show hidden edges'
          : 'Image generated',
    );
    aiTasks.complete(task.id, fillInput ? 'Generative fill added' : 'Image generated');
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    aiTasks.fail(task.id, message);
    editor.flash('Generation failed');
  } finally {
    progressListener.clear();
  }
}

export function registerAiTaskExecutors(): void {
  aiTasks.registerExecutor('generate', executeGenerateTask);
}
