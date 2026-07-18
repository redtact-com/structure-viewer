---
"@redtact/mc-assets": minor
---

deepslate 非依存のサブパスエントリ `@redtact/mc-assets/urls` を追加

メインエントリは `buildResources` のために `deepslate/render` を静的 import しており、
deepslate が `sideEffects: false` を宣言していないため、`textureUrl` だけを import した
呼び出し側でも deepslate 一式 (+gl-matrix/pako/md5) がバンドルに巻き込まれていた。

設定・URL 解決・アセット取得 (`configureMcAssets` / `McAssetsOptions` / `mcAssetsBase` /
`textureUrl` / `MC_VERSION` / `getBlockStates` / `getBlockModels` / `fetchTexture`) だけを
公開する deepslate 非依存のサブパスを追加した。メインエントリはこのサブパスを
re-export するため実装・設定状態は共有されたまま。

実測 (esbuild --bundle --minify、`textureUrl` + `configureMcAssets` のみの entry):

| import 元 | raw | gzip | deepslate |
| --- | --- | --- | --- |
| `@redtact/mc-assets/urls` | 297 B | 241 B | 含まれない |
| `@redtact/mc-assets` | 246 kB | 71.5 kB | 含まれる |
