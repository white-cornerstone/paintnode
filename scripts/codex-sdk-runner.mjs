#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { assertProviderExecutableReady } from './provider-executable-trust.mjs';
import { directorActionSchema } from './director-action-schema.mjs';
import {
  workflowDirectorExtractionSchema,
  workflowDirectorGraphDraftSchema,
  workflowDirectorReviewSchema,
  workflowDirectorRevisionSchema,
} from './workflow-director-schema.mjs';

function writeStructuredOutput(path, value, schemaName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The SDK did not return a structured object');
  }
  if (schemaName === 'director-action' && !directorActionSchema.properties.action.enum.includes(value.action)) {
    throw new Error(`The SDK returned an unknown Director action: ${String(value.action)}`);
  }
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function usage() {
  return `Usage: codex-sdk-runner.mjs --cwd DIR [--session-id UUID] [--output-file PATH] [--output-schema director-action|workflow-draft|workflow-revision|workflow-review|workflow-extraction] [--codex-path BIN] [--model MODEL] [--reasoning LEVEL] [--service-tier fast] [--sandbox MODE] [--approval MODE] [--skip-git-repo-check] [--image PATH ...] -- PROMPT`;
}

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    sessionId: undefined,
    outputFile: undefined,
    outputSchema: 'director-action',
    codexPath: undefined,
    model: undefined,
    reasoning: undefined,
    serviceTier: undefined,
    sandbox: 'workspace-write',
    approval: 'never',
    skipGitRepoCheck: false,
    images: [],
    promptParts: [],
  };

  let index = 0;
  let inPrompt = false;
  while (index < argv.length) {
    const arg = argv[index];
    if (inPrompt) {
      options.promptParts.push(arg);
      index += 1;
      continue;
    }
    if (arg === '--') {
      inPrompt = true;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--cwd') {
      options.cwd = requireValue(argv, index, arg);
      index += 2;
    } else if (arg === '--session-id') {
      options.sessionId = requireValue(argv, index, arg);
      index += 2;
    } else if (arg === '--output-file') {
      options.outputFile = requireValue(argv, index, arg);
      index += 2;
    } else if (arg === '--output-schema') {
      options.outputSchema = requireValue(argv, index, arg);
      if (!['director-action', 'workflow-draft', 'workflow-revision', 'workflow-review', 'workflow-extraction'].includes(options.outputSchema)) {
        throw new Error(`Unknown output schema: ${options.outputSchema}`);
      }
      index += 2;
    } else if (arg === '--codex-path') {
      options.codexPath = requireValue(argv, index, arg);
      index += 2;
    } else if (arg === '--model') {
      options.model = requireValue(argv, index, arg);
      index += 2;
    } else if (arg === '--reasoning') {
      options.reasoning = requireValue(argv, index, arg);
      index += 2;
    } else if (arg === '--service-tier') {
      options.serviceTier = requireValue(argv, index, arg);
      index += 2;
    } else if (arg === '--sandbox') {
      options.sandbox = requireValue(argv, index, arg);
      index += 2;
    } else if (arg === '--approval') {
      options.approval = requireValue(argv, index, arg);
      index += 2;
    } else if (arg === '--image') {
      options.images.push(requireValue(argv, index, arg));
      index += 2;
    } else if (arg === '--skip-git-repo-check') {
      options.skipGitRepoCheck = true;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function sanitizedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.PAINTNODE_CODEX_IDENTITY;
  if (!env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'codex_sdk_ts';
  return env;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function codexArgs(options, schemaPath) {
  const args = ['exec', '--experimental-json'];
  if (options.serviceTier === 'fast') {
    args.push('--config', 'service_tier="fast"', '--config', 'features.fast_mode=true');
  }
  if (options.model) args.push('--model', options.model);
  if (options.reasoning) args.push('--config', `model_reasoning_effort="${options.reasoning}"`);
  args.push('--sandbox', options.sandbox, '--cd', options.cwd);
  if (options.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (schemaPath) args.push('--output-schema', schemaPath);
  args.push('--config', `approval_policy="${options.approval}"`);
  if (options.sessionId) args.push('resume', options.sessionId);
  for (const image of options.images) args.push('--image', image);
  return args;
}

async function* runCodex(options, prompt, outputSchema) {
  let schemaDir;
  let schemaPath;
  if (outputSchema) {
    schemaDir = mkdtempSync(join(tmpdir(), 'paintnode-codex-schema-'));
    schemaPath = join(schemaDir, 'schema.json');
    writeFileSync(schemaPath, JSON.stringify(outputSchema), 'utf8');
  }
  try {
    // This is deliberately adjacent to the only native spawn in this runner.
    assertProviderExecutableReady('codex', options.codexPath, process.env.PAINTNODE_CODEX_IDENTITY);
    const child = spawn(options.codexPath, codexArgs(options, schemaPath), {
      cwd: options.cwd,
      env: sanitizedEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(prompt);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim()) yield line;
    }
    const result = await exit;
    if (result.code !== 0 || result.signal) {
      const detail = result.signal ? `signal ${result.signal}` : `code ${result.code ?? 1}`;
      throw new Error(`Codex Exec exited with ${detail}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    }
  } finally {
    if (schemaDir) rmSync(schemaDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prompt = options.promptParts.join(' ').trim() || (await readStdin()).trim();
  if (!prompt) throw new Error('Prompt is required');

  if (options.sessionId) {
    process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: options.sessionId, resumed: true })}\n`);
  }
  const outputSchemas = {
    'director-action': directorActionSchema,
    'workflow-draft': workflowDirectorGraphDraftSchema,
    'workflow-revision': workflowDirectorRevisionSchema,
    'workflow-review': workflowDirectorReviewSchema,
    'workflow-extraction': workflowDirectorExtractionSchema,
  };
  let failed = false;
  let finalResponse = null;
  for await (const line of runCodex(
    options,
    prompt,
    options.outputFile ? outputSchemas[options.outputSchema] : undefined,
  )) {
    process.stdout.write(`${line}\n`);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'turn.failed' || event.type === 'error') failed = true;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      finalResponse = event.item.text;
    }
  }
  if (!failed && options.outputFile) {
    if (!finalResponse) throw new Error('Codex did not return structured output');
    writeStructuredOutput(options.outputFile, JSON.parse(finalResponse), options.outputSchema);
    process.stdout.write(
      `${JSON.stringify({ type: 'provider.progress', kind: 'actionReady', message: 'Codex returned a structured Director action' })}\n`,
    );
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ type: 'error', message })}\n`);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
