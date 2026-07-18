# @redtact/mc-assets

Self-hosted Minecraft asset pipeline for
[deepslate](https://github.com/misode/deepslate) viewers.

- `fetch-mc-assets` (CLI) — download blockstates/models
  (PrismarineJS/minecraft-assets, SHA-pinned) and textures (misode/mcmeta,
  version-tag-pinned) into your app's `public/mc-assets/<version>/` at build
  time, so the viewer has no runtime dependency on third-party origins
- `configureMcAssets({ baseUrl, revision })` — point the runtime at your asset
  origin (defaults to same-origin `/mc-assets`) and set the cache-bust revision
- `getBlockStates` / `getBlockModels` / `fetchTexture` — asset fetching with
  request de-duplication and animation-frame cropping
- `buildResources(blockNames)` — build a complete deepslate `Resources`
  (definitions, models, texture atlas, block flags) for exactly the blocks in
  your structure

`deepslate` (`^0.25.1`) is a peer dependency.

```bash
npx fetch-mc-assets              # → public/mc-assets/1.21.5/
```

```ts
import { configureMcAssets, buildResources } from "@redtact/mc-assets";

configureMcAssets({ revision: "3b7b880" }); // optional; from revision.json
const resources = await buildResources(blockNames);
```

See the [repository README](https://github.com/redtact-com/structure-viewer#readme)
for full usage.

## License

Apache-2.0 — see `LICENSE` and `NOTICE`.
