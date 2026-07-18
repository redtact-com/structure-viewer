# @redtact/deepslate-extras

## 0.2.0

### Minor Changes

- 4e2a629: Add incremental chunk updates, so toggling one picked block no longer costs a full re-mesh (1776 ms → 48.5 ms on a 131k-block structure).

  - `applyDeepslatePatches({ fastPartialChunkUpdate: true })` (opt-in, patch (e)) replaces `ChunkBuilder.updateStructureBuffers(chunkPositions)` with a chunk-coordinate scan, making a partial update independent of the structure's block count. The full-rebuild path (no `chunkPositions`) still delegates to the stock deepslate implementation, so the default code path is unchanged.
  - `IncrementalSplitView` keeps the `inner`/`outer` structures of a split up to date in place (`toggle` / `resplit`), re-meshing only the dirty chunks and falling back to a full rebuild past `fullRebuildChunkThreshold` (default 48). It self-checks the caller's `specs`/`crop`/`slice` signature and force-resplits on a mismatch.
  - New in-place helpers: `removeStoredBlock`, `addStoredBlock`, `storedBlockAt`, `dirtyChunksFor` (own chunk + 6 neighbours, clamped to the structure bounds).
  - `FadeStructureRenderer` gained an `updateStructureBuffers(chunkPositions?)` passthrough and an optional `chunkSize` option (default 16, unchanged behaviour).

  All additive; existing behaviour is unchanged with the default options.
