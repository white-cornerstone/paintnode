#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'dist/managed-runtimes');
const repository = process.env.GITHUB_REPOSITORY ?? 'white-cornerstone/paintnode';
const tag = process.env.RUNTIME_RELEASE_TAG ?? 'provider-runtimes-latest';
const metadata = readdirSync(directory)
  .filter((name) => name.endsWith('.metadata.json'))
  .map((name) => JSON.parse(readFileSync(resolve(directory, name), 'utf8')));

const packages = [];
for (const item of metadata) {
  let target = packages.find((entry) => entry.provider === item.provider && entry.packageVersion === item.packageVersion);
  if (!target) {
    target = {
      provider: item.provider,
      packageVersion: item.packageVersion,
      sdkVersion: item.sdkVersion,
      engineVersion: item.engineVersion,
      protocolVersion: item.protocolVersion,
      minimumPaintNodeVersion: item.minimumPaintNodeVersion,
      artifacts: [],
    };
    packages.push(target);
  }
  target.artifacts.push({
    os: item.artifact.os,
    arch: item.artifact.arch,
    url: `https://github.com/${repository}/releases/download/${tag}/${basename(item.artifact.file)}`,
    sha256: item.artifact.sha256,
    size: item.artifact.size,
  });
}

if (!packages.length) throw new Error(`No runtime metadata found in ${directory}`);
writeFileSync(resolve(directory, 'runtime-manifest.json'), `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`);
