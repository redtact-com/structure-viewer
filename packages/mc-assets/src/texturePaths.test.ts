// deepslate の liquidRenderer は `block/{water,lava}_{still,flow}` という
// テクスチャ ID をコード内で組み立てるため、blockstate → model → parent の
// モデル追跡では到達できない。かつ waterlogged 判定でも呼ばれるので、
// palette に water/lava が無い構造でも必ずテクスチャが要求されることを固定する。
import { describe, expect, it } from "vitest";

import { addSpecialRendererTextures, collectTexturePaths } from "./texturePaths";

const FLUID_TEXTURES = [
  "block/water_still",
  "block/water_flow",
  "block/lava_still",
  "block/lava_flow",
];

describe("addSpecialRendererTextures — 流体テクスチャ", () => {
  it("water/lava を含まない blockNames でも 4 枚の流体テクスチャを追加する", () => {
    const paths = new Set<string>();
    addSpecialRendererTextures(paths, ["stone", "oak_stairs", "bubble_column", "soul_sand"]);

    for (const texture of FLUID_TEXTURES) {
      expect(paths.has(texture)).toBe(true);
    }
  });

  it("空の構造でも流体テクスチャを追加する", () => {
    const paths = new Set<string>();
    addSpecialRendererTextures(paths, []);

    expect([...paths].sort()).toEqual([...FLUID_TEXTURES].sort());
  });

  it("water/lava を含む従来のケースでも引き続き追加される", () => {
    const paths = new Set<string>();
    addSpecialRendererTextures(paths, ["water", "lava"]);

    for (const texture of FLUID_TEXTURES) {
      expect(paths.has(texture)).toBe(true);
    }
  });

  it("既存の条件付き追加 (repeater / 看板) は blockNames 依存のまま", () => {
    const withoutRepeater = new Set<string>();
    addSpecialRendererTextures(withoutRepeater, ["stone"]);
    expect(withoutRepeater.has("block/repeater")).toBe(false);
    expect(withoutRepeater.has("entity/signs/oak")).toBe(false);

    const withRepeater = new Set<string>();
    addSpecialRendererTextures(withRepeater, ["repeater", "oak_sign"]);
    expect(withRepeater.has("block/repeater")).toBe(true);
    expect(withRepeater.has("entity/signs/oak")).toBe(true);
  });
});

describe("collectTexturePaths — モデル追跡では流体に到達できないことの回帰固定", () => {
  // waterlogged だけを持つ構造 (palette に minecraft:water が無い) を模したフィクスチャ。
  // モデル追跡だけでは水テクスチャが 1 枚も集まらないことを示す。
  const statesJson = {
    oak_stairs: { variants: { "facing=east,half=bottom,shape=straight": { model: "block/oak_stairs" } } },
    soul_sand: { variants: { "": { model: "block/soul_sand" } } },
  };
  const modelsJson = {
    "block/oak_stairs": { parent: "block/stairs", textures: { texture: "block/oak_planks" } },
    "block/stairs": { textures: { particle: "#texture" } },
    "block/soul_sand": { parent: "block/cube_all", textures: { all: "block/soul_sand" } },
    "block/cube_all": { textures: { particle: "#all" } },
  };

  it("waterlogged 可能ブロックのモデル追跡では流体テクスチャが集まらない", () => {
    const paths = collectTexturePaths(
      ["minecraft:oak_stairs", "minecraft:soul_sand"],
      statesJson,
      modelsJson,
    );

    for (const texture of FLUID_TEXTURES) {
      expect(paths.has(texture)).toBe(false);
    }
  });

  it("addSpecialRendererTextures を通すと流体テクスチャが補完される", () => {
    const paths = collectTexturePaths(
      ["minecraft:oak_stairs", "minecraft:soul_sand"],
      statesJson,
      modelsJson,
    );
    addSpecialRendererTextures(paths, ["oak_stairs", "soul_sand"]);

    for (const texture of FLUID_TEXTURES) {
      expect(paths.has(texture)).toBe(true);
    }
    // 元々集まっていたテクスチャは失われない
    expect(paths.has("block/oak_planks")).toBe(true);
    expect(paths.has("block/soul_sand")).toBe(true);
  });
});
