import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { checkDocumentationLinks } from './documentation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'stusign-package-'));
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
try {
  const packed = JSON.parse(
    execFileSync(
      'pnpm',
      ['--config.ignore-scripts=true', 'pack', '--json', '--pack-destination', temporary],
      {
        cwd: root,
        encoding: 'utf8',
      },
    ),
  );
  assert(
    packed.files.every(({ path }) =>
      /^(dist\/[^/]+\.(?:mjs|d\.mts|map)|docs\/[^/]+\.md|docs\/research\/[^/]+\.json|examples\/basic\/[^/]+\.(?:ts|html)|scripts\/stu-serial-to-hid\.py|(?:README|CHANGELOG|CONTRIBUTING)\.md|LICENSE|NOTICE|package\.json)$/.test(
        path,
      ),
    ),
    'Unexpected package file',
  );
  for (const { path } of packed.files) {
    assert(
      !/(hardware-reports|results-\d{4}|stusign-stu540-|\.env|coverage|node_modules|\/build\/)/.test(
        path,
      ),
      `Local artifact packed: ${path}`,
    );
  }
  for (const entry of Object.values(manifest.exports)) {
    for (const file of [entry.types, entry.import]) {
      assert(
        packed.files.some(({ path }) => path === file.replace(/^\.\//, '')),
        `Missing export: ${file}`,
      );
    }
  }
  for (const required of ['README.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md']) {
    assert(
      packed.files.some(({ path }) => path === required),
      `Missing package file: ${required}`,
    );
  }
  const archive = resolve(temporary, packed.filename);
  execFileSync('tar', ['-xzf', archive, '-C', temporary]);
  await mkdir(resolve(temporary, 'node_modules'), { recursive: true });
  const packageRoot = resolve(temporary, 'node_modules/stusign');
  await rename(resolve(temporary, 'package'), packageRoot);
  const documentationLinks = await checkDocumentationLinks(
    packageRoot,
    packed.files.filter(({ path }) => path.endsWith('.md')).map(({ path }) => path),
  );
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    const target = resolve(temporary, 'node_modules', dependency);
    await mkdir(dirname(target), { recursive: true });
    await symlink(resolve(root, 'node_modules', dependency), target, 'junction');
  }
  await writeFile(
    resolve(temporary, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  await writeFile(
    resolve(temporary, 'consumer.mjs'),
    `
    import assert from 'node:assert/strict';
    import { StuDevice } from 'stusign';
    import { ReportId } from 'stusign/protocol';
    import { Recorder } from 'stusign/capture';
    import { MockTransport } from 'stusign/testing';
    for (const path of ['webhid', 'webserial', 'render', 'crypto']) await import('stusign/' + path);
    assert.equal(typeof Recorder, 'function');
    const transport = new MockTransport({ simulateRom: true });
    const device = await StuDevice.open(transport);
    assert.equal(device.support(ReportId.Information).state, 'supported');
    const saved = await device.rom.storeImage({ kind: 'message', number: 1 }, {
      width: 16, height: 8, data: new Uint8Array(16 * 8 * 4).fill(255),
    });
    await device.close();
    const start = transport.calls.length;
    const reopened = await StuDevice.open(transport, {
      startupImage: { source: 'stored', slot: saved.slot, expectedHash: saved.hash },
    });
    assert(transport.calls.slice(start).some(call => call.id === ReportId.RomImageDisplay));
    assert(!transport.calls.slice(start).some(call => call.id === ReportId.ImageDataBlock));
    await reopened.close();
  `,
  );
  execFileSync(process.execPath, ['consumer.mjs'], { cwd: temporary, stdio: 'inherit' });
  await writeFile(
    resolve(temporary, 'consumer.mts'),
    `
    import { StuDevice, type PenSample, type CryptoProvider, type StartupImage, type StoredImageReference } from 'stusign';
    import { ReportId, encodeImage } from 'stusign/protocol';
    import { Recorder } from 'stusign/capture';
    import { MockTransport } from 'stusign/testing';
    import { createWebHidManager } from 'stusign/webhid';
    import { createWebSerialManager, WebSerialTransport, type SerialPort } from 'stusign/webserial';
    export const report: number = ReportId.PenData;
    export const image = encodeImage({ width: 1, height: 1, data: new Uint8Array(4) }, { format: 'mono' });
    export const open = () => StuDevice.open(new MockTransport());
    export const welcome = (saved: StoredImageReference): StartupImage => ({
      source: 'stored', slot: saved.slot, expectedHash: saved.hash,
    });
    export const recorder = new Recorder();
    export type Sample = PenSample;
    export type Provider = CryptoProvider;
    export const serial = (port: SerialPort) => new WebSerialTransport(port, { baudRate: 128000 });
    export { createWebHidManager, createWebSerialManager };
  `,
  );
  await writeFile(
    resolve(temporary, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        strict: true,
        noEmit: true,
        lib: ['ES2022'],
        types: [],
        skipLibCheck: false,
      },
      files: ['consumer.mts'],
    }),
  );
  execFileSync(
    process.execPath,
    [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(temporary, 'tsconfig.json')],
    { cwd: temporary, stdio: 'inherit' },
  );
  await writeFile(
    resolve(temporary, 'browser.mts'),
    `
    import { type StuDevice, type Signature, type DeviceState, type RecordingState, type ModelProfile } from 'stusign';
    import { imageFromCanvas, toPNGBlob, drawSignature } from 'stusign/render';
    import { createRsaCryptoProvider } from 'stusign/crypto';
    export function upload(tablet: StuDevice, canvas: HTMLCanvasElement) {
      return tablet.display.writeImage(imageFromCanvas(canvas));
    }
    export const png = (signature: Signature) => toPNGBlob(signature);
    export { drawSignature, createRsaCryptoProvider };
    export type States = DeviceState | RecordingState;
    export type Profile = ModelProfile;
  `,
  );
  await writeFile(
    resolve(temporary, 'tsconfig.browser.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        lib: ['ES2022', 'DOM'],
        types: [],
        skipLibCheck: false,
      },
      files: ['consumer.mts', 'browser.mts'],
    }),
  );
  execFileSync(
    process.execPath,
    [
      resolve(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      resolve(temporary, 'tsconfig.browser.json'),
    ],
    { cwd: temporary, stdio: 'inherit' },
  );
  for (const { path } of packed.files.filter(({ path }) =>
    /\.(?:mjs|mts|ts|html|py|map|md|json)$/.test(path),
  )) {
    const content = await readFile(resolve(packageRoot, path), 'utf8');
    assert(
      !/\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|usbserial-\d{4,}|hardware-reports\/.*\.json/.test(
        content,
      ),
      `Personal path found in ${path}`,
    );
  }
  console.log(
    `Packed consumer passed: ${packed.files.length} files, ${(await stat(archive)).size} compressed bytes; ${documentationLinks} packaged documentation links; all subpaths import; NodeNext without DOM and browser Bundler declarations pass.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
