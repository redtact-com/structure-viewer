# @redtact/deepslate-extras

Extras for [deepslate](https://github.com/misode/deepslate) structure viewers:

> **Not affiliated with the deepslate project.** This is an independent,
> community-maintained package that builds on
> [deepslate](https://github.com/misode/deepslate) (MIT, © Misode) and is
> neither endorsed by nor associated with it.

- `applyDeepslatePatches` — runtime prototype patches for deepslate 0.25.1
  (bit-identical output, 2-3x faster mesh builds, Uint32 index buffers,
  location caching, optional CPU-side quad release after GPU upload)
- `FadeStructureRenderer` — draw the unselected part of a structure translucent
  and desaturated, with selection boxes / hover / drag-preview line meshes
- `splitStructure` / `splitStructureCropped` / `filterStructureByY` — split a
  structure by region, material, or picked positions without shifting
  coordinates
- `ddaRaycast` / `cameraRayFromMouse` / `rayToStructureEntry` — block picking
- `createRenderLoop` — dirty-flag `requestAnimationFrame` loop that fully stops
  when idle
- `getSliceRange`, `getBlockFlags`, `padTextureBlobs` helpers

`deepslate` (`^0.25.1`) is a peer dependency. Node.js >= 20.19 (or >= 22.12 on
the 22.x line) is required for the CJS entry (`require(esm)` support, since
deepslate is ESM-only).

See the [repository README](https://github.com/redtact-com/structure-viewer#readme)
for usage examples.

## License

Apache-2.0. Contains code derived from deepslate (MIT) — see `NOTICE`.
