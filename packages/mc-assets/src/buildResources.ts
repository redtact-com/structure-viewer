import {
  BlockDefinition,
  BlockModel,
  TextureAtlas,
  type Resources,
  type BlockModelProvider,
} from 'deepslate/render'
import { Identifier } from 'deepslate/core'
import { getBlockFlags, padTextureBlobs } from '@redtact/deepslate-extras'
import { getBlockStates, getBlockModels, fetchTexture } from './mcAssets'
import { collectTexturePaths, addSpecialRendererTextures } from './texturePaths'

const _loggedMissing = new Set<string>()

export interface BuildResourcesOptions {
  /**
   * モデル追跡では到達できないテクスチャを追加で読み込む。
   *
   * `"block/stone"` / `"entity/signs/oak"` のような、`minecraft:` 接頭辞を除いた
   * テクスチャパスで指定する (atlas キーは `minecraft:{path}` になる)。
   *
   * deepslate の SpecialRenderer 系のように、blockstate → model を経由せず
   * コード内でテクスチャ ID を組み立てる描画経路のために用意している。
   * 流体 (water/lava) の 4 枚は既定で常に含まれるため、ここで指定する必要は無い。
   */
  extraTextures?: string[]
}

export async function buildResources(
  blockNames: string[],
  options: BuildResourcesOptions = {},
): Promise<Resources> {
  console.log('[buildResources] Fetching block states & models...')

  const [statesJson, modelsJson] = await Promise.all([
    getBlockStates(),
    getBlockModels(),
  ])

  const blockDefs = new Map<string, BlockDefinition>()
  for (const fullName of blockNames) {
    const name = fullName.replace('minecraft:', '')
    if (statesJson[name]) {
      try {
        blockDefs.set(name, BlockDefinition.fromJson(statesJson[name]))
      } catch { /* skip */ }
    }
  }

  // cube_mirrored は面の UV が反転しているため正常化
  const patchedModelsJson = { ...modelsJson } as Record<string, unknown>
  const cubeMirroredRaw = patchedModelsJson['cube_mirrored'] as
    | { elements?: Array<{ faces?: Record<string, { uv?: number[] }> }> }
    | undefined
  if (cubeMirroredRaw?.elements) {
    const patched = JSON.parse(JSON.stringify(cubeMirroredRaw)) as typeof cubeMirroredRaw
    patched.elements?.forEach(elem => {
      Object.values(elem.faces ?? {}).forEach(face => {
        if (face.uv && face.uv[0] > face.uv[2]) {
          ;[face.uv[0], face.uv[2]] = [face.uv[2], face.uv[0]]
        }
      })
    })
    patchedModelsJson['cube_mirrored'] = patched
  }

  const blockModels = new Map<string, BlockModel>()
  for (const [key, data] of Object.entries(patchedModelsJson)) {
    try {
      blockModels.set(key, BlockModel.fromJson(data))
    } catch { /* skip */ }
  }

  const modelProvider: BlockModelProvider = {
    getBlockModel(id: Identifier) {
      const key = id.path.replace(/^block\//, '')
      return blockModels.get(key) ?? blockModels.get(id.path) ?? null
    },
  }
  for (const model of blockModels.values()) {
    try { model.flatten(modelProvider) } catch { /* skip */ }
  }

  const uniqueBlockNames = [...new Set(blockNames.map(n => n.replace('minecraft:', '')))]
  console.log('[buildResources] Unique blocks in structure:', uniqueBlockNames.sort())

  const texturePaths = collectTexturePaths(
    uniqueBlockNames.map(n => `minecraft:${n}`),
    statesJson,
    modelsJson,
  )
  addSpecialRendererTextures(texturePaths, uniqueBlockNames)

  for (const path of options.extraTextures ?? []) {
    const normalized = path.replace(/^minecraft:/, '')
    if (normalized) texturePaths.add(normalized)
  }

  console.log(`[buildResources] Fetching ${texturePaths.size} textures...`)

  const textureBlobs: Record<string, Blob> = {}
  await Promise.all(
    [...texturePaths].map(async (path) => {
      const blob = await fetchTexture(path)
      if (blob) textureBlobs[`minecraft:${path}`] = blob
    })
  )

  padTextureBlobs(textureBlobs)

  const actualN = Object.keys(textureBlobs).length
  console.log(
    `[buildResources] Ready: ${blockDefs.size} blockstates, ` +
    `${blockModels.size} models, ${actualN}/${texturePaths.size} textures`
  )

  const atlas = await TextureAtlas.fromBlobs(textureBlobs)

  return {
    getBlockDefinition(id: Identifier) {
      return blockDefs.get(id.path) ?? null
    },
    getBlockModel(id: Identifier) {
      const key = id.path.replace(/^block\//, '')
      return blockModels.get(key) ?? blockModels.get(id.path) ?? null
    },
    getTextureAtlas() {
      return atlas.getTextureAtlas()
    },
    getTextureUV(id: Identifier) {
      const uv = atlas.getTextureUV(id)
      if (!_loggedMissing.has(id.toString()) && uv[0] === 0 && uv[1] === 0) {
        _loggedMissing.add(id.toString())
        console.warn('[getTextureUV] fallback for:', id.toString())
      }
      return uv
    },
    getPixelSize() {
      return atlas.getPixelSize()
    },
    getBlockFlags(id: Identifier) {
      return getBlockFlags(id.path)
    },
    getBlockProperties: () => null,
    getDefaultBlockProperties: () => null,
  }
}
