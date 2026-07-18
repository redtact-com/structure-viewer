# @redtact/mc-assets

Self-hosted Minecraft asset pipeline for
[deepslate](https://github.com/misode/deepslate) viewers.

- `fetch-mc-assets` (CLI) — download blockstates/models
  (PrismarineJS/minecraft-assets, SHA-pinned) and textures (misode/mcmeta,
  version-tag-pinned) into your app's `public/mc-assets/<version>/` at build
  time, so the viewer has no runtime dependency on third-party origins
- `configureMcAssets({ baseUrl, revision })` — point the runtime at your asset
  origin (defaults to same-origin `/mc-assets`) and set the cache-bust
  revision. Each call replaces the entire config — pass all options in one
  call (omitted fields reset to defaults). `revision` is required when the
  assets are served with immutable/long-lived caching
- `getBlockStates` / `getBlockModels` / `fetchTexture` — asset fetching with
  request de-duplication and animation-frame cropping
- `buildResources(blockNames)` — build a complete deepslate `Resources`
  (definitions, models, texture atlas, block flags) for exactly the blocks in
  your structure

`deepslate` (`^0.25.1`) is a peer dependency. Node.js >= 20.19 (or >= 22.12 on
the 22.x line) is required for the CJS entry (`require(esm)` support).

```bash
npx -p @redtact/mc-assets fetch-mc-assets --emit-module src/mcAssetsRevision.ts
# → public/mc-assets/1.21.5/ + a revision constant module for your app
```

```ts
import { configureMcAssets, buildResources } from "@redtact/mc-assets";
import { MC_ASSETS_REVISION } from "./mcAssetsRevision"; // from --emit-module

// Replaces the entire config — pass all options in one call.
// `revision` is REQUIRED when serving the assets with immutable caching.
configureMcAssets({ revision: MC_ASSETS_REVISION });
const resources = await buildResources(blockNames);
```

## Bundle size: `@redtact/mc-assets/urls`

The main entry statically imports `deepslate/render` (for `buildResources`), and
deepslate does not declare `sideEffects: false`, so it cannot be tree-shaken
away. If a code path only needs configuration / URL resolution / asset
fetching, import the deepslate-free subpath:

```ts
import { textureUrl, configureMcAssets } from "@redtact/mc-assets/urls";
```

Measured with esbuild (`--bundle --minify`, entry importing only
`textureUrl` + `configureMcAssets`):

| Import source | Bundle (raw) | Bundle (gzip) | deepslate |
| --- | --- | --- | --- |
| `@redtact/mc-assets/urls` | 297 B | 241 B | not included |
| `@redtact/mc-assets` | 246 kB | 71.5 kB | included |

`/urls` exports `configureMcAssets`, `McAssetsOptions`, `mcAssetsBase`,
`textureUrl`, `MC_VERSION`, `getBlockStates`, `getBlockModels`, `fetchTexture`.
The main entry re-exports them, so configuration state is shared between the
two entries.

See the [repository README](https://github.com/redtact-com/structure-viewer#readme)
for full usage.

## License

Apache-2.0 — see `LICENSE` and `NOTICE`.
