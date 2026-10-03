import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sourceEntries = {
  stusign: './src/index.ts',
  'stusign/protocol': './src/protocol/index.ts',
  'stusign/webhid': './src/transports/webhid.ts',
  'stusign/webserial': './src/transports/webserial.ts',
  'stusign/capture': './src/capture/index.ts',
  'stusign/render': './src/render/index.ts',
  'stusign/crypto': './src/crypto/index.ts',
  'stusign/testing': './src/testing/index.ts',
};

export default defineConfig({
  resolve: {
    // Examples use public imports; tests must not depend on an existing dist build.
    alias: Object.entries(sourceEntries).map(([name, source]) => ({
      find: new RegExp(`^${name}$`),
      replacement: fileURLToPath(new URL(source, import.meta.url)),
    })),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', 'html'],
    },
    testTimeout: 10_000,
  },
});
