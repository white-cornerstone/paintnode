import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const quicklookDir = join(root, 'src-tauri', 'macos', 'quicklook');
const sourcesDir = join(quicklookDir, 'Sources');
const buildDir = join(quicklookDir, 'build');
const entitlements = join(quicklookDir, 'Extension.entitlements');

if (process.platform !== 'darwin') {
  console.log('[quicklook] skipping macOS Quick Look extensions on non-macOS host');
  process.exit(0);
}

const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY || '-';
const signingArgs =
  signingIdentity === '-'
    ? ['--force', '--sign', '-', '--entitlements', entitlements]
    : ['--force', '--sign', signingIdentity, '--timestamp', '--options', 'runtime', '--entitlements', entitlements];
const archs = (process.env.PAINTNODE_QUICKLOOK_ARCHS || 'arm64,x86_64')
  .split(',')
  .map((arch) => arch.trim())
  .filter(Boolean);

const sharedSources = [
  join(sourcesDir, 'AppExtensionMain.swift'),
  join(sourcesDir, 'ORAArchive.swift'),
];

const extensions = [
  {
    name: 'PaintNodeORAThumbnail',
    plist: join(quicklookDir, 'PaintNodeORAThumbnail-Info.plist'),
    sources: [...sharedSources, join(sourcesDir, 'ThumbnailProvider.swift')],
    frameworks: ['Foundation', 'AppKit', 'QuickLookThumbnailing'],
  },
  {
    name: 'PaintNodeORAPreview',
    plist: join(quicklookDir, 'PaintNodeORAPreview-Info.plist'),
    sources: [...sharedSources, join(sourcesDir, 'PreviewViewController.swift')],
    frameworks: ['Foundation', 'AppKit', 'QuickLookUI'],
  },
];

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

for (const ext of extensions) {
  const bundleRoot = join(buildDir, `${ext.name}.appex`, 'Contents');
  const macOSDir = join(bundleRoot, 'MacOS');
  const archOutputs = [];
  mkdirSync(macOSDir, { recursive: true });
  copyFileSync(ext.plist, join(bundleRoot, 'Info.plist'));

  for (const arch of archs) {
    const archOutput = join(buildDir, `${ext.name}-${arch}`);
    const frameworkArgs = ext.frameworks.flatMap((framework) => ['-framework', framework]);
    execFileSync(
      'xcrun',
      [
        'swiftc',
        '-target',
        `${arch}-apple-macos10.15`,
        '-sdk',
        sdk,
        '-O',
        '-application-extension',
        '-module-name',
        ext.name,
        ...ext.sources,
        '-o',
        archOutput,
        ...frameworkArgs,
        '-lz',
      ],
      { stdio: 'inherit' },
    );
    archOutputs.push(archOutput);
  }

  const output = join(macOSDir, ext.name);
  if (archOutputs.length === 1) {
    copyFileSync(archOutputs[0], output);
  } else {
    execFileSync('lipo', ['-create', ...archOutputs, '-output', output], { stdio: 'inherit' });
  }
  execFileSync(
    'codesign',
    [...signingArgs, join(buildDir, `${ext.name}.appex`)],
    { stdio: 'inherit' },
  );
  console.log(`[quicklook] built ${ext.name}.appex for ${archs.join(', ')}`);
}
