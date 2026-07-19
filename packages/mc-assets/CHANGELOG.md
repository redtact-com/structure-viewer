# @redtact/mc-assets

## 0.3.0

### Minor Changes

- 5f5a3e3: Always include the fluid textures, and add `buildResources(blockNames, { extraTextures })`

  deepslate's `liquidRenderer` builds `block/{water,lava}_{still,flow}` texture IDs
  in code, so blockstate → model → parent tracking can never reach them: `*_flow`
  is referenced by no model at all, and `water_still` only appears as the
  `particle` of the `water` model. `liquidRenderer` also runs for any block with
  `waterlogged=true`, which means a structure can need water textures without
  `minecraft:water` ever appearing in its palette — stairs, slabs, fences and
  `bubble_column` all hit this. Such structures rendered water as the missing
  texture (purple/black).

  `buildResources` now always includes those four textures (a few KB), rather than
  only when `water` / `lava` are in the block list. The new optional
  `extraTextures` lets callers add other textures that no model references.

## 0.2.2

### Patch Changes

- Updated dependencies [b7fcc06]
  - @redtact/deepslate-extras@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [4e2a629]
  - @redtact/deepslate-extras@0.2.0

## 0.2.0

### Minor Changes

- 46d6b74: deepslate 非依存のサブパスエントリ `@redtact/mc-assets/urls` を追加

  メインエントリは `buildResources` のために `deepslate/render` を静的 import しており、
  deepslate が `sideEffects: false` を宣言していないため、`textureUrl` だけを import した
  呼び出し側でも deepslate 一式 (+gl-matrix/pako/md5) がバンドルに巻き込まれていた。

  設定・URL 解決・アセット取得 (`configureMcAssets` / `McAssetsOptions` / `mcAssetsBase` /
  `textureUrl` / `MC_VERSION` / `getBlockStates` / `getBlockModels` / `fetchTexture`) だけを
  公開する deepslate 非依存のサブパスを追加した。メインエントリはこのサブパスを
  re-export するため実装・設定状態は共有されたまま。

  実測 (esbuild --bundle --minify、`textureUrl` + `configureMcAssets` のみの entry):

  | import 元                 | raw    | gzip    | deepslate  |
  | ------------------------- | ------ | ------- | ---------- |
  | `@redtact/mc-assets/urls` | 297 B  | 241 B   | 含まれない |
  | `@redtact/mc-assets`      | 246 kB | 71.5 kB | 含まれる   |
