import { defineConfig } from 'tsup';

export default defineConfig({
  // urls は deepslate 非依存の軽量サブパス。別エントリにすることで
  // "@redtact/mc-assets/urls" だけを import した呼び出し側のバンドルに
  // deepslate が入らないようにする (成果物は dist/urls.js を参照)。
  entry: ['src/index.ts', 'src/urls.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  target: 'es2022',
  platform: 'neutral',
  external: ['deepslate', '@redtact/deepslate-extras'],
});
