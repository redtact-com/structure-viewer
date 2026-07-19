---
"@redtact/mc-assets": minor
---

Always include the fluid textures, and add `buildResources(blockNames, { extraTextures })`

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
