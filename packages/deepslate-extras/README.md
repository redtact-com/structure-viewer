# @redtact/deepslate-extras

Extras for [deepslate](https://github.com/misode/deepslate) structure viewers:

> **Not affiliated with the deepslate project.** This is an independent,
> community-maintained package that builds on
> [deepslate](https://github.com/misode/deepslate) (MIT, © Misode) and is
> neither endorsed by nor associated with it.

- `applyDeepslatePatches` — runtime prototype patches for deepslate 0.25.1
  (bit-identical output, 2-3x faster mesh builds, Uint32 index buffers,
  location caching, optional CPU-side quad release after GPU upload, optional
  block-count-independent partial chunk updates)
- `FadeStructureRenderer` — draw the unselected part of a structure translucent
  and desaturated, with selection boxes / hover / drag-preview line meshes
- `splitStructure` / `splitStructureCropped` / `filterStructureByY` — split a
  structure by region, material, or picked positions without shifting
  coordinates
- `IncrementalSplitView` — keep the split structures up to date in place and
  re-mesh only the affected chunks, so toggling one picked block costs tens of
  milliseconds instead of a full re-mesh (1773 ms → 52 ms at 131k blocks)
- `ddaRaycast` / `cameraRayFromMouse` / `rayToStructureEntry` — block picking
- `createRenderLoop` — dirty-flag `requestAnimationFrame` loop that fully stops
  when idle
- `getSliceRange`, `getBlockFlags`, `padTextureBlobs` helpers

`deepslate` (`^0.25.1`) is a peer dependency. Node.js >= 20.19 (or >= 22.12 on
the 22.x line) is required for the CJS entry (`require(esm)` support, since
deepslate is ESM-only).

See the [repository README](https://github.com/redtact-com/structure-viewer#readme)
for usage examples.

## Incremental chunk updates

```ts
import { applyDeepslatePatches, IncrementalSplitView } from "@redtact/deepslate-extras";

applyDeepslatePatches({ fastPartialChunkUpdate: true });

const view = new IncrementalSplitView(
  structure,
  { specs, crop: null, slice: null },
  { inner: structureRenderer, outer: fadeRenderer },
  { chunkSize: 16 }, // must match both renderers' ChunkBuilder chunk size
);

// `next` is the state AFTER this toggle is applied.
const next = { specs: specsWithPositions(nextPositions), crop, slice };
const result = view.toggle(["3,4,5"], true, next);
if (result.status === "needs-resplit") view.resplit(next); // view was left untouched
loop.invalidate(); // toggle updates GPU buffers only; it does not request a redraw
```

Four things to get right:

1. **`inputs` is the state *after* the toggle.** The view checks both the
   structural signature (specs/crop/slice) and the resulting picked-position set
   against its own state, and refuses the diff on a mismatch rather than leaving
   stale blocks selected.
2. **`needs-resplit` means the view is unchanged** — call `resplit(inputs)`
   exactly once. It never resplits internally, so a full rebuild never runs twice.
   Going from 0 picked blocks to 1 (or 1 to 0) always lands here, because
   `splitStructure` ignores `region`/`materials` while `positions` is non-empty.
3. **`chunkSize` must match** across `IncrementalSplitView`, `StructureRenderer`
   and `FadeStructureRenderer`. A mismatch is thrown at construction when the
   renderer exposes `chunkSize` (`FadeStructureRenderer` does).
4. **Block order affects translucent blending.** deepslate draws a chunk's quads
   in merge order, with `BLEND` on (and `depthMask(false)` in the fade renderer),
   so order changes the pixels for glass/water/ice and for the whole faded layer.
   The split helpers normalise to ascending flat index and the partial update
   scans in the same order, so both paths match. For a structure that did not
   come from those helpers, call `sortStructureBlocks(structure)` once first.

`toggle` returns `{ status: "applied" | "noop" | "needs-resplit", chunks, moved,
skipped }`. Pass all keys of a drag selection in one call — calling it per block
bypasses `fullRebuildChunkThreshold` and re-meshes ~7 chunks every time.

## License

Apache-2.0. Contains code derived from deepslate (MIT) — see `NOTICE`.
