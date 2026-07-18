# structure-viewer

Libraries for building Minecraft structure viewers on top of
[deepslate](https://github.com/misode/deepslate).

> **Not affiliated with the deepslate project or Mojang.** These are
> independent, community-maintained libraries that build on
> [deepslate](https://github.com/misode/deepslate) (MIT, © Misode) and are
> neither endorsed by nor associated with it. Minecraft is a trademark of
> Mojang Studios; no Minecraft assets are distributed with these packages —
> the `fetch-mc-assets` CLI downloads them into your own project at build time.

| npm package | Directory | What it does |
| --- | --- | --- |
| `@redtact/deepslate-extras` | [`packages/deepslate-extras`](packages/deepslate-extras) | Bit-identical performance patches for deepslate, fade ("dim the unselected part") rendering, structure splitting/slicing, block raycasting, and a dirty-flag render loop. |
| `@redtact/mc-assets` | [`packages/mc-assets`](packages/mc-assets) | Self-hosted Minecraft asset pipeline: fetch blockstates/models/textures at build time with the bundled CLI, then build a deepslate `Resources` at runtime without any third-party origin dependency. |

Both packages declare `deepslate` (`^0.25.1`) as a **peer dependency** — install
it alongside them.

Node.js **>= 20.19** (or >= 22.12 on the 22.x line) is required when consuming
the CJS entry points: `deepslate` is ESM-only, so `require()` of these packages
relies on Node's `require(esm)` support.

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
- `fastPartialChunkUpdate` (opt-in): makes
  `ChunkBuilder.updateStructureBuffers(chunkPositions)` scan only the requested
  chunks' coordinates instead of every block in the structure. See
  [Incremental chunk updates](#incremental-chunk-updates). The full-rebuild path
  (no `chunkPositions`) is left completely untouched.

### Incremental chunk updates

Re-splitting a structure and calling `setStructure` on both renderers costs a
full re-mesh — about 1.8 s for a 131k-block structure, which is a visible freeze
if it happens on every picked block. `IncrementalSplitView` instead moves the
picked blocks between the two structures in place and re-meshes only the chunks
that actually changed (the block's own chunk plus its 6 neighbours, because face
culling looks at adjacent blocks).

```ts
import {
  applyDeepslatePatches,
  IncrementalSplitView,
} from "@redtact/deepslate-extras";

applyDeepslatePatches({ fastPartialChunkUpdate: true });

const view = new IncrementalSplitView(
  structure,
  { specs, crop: null, slice: null },
  { inner: structureRenderer, outer: fadeRenderer },
  { chunkSize: 16 }, // must match the renderers' ChunkBuilder chunk size
);

// One picked block. `next` describes the inputs AFTER this toggle is applied.
const next = { specs: specsWithPositions(nextPositions), crop, slice };
const result = view.toggle(["3,4,5"], true, next);
if (result.status === "needs-resplit") {
  // The view was left untouched — do the full rebuild exactly once, here.
  view.resplit(next);
}
loop.invalidate(); // toggle only updates GPU buffers; it does not request a redraw
```

`toggle` returns a discriminated result rather than a number:

| `status` | meaning | what the caller must do |
| --- | --- | --- |
| `applied` | `chunks` chunks were re-meshed, `moved` blocks changed side | redraw |
| `noop` | nothing moved (`skipped` keys were air / already moved / outside the slice or crop) | redraw not needed |
| `needs-resplit` | **the view is unchanged**; `reason` is `threshold`, `structure`, or `positions` | call `view.resplit(inputs)` once |

Rules that the view enforces for you:

- **`inputs` describes the state *after* the toggle.** The view compares it with
  its own state — both the structural signature (specs/crop/slice minus
  positions) and the resulting set of picked positions. If the caller's change
  detection is wrong (for example treating a *replacement* selection as an
  *addition*), the view refuses the diff and asks for a resplit instead of
  silently leaving stale blocks selected.
- **`needs-resplit` never mutates the view**, so the full rebuild happens exactly
  once, in the caller. Going from 1 picked block to 0 (or 0 to 1) always lands
  here, because `splitStructure` ignores `region`/`materials` while `positions`
  is non-empty — the meaning of the split itself changes.
- Pass every key of a drag selection in **one** `toggle` call. Calling it per
  block bypasses the threshold and re-meshes ~7 chunks each time.
- `fullRebuildChunkThreshold` defaults to `48 * (16³ / chunk cells)` — 48 at
  `chunkSize: 16`, 384 at 8, 6 at 32 — because the cost of a diff scales with
  dirty chunks × cells per chunk, not with dirty chunks alone.
- `validate` (default on) runs the internal-invariant check at construction and
  on every `resplit`, reporting duplicate coordinates and inner/outer overlap
  through `onValidationError` (default `console.error`).
- Do not call `addBlock` on the `Structure` returned by `view.inner` / `view.outer`;
  their palettes are detached copies, so the palette indices would diverge.

Bench (`node tools/bench-viewer.mjs --size 64`, 131k blocks, `chunkSize: 16`):
one picked block goes from **1773 ms** (full re-mesh of both renderers) to
**52 ms**, and an 865-block drag selection takes 236 ms across 8 dirty chunks.

#### Block order and translucent blending

deepslate merges a chunk's quads in the order the blocks are processed, and that
order becomes the draw order. Because the renderer blends with `BLEND` enabled —
and `FadeStructureRenderer` draws with `depthMask(false)` — **draw order changes
the final pixels** for semi-transparent blocks (glass, stained glass, ice, water)
and for the whole faded layer.

So the two paths must agree on order. `splitStructure`, `splitStructureCropped`
and `filterStructureByY` normalise their output to ascending flat index
(`x*sy*sz + y*sz + z`), `removeStoredBlock` / `addStoredBlock` preserve that
order, and `fastPartialChunkUpdate` scans x→y→z — which is the same order. A
partial update therefore produces byte-identical draw order to a full rebuild.

If you feed a renderer a structure that did **not** come from those split
helpers (a raw `Structure` from a converter, say), call `sortStructureBlocks(structure)`
once before rendering, or the fade layer will shift colour whenever a chunk is
partially updated.

The underlying pieces are exported for direct use: `removeStoredBlock` /
`addStoredBlock` / `storedBlockAt` move `deepslate` `Structure` entries in place
(keeping `blocks` and `blocksMap` consistent), `dirtyChunksFor` computes the
chunk set to re-mesh clamped to the structure bounds, and `sortStructureBlocks` /
`structureBlocksSorted` handle order normalisation.

`FadeStructureRenderer` gained a matching `updateStructureBuffers(chunkPositions?)`
passthrough, an optional `chunkSize` option, and a public `chunkSize` getter that
`IncrementalSplitView` checks against its own setting at construction.

## `@redtact/mc-assets`

### 1. Fetch assets at build time (CLI)

```bash
npx -p @redtact/mc-assets fetch-mc-assets   # writes ./public/mc-assets/1.21.5/
# or, with the package installed: pnpm exec fetch-mc-assets
pnpm exec fetch-mc-assets --out static/mc-assets --force
pnpm exec fetch-mc-assets --emit-module app/mcAssetsRevision.ts
```

Downloads blockstates/models (PrismarineJS/minecraft-assets, SHA-pinned) and
textures (misode/mcmeta, version-tag-pinned) into your app's static directory.
Commit the output for reproducible builds. A `revision.json` is written next to
the assets, and `--emit-module <path>` additionally writes a constant module
(`export const MC_ASSETS_REVISION = "..."`) into your app source so the
cache-bust revision is wired by an unconditional import and cannot be
forgotten.

### 2. Build deepslate resources at runtime

```ts
import { configureMcAssets, buildResources } from "@redtact/mc-assets";
import { MC_ASSETS_REVISION } from "./mcAssetsRevision"; // from --emit-module

// Replaces the entire config — pass all options in one call
// (omitted fields reset to their defaults).
configureMcAssets({
  baseUrl: "https://cdn.example.com/mc-assets", // parent of the version dir
                                                // (default: same-origin "/mc-assets")
  revision: MC_ASSETS_REVISION,                 // REQUIRED for immutable-cache serving
});

const resources = await buildResources(structure.getBlocks().map(b => b.state.getName().toString()));
```

### Bundle size: use `/urls` for the lightweight API

The main entry statically imports `deepslate/render` (for `buildResources`), and
deepslate does not declare `sideEffects: false` — so importing anything from the
main entry pulls deepslate into that chunk even if you only called
`textureUrl`. For code paths that only need configuration, URL resolution, or
raw asset fetching, import the deepslate-free subpath instead:

```ts
// ~240 B gzip — no deepslate in the bundle
import { textureUrl, configureMcAssets, MC_VERSION } from "@redtact/mc-assets/urls";

// Only where you actually build deepslate resources (~71 kB gzip with deepslate)
import { buildResources } from "@redtact/mc-assets";
```

`/urls` exports `configureMcAssets`, `McAssetsOptions`, `mcAssetsBase`,
`textureUrl`, `MC_VERSION`, `getBlockStates`, `getBlockModels`, and
`fetchTexture`. The main entry re-exports all of them, so both entries share a
single implementation and configuration state.

`revision` is appended as a `?v=` query for cache busting. If you serve the
assets with immutable/long-lived caching (recommended), wiring it is
**required** — without it, asset pin updates are not picked up until caches
expire (up to a year). It may only be omitted when the assets are served
uncached.

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
   npx -p @redtact/mc-assets fetch-mc-assets --emit-module app/mcAssetsRevision.ts
   # → public/mc-assets/1.21.5/ + リビジョン定数モジュール
   ```

2. アプリ初期化時にパッチ適用とアセット設定:

   ```ts
   import { applyDeepslatePatches } from "@redtact/deepslate-extras";
   import { configureMcAssets, buildResources } from "@redtact/mc-assets";
   import { MC_ASSETS_REVISION } from "./mcAssetsRevision"; // --emit-module の生成物

   applyDeepslatePatches({ releaseQuadsAfterUpload: true }); // GL 生成前に 1 回
   // configureMcAssets は毎回「全置換」— 必要なオプションは 1 回でまとめて渡す。
   // revision は immutable キャッシュ配信では必須 (忘れると pin 更新が反映されない)
   configureMcAssets({ revision: MC_ASSETS_REVISION }); // 既定 baseUrl は同一オリジン /mc-assets
   ```

   バンドルサイズ注意: メインエントリは `deepslate/render` を静的 import する
   (deepslate は `sideEffects: false` 未宣言のため tree shaking で落ちない)。
   URL 解決・設定・アセット取得だけが必要な経路では deepslate 非依存の
   `@redtact/mc-assets/urls` を使う (実測 gzip 241 B、メインエントリは 71.5 kB)。

3. 描画 (deepslate の `StructureRenderer` と組み合わせる):

   ```ts
   import { createRenderLoop, splitStructure, FadeStructureRenderer } from "@redtact/deepslate-extras";

   const resources = await buildResources(blockNames);
   const { inner, outer } = splitStructure(structure, specs); // 選択範囲の内/外に分割
   const loop = createRenderLoop({ draw });
   loop.invalidate(); // カメラ操作・構造変更時に呼ぶ (静止時は rAF ごと停止)
   ```

ライセンスは Apache-2.0。deepslate (MIT) 由来コードの帰属は [NOTICE](NOTICE) を参照。
