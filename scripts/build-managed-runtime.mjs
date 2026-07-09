#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function value(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? 'no status'}`);
}

function findFile(root, predicate) {
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, name.name);
    if (name.isDirectory()) {
      const found = findFile(path, predicate);
      if (found) return found;
    } else if (predicate(path)) {
      return path;
    }
  }
  return null;
}

const args = process.argv.slice(2);
const provider = value(args, '--provider');
const sdkVersion = value(args, '--sdk-version');
const packageVersion = value(args, '--package-version');
const platform = value(args, '--platform', 'darwin');
const arch = value(args, '--arch', process.arch === 'arm64' ? 'arm64' : 'x64');
const nodePath = resolve(value(args, '--node', process.execPath));
const outputDir = resolve(value(args, '--output', 'dist/managed-runtimes'));

if (!['codex', 'claude'].includes(provider) || !sdkVersion || !packageVersion) {
  throw new Error('Usage: build-managed-runtime.mjs --provider codex|claude --sdk-version VERSION --package-version VERSION [--platform darwin] [--arch arm64|x64] [--node PATH] [--output DIR]');
}

const stage = join(outputDir, `.stage-${provider}-${platform}-${arch}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'bin'), { recursive: true });
mkdirSync(join(stage, 'bridge'), { recursive: true });
cpSync(nodePath, join(stage, 'bin', 'node'));
const nodeLicense = join(dirname(dirname(nodePath)), 'LICENSE');
if (existsSync(nodeLicense)) cpSync(nodeLicense, join(stage, 'NODE-LICENSE'));

const packageName = provider === 'codex' ? '@openai/codex-sdk' : '@anthropic-ai/claude-agent-sdk';
run(
  'npm',
  ['install', '--prefix', join(stage, 'bridge'), '--omit=dev', '--ignore-scripts', '--no-package-lock', `${packageName}@${sdkVersion}`],
  { env: { ...process.env, npm_config_os: platform === 'darwin' ? 'darwin' : platform, npm_config_cpu: arch } },
);

const runnerName = provider === 'codex' ? 'codex-sdk-runner.mjs' : 'claude-agent-runner.mjs';
cpSync(resolve('scripts', runnerName), join(stage, 'bridge', runnerName));
if (provider === 'codex') {
  cpSync(resolve('scripts', 'codex-capabilities.mjs'), join(stage, 'bridge', 'codex-capabilities.mjs'));
}

const modules = join(stage, 'bridge', 'node_modules');
const executableSource = provider === 'codex'
  ? findFile(modules, (path) => basename(path) === 'codex' && path.includes('vendor'))
  : findFile(modules, (path) => basename(path) === 'claude' && path.includes('claude-agent-sdk-'));
if (!executableSource) throw new Error(`Could not locate ${provider} native executable for ${platform}-${arch}`);
const executableName = provider === 'codex' ? 'codex' : 'claude';
const platformPackageRoot = provider === 'codex'
  ? dirname(dirname(dirname(dirname(executableSource))))
  : dirname(executableSource);
const engineRoot = join(stage, 'engine', basename(platformPackageRoot));
cpSync(platformPackageRoot, engineRoot, { recursive: true });
const managedExecutable = join(engineRoot, relative(platformPackageRoot, executableSource));
rmSync(platformPackageRoot, { recursive: true, force: true });

const versionResult = spawnSync(managedExecutable, ['--version'], { encoding: 'utf8' });
const engineVersion = versionResult.status === 0 ? versionResult.stdout.trim() : 'unknown';
const runtimeManifest = {
  provider,
  packageVersion,
  sdkVersion,
  engineVersion,
  protocolVersion: 1,
  minimumPaintNodeVersion: '0.1.6',
  runner: `bridge/${runnerName}`,
  capabilitiesRunner: provider === 'codex' ? 'bridge/codex-capabilities.mjs' : null,
  node: 'bin/node',
  executable: relative(stage, managedExecutable),
  loginArgs: provider === 'codex' ? ['login'] : ['auth', 'login'],
  authCheckArgs: provider === 'codex' ? ['login', 'status'] : ['auth', 'status'],
};
writeFileSync(join(stage, 'runtime-package.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`);

mkdirSync(outputDir, { recursive: true });
const archiveName = `paintnode-${provider}-${platform}-${arch}-${packageVersion}.zip`;
const archivePath = join(outputDir, archiveName);
rmSync(archivePath, { force: true });
run('zip', ['-qry', archivePath, '.'], { cwd: stage });
const bytes = readFileSync(archivePath);
const metadata = {
  provider,
  packageVersion,
  sdkVersion,
  engineVersion,
  protocolVersion: 1,
  minimumPaintNodeVersion: '0.1.6',
  artifact: {
    os: platform,
    arch,
    file: archiveName,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  },
};
writeFileSync(`${archivePath}.metadata.json`, `${JSON.stringify(metadata, null, 2)}\n`);
rmSync(stage, { recursive: true, force: true });
console.log(archivePath);
