// Minecraft アセット (blockstates/models/テクスチャ) の取得。
//
// 既定は自己ホスト: 同梱 CLI (fetch-mc-assets) がアプリの public/ 配下に配置した
// アセットを同一オリジンの相対パス /mc-assets/<version>/ から取得する。
// raw.githubusercontent.com への実行時依存を排除し、GitHub 障害・レイテンシの影響を受けない。
//
// 取得元の切替:
//   1. configureMcAssets({ baseUrl, revision }) — バージョンディレクトリの親 URL と
//      キャッシュバスト用リビジョンをアプリ初期化時に設定
//      (例: baseUrl "https://cdn.example.com/mc-assets" → <baseUrl>/1.21.5/blocks.json)
//   2. 各関数の baseUrl 引数 — 呼び出し単位の明示的な上書き
//
// アセット構成 (バージョン付きパスなので immutable キャッシュ可):
//   <base>/<version>/blocks.json          … blockstates + models のマージ JSON { states, models }
//   <base>/<version>/textures/{path}.png  … block/ item/ entity/ テクスチャ

export const MC_VERSION = '1.21.5'

const DEFAULT_BASE = '/mc-assets'

export interface McAssetsOptions {
  /**
   * バージョンディレクトリの親 URL (例: "https://cdn.example.com/mc-assets")。
   * 末尾スラッシュは正規化される。未指定・空文字は既定の相対 "/mc-assets"。
   */
  baseUrl?: string
  /**
   * URL に ?v= として付与するキャッシュバスト用リビジョン。
   * 同一 MC バージョンのままアセット pin を更新したときに immutable キャッシュを
   * バストするためのもの (fetch-mc-assets が出力する revision.json の値)。
   * 未指定ならクエリを付けない。
   */
  revision?: string
}

let baseRoot = DEFAULT_BASE
let revision: string | undefined

/**
 * アセット取得のグローバル設定。アプリ初期化時 (fetch を伴う関数の呼び出し前) に呼ぶ。
 * 毎回設定全体を置き換える: 省略したフィールドは既定値に戻る
 * (`configureMcAssets()` で全既定値にリセット)。
 */
export function configureMcAssets(options: McAssetsOptions = {}): void {
  const cleaned = options.baseUrl?.trim().replace(/\/+$/, '')
  baseRoot = cleaned || DEFAULT_BASE
  revision = options.revision
}

function revQuery(): string {
  return revision ? `?v=${revision}` : ''
}

/** アセットのベース URL (バージョンディレクトリまで) を解決する */
export function mcAssetsBase(version: string = MC_VERSION): string {
  return `${baseRoot}/${version}`
}

/** テクスチャ 1 枚の URL ("block/stone" → "<base>/textures/block/stone.png") */
export function textureUrl(path: string, baseUrl: string = mcAssetsBase()): string {
  return `${baseUrl}/textures/${path}.png${revQuery()}`
}

interface BlocksJson {
  states: Record<string, unknown>
  models: Record<string, unknown>
}

// blocks.json キャッシュ (base URL 単位)。Promise をキャッシュすることで
// getBlockStates / getBlockModels の並行呼び出しでも fetch は 1 回に重複排除される。
const blocksJsonCache = new Map<string, Promise<BlocksJson>>()

function getBlocksJson(baseUrl: string): Promise<BlocksJson> {
  let promise = blocksJsonCache.get(baseUrl)
  if (!promise) {
    promise = fetch(`${baseUrl}/blocks.json${revQuery()}`).then(res => {
      if (!res.ok) throw new Error(`Failed to fetch blocks.json: ${res.status}`)
      return res.json() as Promise<BlocksJson>
    })
    // 失敗した Promise はキャッシュから外し、次回呼び出しで再試行できるようにする
    promise.catch(() => { blocksJsonCache.delete(baseUrl) })
    blocksJsonCache.set(baseUrl, promise)
  }
  return promise
}

export async function getBlockStates(baseUrl: string = mcAssetsBase()): Promise<Record<string, unknown>> {
  return (await getBlocksJson(baseUrl)).states
}

export async function getBlockModels(baseUrl: string = mcAssetsBase()): Promise<Record<string, unknown>> {
  return (await getBlocksJson(baseUrl)).models
}

/**
 * アニメーションテクスチャ（縦長 PNG）を先頭フレームだけに切り出す。
 * TextureAtlas.fromBlobs 内でも 16×16 クロップは行われるが、
 * Blob サイズを事前に削減しておくことで atlas 構築を高速化する。
 */
async function cropFirstFrame(blob: Blob): Promise<Blob> {
  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)
    img.onload = () => {
      URL.revokeObjectURL(url)
      if (img.height > img.width) {
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.width
        canvas.getContext('2d')!.drawImage(img, 0, 0)
        canvas.toBlob((b) => resolve(b ?? blob), 'image/png')
      } else {
        resolve(blob)
      }
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(blob) }
    img.src = url
  })
}

/**
 * entity テクスチャ（看板・シュルカーなど）を 16×16 にスケールする。
 * deepslate の TextureAtlas は各テクスチャを 16×16 セルに格納し、
 * SpecialRenderer の UV 座標はそのセル内の pixel 座標として定義されている。
 * entity/signs/oak は 64×32 等のスプライトシートのため、
 * 全体を 16×16 に縮小して atlas に渡す必要がある。
 */
async function scaleToAtlasSize(blob: Blob): Promise<Blob> {
  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)
    img.onload = () => {
      URL.revokeObjectURL(url)
      if (img.width === 16 && img.height === 16) {
        resolve(blob)
        return
      }
      const canvas = document.createElement('canvas')
      canvas.width = 16
      canvas.height = 16
      canvas.getContext('2d')!.drawImage(img, 0, 0, 16, 16)
      canvas.toBlob((b) => resolve(b ?? blob), 'image/png')
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(blob) }
    img.src = url
  })
}

/**
 * テクスチャパスから Blob を取得する。取得できなかった場合は null を返す。
 * 自己ホストのテクスチャツリーは mcmeta (Java Edition アセットと完全一致) 由来の
 * block/ item/ 全量 + entity/ サブセットなので、存在しないパスへの
 * 外部フォールバックは行わない (どこにも無い)。
 */
export async function fetchTexture(path: string, baseUrl: string = mcAssetsBase()): Promise<Blob | null> {
  const res = await fetch(textureUrl(path, baseUrl))
  if (!res.ok) return null
  const framed = await cropFirstFrame(await res.blob())
  // entity テクスチャ（看板・シュルカー等のスプライトシート）は 16×16 にスケールする
  if (path.startsWith('entity/')) {
    return scaleToAtlasSize(framed)
  }
  return framed
}
