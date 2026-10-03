import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const example = process.argv[2] ?? 'hardware';
if (!['basic', 'hardware'].includes(example)) throw new Error('Unknown example');
process.chdir(project);
await build({ config: resolve(project, 'tsdown.config.ts') });
await build({
  config: false,
  entry: { app: `examples/${example}/app.ts` },
  outDir: `examples/${example}/build`,
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: true,
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
});

const root = resolve(project, `examples/${example}`);
const port = Number(process.env.STUSIGN_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid STUSIGN_PORT');
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = resolve(
      root,
      `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`,
    );
    if (!path.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    const data = await readFile(path);
    const contentType =
      {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.map': 'application/json',
      }[extname(path)] ?? 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': `${contentType}; charset=utf-8`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(data);
  } catch {
    response.writeHead(404).end('Not found');
  }
});
server.on('error', (error) => {
  console.error(`Cannot start the hardware harness: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () =>
  console.log(
    `${example === 'basic' ? 'StuSign quick start' : 'STU-540 test harness'}: http://127.0.0.1:${port}\nPress Ctrl+C to stop.`,
  ),
);
function stop() {
  server.close(() => process.exit(0));
  // A browser may leave a speculative or incomplete HTTP request connected.
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 1000).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
