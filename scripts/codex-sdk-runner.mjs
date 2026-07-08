#!/usr/bin/env node
import { Codex } from '@openai/codex-sdk';

function usage() {
  return `Usage: codex-sdk-runner.mjs --cwd DIR [--codex-path BIN] [--model MODEL] [--reasoning LEVEL] [--service-tier fast] [--sandbox MODE] [--approval MODE] [--skip-git-repo-check] [--image PATH ...] -- PROMPT`;
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
  return env;
}

function sdkConfig(options) {
  if (options.serviceTier !== 'fast') return undefined;
  return {
    service_tier: 'fast',
    features: {
      fast_mode: true,
    },
  };
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prompt = options.promptParts.join(' ').trim() || (await readStdin()).trim();
  if (!prompt) throw new Error('Prompt is required');

  const codex = new Codex({
    codexPathOverride: options.codexPath,
    env: sanitizedEnv(),
    config: sdkConfig(options),
  });
  const thread = codex.startThread({
    workingDirectory: options.cwd,
    skipGitRepoCheck: options.skipGitRepoCheck,
    model: options.model,
    modelReasoningEffort: options.reasoning,
    sandboxMode: options.sandbox,
    approvalPolicy: options.approval,
  });
  const input = [
    ...options.images.map((path) => ({ type: 'local_image', path })),
    { type: 'text', text: prompt },
  ];
  const { events } = await thread.runStreamed(input);
  let failed = false;
  for await (const event of events) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    if (event.type === 'turn.failed' || event.type === 'error') failed = true;
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ type: 'error', message })}\n`);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
