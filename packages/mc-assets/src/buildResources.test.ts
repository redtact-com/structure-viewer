// buildResources がアトラスに渡すテクスチャ集合の検証。
// TextureAtlas.fromBlobs は canvas / ImageBitmap を要求するため node 環境では動かない。
// ここでは fromBlobs をスタブ化して「どのテクスチャがアトラスに載るか」だけを観測する。
import { beforeEach, describe, expect, it, vi } from "vitest";

const capturedBlobs: Array<Record<string, Blob>> = [];

vi.mock("deepslate/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("deepslate/render")>();
  return {
    ...actual,
    TextureAtlas: {
      async fromBlobs(blobs: Record<string, Blob>) {
        capturedBlobs.push({ ...blobs });
        return {
          getTextureAtlas: () => ({}) as ImageData,
          getTextureUV: () => [0, 0, 1, 1] as [number, number, number, number],
          getPixelSize: () => 1 / 16,
        };
      },
    },
  };
});

// waterlogged だけを持つ構造 (palette に minecraft:water が無い) を模したフィクスチャ
const statesJson: Record<string, unknown> = {
  oak_stairs: { variants: { "facing=east,half=bottom,shape=straight": { model: "block/oak_stairs" } } },
  soul_sand: { variants: { "": { model: "block/soul_sand" } } },
};
const modelsJson: Record<string, unknown> = {
  "block/oak_stairs": { parent: "block/stairs", textures: { texture: "block/oak_planks" } },
  "block/stairs": { textures: { particle: "#texture" } },
  "block/soul_sand": { parent: "block/cube_all", textures: { all: "block/soul_sand" } },
  "block/cube_all": { textures: { particle: "#all" } },
};

const requestedTextures: string[] = [];

vi.mock("./mcAssets", () => ({
  getBlockStates: async () => statesJson,
  getBlockModels: async () => modelsJson,
  fetchTexture: async (path: string) => {
    requestedTextures.push(path);
    return new Blob([new Uint8Array([0])], { type: "image/png" });
  },
}));

const { buildResources } = await import("./buildResources");

const FLUID_TEXTURES = [
  "block/water_still",
  "block/water_flow",
  "block/lava_still",
  "block/lava_flow",
];

beforeEach(() => {
  capturedBlobs.length = 0;
  requestedTextures.length = 0;
});

describe("buildResources — 流体テクスチャ", () => {
  it("water を含まない waterlogged 構造でもアトラスに流体テクスチャが載る", async () => {
    await buildResources(["minecraft:oak_stairs", "minecraft:soul_sand"]);

    for (const texture of FLUID_TEXTURES) {
      expect(requestedTextures).toContain(texture);
      expect(capturedBlobs[0]).toHaveProperty(`minecraft:${texture}`);
    }
  });
});

describe("buildResources — extraTextures", () => {
  it("モデルに現れないテクスチャを呼び出し側から追加できる", async () => {
    await buildResources(["minecraft:oak_stairs"], {
      extraTextures: ["block/custom_marker", "minecraft:entity/signs/oak"],
    });

    expect(requestedTextures).toContain("block/custom_marker");
    // minecraft: 接頭辞は正規化される
    expect(requestedTextures).toContain("entity/signs/oak");
    expect(capturedBlobs[0]).toHaveProperty("minecraft:block/custom_marker");
    expect(capturedBlobs[0]).toHaveProperty("minecraft:entity/signs/oak");
  });

  it("extraTextures 未指定でも従来通り動作する", async () => {
    await buildResources(["minecraft:oak_stairs"]);

    expect(requestedTextures).toContain("block/oak_planks");
    expect(requestedTextures).not.toContain("block/custom_marker");
  });
});
