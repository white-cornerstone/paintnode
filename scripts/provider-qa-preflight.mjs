import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  assertMacProviderTrustInspection,
  assertSafeExecutablePath,
  inspectMacProviderTrust,
} from './provider-executable-trust.mjs';

const CODEX_TARGETS = {
  'darwin-arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
  'darwin-x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
  'linux-arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
  'linux-x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
  'win32-arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'],
  'win32-x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'],
};

function executable(path, label) {
  try {
    accessSync(path, constants.X_OK);
  } catch (error) {
    throw new Error(`${label} is not executable: ${path}`, { cause: error });
  }
  return path;
}

function readCodexPackage(wrapperPath) {
  if (!wrapperPath.endsWith('/bin/codex.js') && !wrapperPath.endsWith('\\bin\\codex.js')) {
    return null;
  }
  const packageRoot = dirname(dirname(wrapperPath));
  try {
    const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    if (metadata?.name !== '@openai/codex') return null;
    return {
      packageRoot,
      version: typeof metadata.version === 'string' ? metadata.version : null,
    };
  } catch {
    return null;
  }
}

function codexNativePath(packageRoot, platform, arch) {
  const target = CODEX_TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(`Codex QA does not support ${platform}-${arch}.`);
  const [platformPackage, triple] = target;
  const executableName = platform === 'win32' ? 'codex.exe' : 'codex';
  const modern = join(
    packageRoot,
    'node_modules',
    ...platformPackage.split('/'),
    'vendor',
    triple,
    'bin',
    executableName,
  );
  try {
    return executable(realpathSync(modern), 'Codex native executable');
  } catch {
    const legacy = join(packageRoot, 'vendor', triple, 'codex', executableName);
    return executable(realpathSync(legacy), 'Codex native executable');
  }
}

export function resolveProviderLaunch(provider, requestedPath, host = {}) {
  if (provider !== 'codex' && provider !== 'antigravity') {
    throw new Error(`Unsupported provider ${provider}.`);
  }
  if (!isAbsolute(requestedPath)) {
    throw new Error(`${provider} provider QA requires an absolute path.`);
  }
  assertSafeExecutablePath(provider, requestedPath);

  const resolvedPath = executable(realpathSync(requestedPath), `${provider} executable`);
  if (provider === 'codex') {
    const packageInfo = readCodexPackage(resolvedPath);
    if (packageInfo) {
      const launchPath = codexNativePath(
        packageInfo.packageRoot,
        host.platform ?? process.platform,
        host.arch ?? process.arch,
      );
      return {
        provider,
        requestedPath,
        resolvedPath,
        launchPath,
        versionHint: packageInfo.version,
        unwrapped: true,
      };
    }
  }

  return {
    provider,
    requestedPath,
    resolvedPath,
    launchPath: resolvedPath,
    versionHint: null,
    unwrapped: false,
  };
}

export function providerCapabilityArgs(provider) {
  if (provider === 'codex') return ['login', 'status'];
  if (provider === 'antigravity') return ['models'];
  throw new Error(`Unsupported provider ${provider}.`);
}

export function assertMacProviderSignature(provider, path, inspection) {
  assertSafeExecutablePath(provider, path);
  assertMacProviderTrustInspection(provider, inspection);
}

function inspectMacSignature(provider, path) {
  inspectMacProviderTrust(provider, path);
}

export function terminateProviderTree(child, platform, taskkill = spawnSync) {
  if (child.pid == null) {
    return { cleanupError: 'provider process had no PID to terminate', immediateProcessKillRequested: false };
  }
  if (platform === 'win32') {
    const result = taskkill('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      return { cleanupError: null, immediateProcessKillRequested: true };
    }
    let immediateProcessKillRequested = false;
    try {
      immediateProcessKillRequested = child.kill('SIGKILL') !== false;
    } catch {
      immediateProcessKillRequested = false;
    }
    return {
      cleanupError: 'Windows taskkill process-tree cleanup failed; immediate-process SIGKILL fallback was requested',
      immediateProcessKillRequested,
    };
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
    return { cleanupError: null, immediateProcessKillRequested: true };
  } catch {
    try {
      const immediateProcessKillRequested = child.kill('SIGKILL') !== false;
      return {
        cleanupError: immediateProcessKillRequested
          ? 'Unix process-group cleanup failed; immediate-process SIGKILL fallback was requested'
          : 'Unix process-group and immediate-process cleanup failed',
        immediateProcessKillRequested,
      };
    } catch {
      return {
        cleanupError: 'Unix process-group and immediate-process cleanup failed',
        immediateProcessKillRequested: false,
      };
    }
  }
}

