# @redtact/deepslate-extras

Extras for [deepslate](https://github.com/misode/deepslate) structure viewers:

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

`deepslate` (`^0.25.1`) is a peer dependency.

See the [repository README](https://github.com/redtact-com/structure-viewer#readme)
for usage examples.

## License

Apache-2.0. Contains code derived from deepslate (MIT) — see `NOTICE`.
