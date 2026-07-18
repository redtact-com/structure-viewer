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

export async function buildResources(blockNames: string[]): Promise<Resources> {
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
