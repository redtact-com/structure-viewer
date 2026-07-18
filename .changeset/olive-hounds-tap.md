---
"@redtact/deepslate-extras": minor
---

Fix correctness issues found reviewing 0.2.0's incremental chunk updates. **`IncrementalSplitView`'s API changed** (0.x, compile-time-breaking on purpose).

**Draw order is now normalised (was a real rendering bug).** deepslate merges a chunk's quads in block order and that becomes the draw order; with `BLEND` enabled — and `depthMask(false)` in `FadeStructureRenderer` — order changes the final pixels for semi-transparent blocks and the whole faded layer. 0.2.0 let the full-rebuild path (block-array order) and the partial-update path (coordinate order) disagree, and its swap-remove scrambled block order on every pick, so picking flickered chunk colours. Now `splitStructure` / `splitStructureCropped` / `filterStructureByY` normalise to ascending flat index, `removeStoredBlock` / `addStoredBlock` preserve order, and both paths produce identical draw order. New `sortStructureBlocks` / `structureBlocksSorted` for structures that don't come from the split helpers.

**`IncrementalSplitView`:**

- `toggle(keys, add, inputs)` now returns `{ status: "applied" | "noop" | "needs-resplit", chunks, moved, skipped }` instead of a number, and `inputs` is required. `status: "needs-resplit"` always means *the view is unchanged* — 0.2.0 resplit internally for one of the two `-1` cases, so following the documented example ran a full rebuild twice (4–5 s on a 131k structure when clearing the last pick).
- `inputs` is defined as the state **after** the toggle, and the view now verifies the resulting picked-position set, not just whether `positions` is non-empty. This catches selection *replacement* being reported as an *addition*, which previously left deselected blocks highlighted forever.
- `resplit(inputs)` takes a `SplitInputs` object; the positional `(specs, crop, slice)` form is gone, since omitting `crop`/`slice` silently cleared them.
- `validate` (default on) runs the invariant check at construction and after every `resplit`, reporting through `onValidationError` (default `console.error`). `verifyConsistency` also checks palette indices and `state`/`nbt` agreement now.
- `fullRebuildChunkThreshold` defaults to `48 * (16³ / chunk cells)` so it scales with `chunkSize` (48 at 16, 384 at 8, 6 at 32) instead of being a fixed 48.
- Constructor throws when the target renderer's `chunkSize` disagrees with the view's. `SplitRenderTarget` gained an optional `chunkSize`, and `FadeStructureRenderer` now exposes it.

**Patches:** `fastPartialChunkUpdate` now delegates to the stock implementation for `StructureProvider`s that aren't a deepslate `Structure` (a provider whose blocks live outside `[0, getSize())` had them dropped by the coordinate scan). Patch options are stored on a shared object rather than module scope, so a second copy of this module (ESM + CJS, or double bundling) can no longer silently lose `fastPartialChunkUpdate`.
