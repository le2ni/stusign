import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDocumentationLinks } from './documentation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function markdownFiles(folder) {
  const result = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) result.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith('.md')) result.push(path);
  }
  return result;
}
const files = [
  ...['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md'].map((name) => resolve(root, name)),
  ...(await markdownFiles(resolve(root, 'docs'))),
];
const links = await checkDocumentationLinks(root, files);
const readme = await readFile(resolve(root, 'README.md'), 'utf8');
const embedded = readme.match(/<!-- example: ([^>]+) -->\s*```ts\n([\s\S]*?)```/);
assert(embedded, 'README must embed the runnable getting-started example');
assert.equal(
  embedded[2].trim(),
  (await readFile(resolve(root, embedded[1].trim()), 'utf8')).trim(),
  'README quick start and runnable example have drifted',
);

const temp = await mkdtemp(resolve(root, '.stusign-docs-'));
try {
  const snippets = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)];
  assert(snippets.length > 0, 'No README TypeScript examples found');
  const paths = [];
  for (const [index, match] of snippets.entries()) {
    const name = 'example-' + index + '.mts';
    paths.push(name);
    await writeFile(resolve(temp, name), match[1]);
  }
  await writeFile(
    resolve(temp, 'tsconfig.json'),
    JSON.stringify({
      extends: '../tsconfig.json',
      compilerOptions: { skipLibCheck: false },
      include: paths,
    }),
  );
  execFileSync(
    process.execPath,
    [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(temp, 'tsconfig.json')],
    { cwd: root, stdio: 'inherit' },
  );
  console.log(
    'Documentation passed: ' +
      links +
      ' local links, ' +
      snippets.length +
      ' typed README examples, runnable quick-start parity.',
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
