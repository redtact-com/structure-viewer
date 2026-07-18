# structure-viewer

Libraries for building Minecraft structure viewers on top of
[deepslate](https://github.com/misode/deepslate).

| npm package | Directory | What it does |
| --- | --- | --- |
| `@redtact/deepslate-extras` | [`packages/deepslate-extras`](packages/deepslate-extras) | Bit-identical performance patches for deepslate, fade ("dim the unselected part") rendering, structure splitting/slicing, block raycasting, and a dirty-flag render loop. |
| `@redtact/mc-assets` | [`packages/mc-assets`](packages/mc-assets) | Self-hosted Minecraft asset pipeline: fetch blockstates/models/textures at build time with the bundled CLI, then build a deepslate `Resources` at runtime without any third-party origin dependency. |

Both packages declare `deepslate` (`^0.25.1`) as a **peer dependency** — install
it alongside them.

## Install

```bash
npm install @redtact/deepslate-extras @redtact/mc-assets deepslate
```

## `@redtact/deepslate-extras`

### Performance patches

Runtime prototype patches for deepslate 0.25.1 that keep the rendered output
bit-for-bit identical while making mesh builds 2-3x faster and removing
per-frame driver round-trips. Apply once, before creating any GL context or
renderer:

```ts
import { applyDeepslatePatches } from "@redtact/deepslate-extras";

applyDeepslatePatches({ releaseQuadsAfterUpload: true });
```

- `Mesh.rebuild`: typed-array direct writes instead of `flatMap`; `Uint32Array`
  index buffers (>65k vertices per chunk mesh). On WebGL1, enable the
  `OES_element_index_uint` extension in your app.
- `Mesh.merge`: `push` instead of `concat` (quadratic copy removal).
- `Renderer`: attribute/uniform location caching per program.
- `releaseQuadsAfterUpload` (opt-in): frees CPU-side quad graphs after GPU
  upload, saving hundreds of MB of JS heap on large structures.

### Render loop

```ts
import { createRenderLoop } from "@redtact/deepslate-extras";

const loop = createRenderLoop({ draw: () => renderer.drawStructure(view) });
loop.invalidate();        // request a redraw (camera moved, structure changed)
loop.setPaused(true);     // e.g. viewer scrolled out of the viewport
loop.dispose();           // on unmount
```

The loop stops `requestAnimationFrame` entirely while nothing is dirty, so an
idle viewer costs zero CPU/GPU.

### Fade rendering and structure splitting

```ts
import {
  FadeStructureRenderer,
  splitStructure,
  filterStructureByY,
} from "@redtact/deepslate-extras";

// Split into a "selected" and "rest" structure of the same size
const { inner, outer } = splitStructure(structure, [
  { region: { start: [0, 0, 0], end: [15, 5, 15] }, materials: ["redstone_wire"] },
]);

// Draw `outer` translucent and desaturated behind the normally-drawn `inner`
const fade = new FadeStructureRenderer(gl, outer, resources, sharedAtlasTexture);
fade.drawFadedStructure(viewMatrix, 0.3, 0.7);
```

Raycasting helpers (`ddaRaycast`, `cameraRayFromMouse`, `rayToStructureEntry`)
support pick/drag-select interactions, and `getSliceRange` /
`filterStructureByY` implement Y-layer slicing.

## `@redtact/mc-assets`

### 1. Fetch assets at build time (CLI)

```bash
npx fetch-mc-assets              # writes ./public/mc-assets/1.21.5/
npx fetch-mc-assets --out static/mc-assets --force
```

Downloads blockstates/models (PrismarineJS/minecraft-assets, SHA-pinned) and
textures (misode/mcmeta, version-tag-pinned) into your app's static directory.
Commit the output for reproducible builds. A `revision.json` is written next to
the assets for cache busting.

### 2. Build deepslate resources at runtime

```ts
import { configureMcAssets, buildResources } from "@redtact/mc-assets";

// Optional. Defaults to same-origin "/mc-assets" with no cache-bust query.
configureMcAssets({
  baseUrl: "https://cdn.example.com/mc-assets", // parent of the version dir
  revision: "3b7b880",                          // from revision.json
});

const resources = await buildResources(structure.getBlocks().map(b => b.state.getName().toString()));
```

`buildResources` fetches only the textures actually referenced by the given
block list, works around deepslate atlas sizing quirks, and returns a ready
`Resources` for `StructureRenderer` / `FadeStructureRenderer`.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
```

Releases are versioned with [changesets](https://github.com/changesets/changesets)
and published from CI — see [PUBLISHING.md](PUBLISHING.md).

## License

[Apache-2.0](LICENSE). This repository contains code derived from
[deepslate](https://github.com/misode/deepslate) (MIT) — the fade shaders are
modified copies of deepslate's standard shaders, and the performance patches
contain optimized copies of deepslate dist implementation. See
[NOTICE](NOTICE) for attribution details.

---

## 日本語 Quickstart

deepslate ベースの Minecraft ストラクチャビューアー向けライブラリ集。

```bash
npm install @redtact/deepslate-extras @redtact/mc-assets deepslate
```

1. アセットをアプリの `public/` に配置 (ビルド時に 1 回、生成物はコミット):

   ```bash
   npx fetch-mc-assets   # → public/mc-assets/1.21.5/
   ```

2. アプリ初期化時にパッチ適用とアセット設定:

   ```ts
   import { applyDeepslatePatches } from "@redtact/deepslate-extras";
   import { configureMcAssets, buildResources } from "@redtact/mc-assets";

   applyDeepslatePatches({ releaseQuadsAfterUpload: true }); // GL 生成前に 1 回
   configureMcAssets({ revision: "3b7b880" }); // 既定 baseUrl は同一オリジン /mc-assets
   ```

3. 描画 (deepslate の `StructureRenderer` と組み合わせる):

   ```ts
   import { createRenderLoop, splitStructure, FadeStructureRenderer } from "@redtact/deepslate-extras";

   const resources = await buildResources(blockNames);
   const { inner, outer } = splitStructure(structure, specs); // 選択範囲の内/外に分割
   const loop = createRenderLoop({ draw });
   loop.invalidate(); // カメラ操作・構造変更時に呼ぶ (静止時は rAF ごと停止)
   ```

ライセンスは Apache-2.0。deepslate (MIT) 由来コードの帰属は [NOTICE](NOTICE) を参照。
