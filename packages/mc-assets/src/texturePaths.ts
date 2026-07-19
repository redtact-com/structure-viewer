/** blockstate JSON の中から参照されているモデル名を再帰収集する */
function collectModelRefsFromState(obj: unknown, result: Set<string>): void {
  if (!obj || typeof obj !== 'object') return
  if (Array.isArray(obj)) { obj.forEach(o => collectModelRefsFromState(o, result)); return }
  const o = obj as Record<string, unknown>
  if (typeof o['model'] === 'string') {
    // "minecraft:block/stone" → "block/stone"
    result.add((o['model'] as string).replace('minecraft:', ''))
  }
  for (const v of Object.values(o)) collectModelRefsFromState(v, result)
}

/**
 * 構造体に含まれるブロックが実際に使うモデルのテクスチャパスのみ収集する。
 * blockstate → model → parent と連鎖を辿って必要なテクスチャだけ返す。
 *
 * 戻り値: "block/stone", "entity/signs/oak" などのパス文字列の Set
 * fetch URL: mcAssets.textureUrl(path) — 既定は自己ホスト /mc-assets/<version>/textures/{path}.png
 * atlas キー: `minecraft:{path}`
 */
export function collectTexturePaths(
  blockNames: string[],
  statesJson: Record<string, unknown>,
  modelsJson: Record<string, unknown>,
): Set<string> {
  const paths = new Set<string>()

  // Step 1: blockstate から参照されているモデル名を収集
  // repeater の locked バリアント（bedrock テクスチャを含む）は実際のゲームプレイで
  // ほぼ出現しないため除外し、アトラスの UV bleeding を抑制する
  const filterBlockState = (name: string, state: unknown): unknown => {
    if (name !== 'repeater') return state
    const s = state as { variants?: Record<string, unknown> }
    if (!s?.variants) return state
    const newVariants: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(s.variants)) {
      if (!k.includes('locked=true')) newVariants[k] = v
    }
    return { ...s, variants: newVariants }
  }

  const initialRefs = new Set<string>()
  for (const fullName of blockNames) {
    const name = fullName.replace('minecraft:', '')
    if (statesJson[name]) {
      collectModelRefsFromState(filterBlockState(name, statesJson[name]), initialRefs)
    }
  }

  // Step 2: モデルと親チェーンを追跡してテクスチャを収集
  // PrismarineJS のキーは "stone"（block/ 無し）か "block/stone" のどちらかを試す
  const resolveKey = (ref: string): string | null => {
    if (modelsJson[ref] !== undefined) return ref
    const stripped = ref.replace(/^block\//, '')
    if (modelsJson[stripped] !== undefined) return stripped
    return null
  }

  const visited = new Set<string>()
  const queue = [...initialRefs]

  while (queue.length > 0) {
    const ref = queue.shift()!
    const key = resolveKey(ref)
    if (!key || visited.has(key)) continue
    visited.add(key)

    const model = modelsJson[key] as Record<string, unknown>

    if (model['textures'] && typeof model['textures'] === 'object') {
      for (const v of Object.values(model['textures'] as Record<string, string>)) {
        const raw = String(v)
        if (raw.startsWith('#')) continue
        const path = raw.startsWith('minecraft:') ? raw.slice('minecraft:'.length) : raw
        if (path.startsWith('block/') || path.startsWith('entity/')) {
          paths.add(path)
        }
      }
    }

    // 親モデルも追跡
    if (typeof model['parent'] === 'string') {
      queue.push((model['parent'] as string).replace('minecraft:', ''))
    }
  }

  return paths
}

/**
 * deepslate の liquidRenderer が動的に組み立てるテクスチャ ID。
 *
 * liquidRenderer は `block/{water,lava}_{still,flow}` という ID を
 * コード内で直接組み立てて BlockModel を生成するため、blockstate → model →
 * parent のモデル追跡 (collectTexturePaths) では原理的に到達できない:
 *
 * - `*_flow` は PrismarineJS の blocks.json のどのモデルにも登場しない (参照 0 件)
 * - `water_still` は `water` モデルの `particle` にしか現れないため、
 *   palette に `minecraft:water` が無いと収集されない
 *
 * さらに liquidRenderer は `block.isWaterlogged()` でも呼ばれる。waterlogged は
 * 任意のブロック (階段・ハーフ・フェンス・bubble_column 等) で立ちうるので、
 * 「palette に water があるか」という条件判定では取りこぼす。4 枚で数 KB の
 * コストしか無いため、条件を付けず常に含める方が堅い。
 */
const LIQUID_RENDERER_TEXTURES = [
  'block/water_still',
  'block/water_flow',
  'block/lava_still',
  'block/lava_flow',
] as const

/**
 * deepslate の SpecialRenderer が PrismarineJS モデルとは独立して直接参照するテクスチャを追加する。
 * 構造体に存在するブロック種類に応じて必要な分だけ追加する。
 * ただし流体テクスチャだけは、waterlogged が任意のブロックで起きうるため無条件に追加する。
 */
export function addSpecialRendererTextures(
  texturePaths: Set<string>,
  uniqueBlockNames: string[],
): void {
  // 水・溶岩: liquidRenderer が block/{type}_still / block/{type}_flow を参照。
  // waterlogged 経由でも呼ばれるため、palette に water/lava が無くても常に追加する。
  for (const path of LIQUID_RENDERER_TEXTURES) {
    texturePaths.add(path)
  }

  // リピーター: collectTexturePaths で収集されるが、念のため明示的に追加する
  // repeater_Xtick モデルのテクスチャが抜け落ちた場合でもリピーター上面が紫黒にならないよう保険をかける
  if (uniqueBlockNames.some(n => n === 'repeater')) {
    texturePaths.add('block/smooth_stone')
    texturePaths.add('block/repeater')
    texturePaths.add('block/repeater_on')
    texturePaths.add('block/redstone_torch')
    texturePaths.add('block/redstone_torch_off')
  }

  // コンパレーター
  if (uniqueBlockNames.some(n => n === 'comparator')) {
    texturePaths.add('block/smooth_stone')
    texturePaths.add('block/comparator')
    texturePaths.add('block/comparator_on')
    texturePaths.add('block/redstone_torch')
    texturePaths.add('block/redstone_torch_off')
  }

  // 看板: signRenderer が entity/signs/{type}、
  // ハンギング看板: hangingSignRenderer が entity/signs/hanging/{type} を参照
  // deepslate 0.25.x の WoodTypes に含まれる種類のみ対象
  const SIGN_WOOD_TYPES = [
    'oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak',
    'mangrove', 'cherry', 'bamboo', 'crimson', 'warped',
  ]
  for (const type of SIGN_WOOD_TYPES) {
    const hasSign = uniqueBlockNames.some(n =>
      n === `${type}_sign` || n === `${type}_wall_sign` ||
      n === `${type}_hanging_sign` || n === `${type}_wall_hanging_sign`
    )
    if (hasSign) {
      texturePaths.add(`entity/signs/${type}`)
      texturePaths.add(`entity/signs/hanging/${type}`)
    }
  }
}
