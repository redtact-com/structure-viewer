// メインエントリ。deepslate 依存 (buildResources) を含む全 API を公開する。
//
// 注意: このエントリを import すると deepslate/render が静的に引き込まれる。
// 設定・URL 解決・アセット取得だけが必要な経路では、deepslate を含まない
// サブパス "@redtact/mc-assets/urls" を使うとバンドルが小さく保てる。

// 実装の二重化を避けるため軽量サブパス側を re-export する
export {
  MC_VERSION,
  configureMcAssets,
  fetchTexture,
  getBlockModels,
  getBlockStates,
  mcAssetsBase,
  textureUrl,
  type McAssetsOptions,
} from "./urls";
export { buildResources } from "./buildResources";
export { addSpecialRendererTextures, collectTexturePaths } from "./texturePaths";
