#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  let codexPath;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--codex-path') {
      codexPath = requireValue(argv, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { codexPath };
}

function codexCommand(codexPath) {
  if (codexPath) return { command: codexPath, args: ['app-server', '--listen', 'stdio://'] };
  return {
    command: process.execPath,
    args: [require.resolve('@openai/codex/bin/codex.js'), 'app-server', '--listen', 'stdio://'],
  };
}

function sanitizedEnv() {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const executable = codexCommand(options.codexPath);
  const child = spawn(executable.command, executable.args, {
    env: sanitizedEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let finished = false;

  const finish = (error, result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    child.kill();
    if (error) {
      process.stderr.write(`${error.message}${stderr ? `\n${stderr.trim()}` : ''}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  };

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const handleMessage = (message) => {
    if (message.id === 1) {
      if (message.error) return finish(new Error(message.error.message ?? 'Codex initialization failed'));
      send({ method: 'initialized', params: {} });
      send({ id: 2, method: 'model/list', params: { limit: 100 } });
    } else if (message.id === 2) {
      if (message.error) return finish(new Error(message.error.message ?? 'Codex model discovery failed'));
      finish(null, message.result);
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    let newline = stdout.indexOf('\n');
    while (newline >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) {
        try {
          handleMessage(JSON.parse(line));
        } catch {
          // App-server tracing should be on stderr, but ignore unrelated stdout defensively.
        }
      }
      newline = stdout.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('error', (error) => finish(error));
  child.on('exit', (code) => {
    if (!finished) finish(new Error(`Codex app-server exited before model discovery completed (${code ?? 'unknown'})`));
  });

  const timeout = setTimeout(() => finish(new Error('Codex model discovery timed out')), 15_000);
  send({
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: 'paintnode', title: 'PaintNode', version: '0.1.0' },
    },
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
