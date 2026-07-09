#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const require = createRequire(import.meta.url);

function usage() {
  return `Usage: claude-agent-runner.mjs --cwd DIR [--claude-path BIN] [--model MODEL] [--effort LEVEL] [--image PATH ...] -- PROMPT`;
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
    claudePath: undefined,
    model: undefined,
    effort: undefined,
    images: [],
    promptParts: [],
    detect: false,
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
    if (arg === '--detect') {
      options.detect = true;
      index += 1;
    } else if (arg === '--cwd') {
      options.cwd = requireValue(argv, index, arg);
      index += 2;
    } else if (arg === '--claude-path') {
      options.claudePath = requireValue(argv, index, arg);
      index += 2;
    } else if (arg === '--model') {
      options.model = requireValue(argv, index, arg);
      index += 2;
    } else if (arg === '--effort') {
      options.effort = requireValue(argv, index, arg);
      index += 2;
    } else if (arg === '--image') {
      options.images.push(requireValue(argv, index, arg));
      index += 2;
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
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'paintnode/claude-planner';
  return env;
}

function sdkPackageVersion() {
  try {
    return require('@anthropic-ai/claude-agent-sdk/package.json').version;
  } catch {
    return null;
  }
}

function bundledClaudePath() {
  const suffix = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const platform =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'linux'
        ? 'linux'
        : process.platform === 'win32'
          ? 'win32'
          : null;
  const arch =
    process.arch === 'arm64'
      ? 'arm64'
      : process.arch === 'x64'
        ? 'x64'
        : null;
  if (!platform || !arch) return null;
  for (const packageName of [
    `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`,
    `@anthropic-ai/claude-agent-sdk-${platform}-${arch}-musl`,
  ]) {
    try {
      const packageJson = require.resolve(`${packageName}/package.json`);
      const candidate = path.join(path.dirname(packageJson), suffix);
      if (existsSync(candidate)) return candidate;
    } catch {
      // Try the next optional platform package.
    }
  }
  return null;
}

function detect(options) {
  const version = sdkPackageVersion();
  const bundledPath = bundledClaudePath();
  process.stdout.write(
    `${JSON.stringify({
      type: 'detect',
      found: Boolean(options.claudePath || bundledPath || version),
      path: options.claudePath || bundledPath || 'Claude Agent SDK bundled CLI',
      version: version ? `Claude Agent SDK ${version}` : null,
      error: null,
    })}\n`,
  );
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function plannerPrompt(prompt, images) {
  if (!images.length) return prompt;
  const imageList = images.map((path) => `- ${path}`).join('\n');
  return `Use the Read tool to inspect these local PaintNode image files before planning:\n${imageList}\n\n${prompt}`;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.detect) {
    detect(options);
    return;
  }

  const prompt = options.promptParts.join(' ').trim() || (await readStdin()).trim();
  if (!prompt) throw new Error('Prompt is required');

  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: null })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);
  const messages = query({
    prompt: plannerPrompt(prompt, options.images),
    options: {
      cwd: options.cwd,
      pathToClaudeCodeExecutable: options.claudePath,
      model: options.model,
      effort: options.effort,
      tools: ['Read', 'Write'],
      allowedTools: ['Read', 'Write'],
      permissionMode: 'acceptEdits',
      maxTurns: 8,
      env: sanitizedEnv(),
    },
  });

  let failed = false;
  for await (const message of messages) {
    process.stdout.write(`${JSON.stringify({ type: 'claude.message', message })}\n`);
    if (message.type === 'assistant') {
      const text = textFromContent(message.message?.content);
      if (text) {
        process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n`);
      }
    } else if (message.type === 'result') {
      if (message.subtype && message.subtype !== 'success') failed = true;
      const result = message.result || message.error || message.subtype;
      if (typeof result === 'string' && result.trim()) {
        process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: result.trim() } })}\n`);
      }
    } else if (message.type === 'system' && message.subtype === 'auth_status') {
      process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Claude authentication checked.' } })}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify({ type: failed ? 'error' : 'turn.completed' })}\n`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ type: 'error', message })}\n`);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
