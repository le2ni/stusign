import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';

function anchors(markdown) {
  const counts = new Map();
  return new Set(
    [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => {
      const base = match[1]
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-');
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);
      return count ? base + '-' + count : base;
    }),
  );
}

/** Validate links against the supplied tree, including an extracted npm package. */
export async function checkDocumentationLinks(root, files) {
  let links = 0;
  for (const name of files) {
    const file = resolve(root, name);
    const markdown = await readFile(file, 'utf8');
    const prose = markdown.replace(/```[^\n]*\n[\s\S]*?```/g, '');
    for (const match of prose.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      const href = match[1];
      if (/^[a-z]+:/i.test(href)) continue;
      const [pathname, hash] = href.split('#');
      const target = pathname ? resolve(dirname(file), decodeURIComponent(pathname)) : file;
      assert(target === root || target.startsWith(root + sep), 'Link escapes the project: ' + href);
      assert(
        await stat(target).catch(() => false),
        relative(root, file) + ': missing link ' + href,
      );
      if (hash && extname(target) === '.md') {
        assert(
          anchors(await readFile(target, 'utf8')).has(decodeURIComponent(hash)),
          relative(root, file) + ': missing heading ' + href,
        );
      }
      links++;
    }
  }
  return links;
}
