import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    protocol: 'src/protocol/index.ts',
    webhid: 'src/transports/webhid.ts',
    webserial: 'src/transports/webserial.ts',
    capture: 'src/capture/index.ts',
    render: 'src/render/index.ts',
    crypto: 'src/crypto/index.ts',
    testing: 'src/testing/index.ts',
  },
  format: 'esm',
  platform: 'neutral',
  fixedExtension: true,
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  publint: true,
});
