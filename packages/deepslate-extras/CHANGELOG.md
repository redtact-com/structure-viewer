# @redtact/deepslate-extras

## 0.3.0

### Minor Changes

- b7fcc06: Fix correctness issues found reviewing 0.2.0's incremental chunk updates. **`IncrementalSplitView`'s API changed** (0.x, compile-time-breaking on purpose).

  **Draw order is now normalised (was a real rendering bug).** deepslate merges a chunk's quads in block order and that becomes the draw order; with `BLEND` enabled — and `depthMask(false)` in `FadeStructureRenderer` — order changes the final pixels for semi-transparent blocks and the whole faded layer. 0.2.0 let the full-rebuild path (block-array order) and the partial-update path (coordinate order) disagree, and its swap-remove scrambled block order on every pick, so picking flickered chunk colours. Now `splitStructure` / `splitStructureCropped` / `filterStructureByY` normalise to ascending flat index, `removeStoredBlock` / `addStoredBlock` preserve order, and both paths produce identical draw order. New `sortStructureBlocks` / `structureBlocksSorted` for structures that don't come from the split helpers.

  **`IncrementalSplitView`:**

  - `toggle(keys, add, inputs)` now returns `{ status: "applied" | "noop" | "needs-resplit", chunks, moved, skipped }` instead of a number, and `inputs` is required. `status: "needs-resplit"` always means _the view is unchanged_ — 0.2.0 resplit internally for one of the two `-1` cases, so following the documented example ran a full rebuild twice (4–5 s on a 131k structure when clearing the last pick).
  - `inputs` is defined as the state **after** the toggle, and the view now verifies the resulting picked-position set, not just whether `positions` is non-empty. This catches selection _replacement_ being reported as an _addition_, which previously left deselected blocks highlighted forever.
  - `resplit(inputs)` takes a `SplitInputs` object; the positional `(specs, crop, slice)` form is gone, since omitting `crop`/`slice` silently cleared them.
  - `validate` (default on) runs the invariant check at construction and after every `resplit`, reporting through `onValidationError` (default `console.error`). `verifyConsistency` also checks palette indices and `state`/`nbt` agreement now.
  - `fullRebuildChunkThreshold` defaults to `48 * (16³ / chunk cells)` so it scales with `chunkSize` (48 at 16, 384 at 8, 6 at 32) instead of being a fixed 48.
  - Constructor throws when the target renderer's `chunkSize` disagrees with the view's. `SplitRenderTarget` gained an optional `chunkSize`, and `FadeStructureRenderer` now exposes it.

  **Patches:** `fastPartialChunkUpdate` now delegates to the stock implementation for `StructureProvider`s that aren't a deepslate `Structure` (a provider whose blocks live outside `[0, getSize())` had them dropped by the coordinate scan). Patch options are stored on a shared object rather than module scope, so a second copy of this module (ESM + CJS, or double bundling) can no longer silently lose `fastPartialChunkUpdate`.

## 0.2.0

### Minor Changes

- 4e2a629: Add incremental chunk updates, so toggling one picked block no longer costs a full re-mesh (1776 ms → 48.5 ms on a 131k-block structure).

  - `applyDeepslatePatches({ fastPartialChunkUpdate: true })` (opt-in, patch (e)) replaces `ChunkBuilder.updateStructureBuffers(chunkPositions)` with a chunk-coordinate scan, making a partial update independent of the structure's block count. The full-rebuild path (no `chunkPositions`) still delegates to the stock deepslate implementation, so the default code path is unchanged.
  - `IncrementalSplitView` keeps the `inner`/`outer` structures of a split up to date in place (`toggle` / `resplit`), re-meshing only the dirty chunks and falling back to a full rebuild past `fullRebuildChunkThreshold` (default 48). It self-checks the caller's `specs`/`crop`/`slice` signature and force-resplits on a mismatch.
  - New in-place helpers: `removeStoredBlock`, `addStoredBlock`, `storedBlockAt`, `dirtyChunksFor` (own chunk + 6 neighbours, clamped to the structure bounds).
  - `FadeStructureRenderer` gained an `updateStructureBuffers(chunkPositions?)` passthrough and an optional `chunkSize` option (default 16, unchanged behaviour).

  All additive; existing behaviour is unchanged with the default options.