export function runProviderCommand(provider, path, args, timeout, host = {}) {
  const env = { ...process.env };
  if (provider === 'codex') {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  }
  const platform = host.platform ?? process.platform;
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, {
      detached: platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks = [];
    let byteLength = 0;
    let settled = false;
    let timer;
    const releaseChildHandles = () => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    const rejectOnce = (message, cleanup = null, cause = undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseChildHandles();
      const cleanupDetail = cleanup?.cleanupError ? ` Cleanup warning: ${cleanup.cleanupError}.` : '';
      reject(new Error(`${message}${cleanupDetail}`, cause ? { cause } : undefined));
    };
    const terminateAndReject = (message) => {
      const cleanup = terminateProviderTree(child, platform);
      rejectOnce(message, cleanup);
    };
    const capture = (chunk) => {
      if (settled) return;
      byteLength += chunk.length;
      if (byteLength > 1024 * 1024) {
        terminateAndReject(`${provider} ${args.join(' ')} exceeded the 1 MiB output limit: ${path}`);
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => {
      rejectOnce(`${provider} ${args.join(' ')} could not launch: ${path}`, null, error);
    });
    timer = setTimeout(() => {
      terminateAndReject(`${provider} ${args.join(' ')} timed out after ${timeout / 1000}s: ${path}`);
    }, timeout);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${provider} ${args.join(' ')} failed with exit ${code}: ${path}`));
        return;
      }
      const output = Buffer.concat(chunks).toString('utf8').trim();
      if (!output) {
        reject(new Error(`${provider} ${args.join(' ')} returned no usable output: ${path}`));
        return;
      }
      resolve(output);
    });
  });
}

export function assertProviderCapabilityOutput(provider, output) {
  const normalized = output.trim();
  if (provider === 'codex') {
    const authenticated = normalized
      .split(/\r?\n/)
      .some((line) => /^Logged in (?:using|with)\s+\S.+$/i.test(line.trim()));
    if (!authenticated) {
      throw new Error('Codex is not authenticated for provider E2E.');
    }
    return;
  }
  if (provider === 'antigravity') {
    const negative = /\bauthentication required\b|\bunauthenticated\b|\bnot logged in\b|\bfailed\b|\bfailure\b|\berror\b|\bwarning\b|\bunavailable\b|\bunable to\b|\bno (?:available )?models?\b/i.test(
      normalized,
    );
    const modelEntry = normalized
      .split(/\r?\n/)
      .some((line) => /^[\p{L}\p{N}][^()\r\n]{0,160}\([^)]+\)$/u.test(line.trim()));
    if (negative || !modelEntry) {
      throw new Error('Antigravity returned no available models for provider E2E.');
    }
    return;
  }
  throw new Error(`Unsupported provider ${provider}.`);
}

export async function preflightProvider(provider, requestedPath, host = {}) {
  const launch = resolveProviderLaunch(provider, requestedPath, host);
  const platform = host.platform ?? process.platform;
  if (platform === 'darwin') inspectMacSignature(provider, launch.launchPath);

  const versionOutput = await runProviderCommand(provider, launch.launchPath, ['--version'], 15_000, host);
  if (!/\d+\.\d+/.test(versionOutput)) {
    throw new Error(`${provider} --version returned no recognizable version: ${launch.launchPath}`);
  }
  const capabilityOutput = await runProviderCommand(
    provider,
    launch.launchPath,
    providerCapabilityArgs(provider),
    60_000,
    host,
  );
  assertProviderCapabilityOutput(provider, capabilityOutput);
  const version = versionOutput.split(/\r?\n/, 1)[0];
  return { ...launch, version };
}
