// 軽量サブパスエントリ (@redtact/mc-assets/urls)。
//
// deepslate に一切依存しない「設定 + URL 解決 + アセット取得」だけを公開する。
// メインエントリ (@redtact/mc-assets) は buildResources 経由で deepslate/render を
// 静的 import するため、textureUrl だけを使いたい呼び出し側 (材料一覧 UI など)
// からメインエントリを import すると deepslate 一式が同じチャンクに巻き込まれる
// (deepslate は sideEffects: false を宣言していないため tree shaking で落ちない)。
// そうした経路ではこのサブパスを使うこと。
//
// メインエントリはこのモジュールを re-export するので実装は一箇所のまま。

export {
  MC_VERSION,
  configureMcAssets,
  fetchTexture,
  getBlockModels,
  getBlockStates,
  mcAssetsBase,
  textureUrl,
  type McAssetsOptions,
} from "./mcAssets";
