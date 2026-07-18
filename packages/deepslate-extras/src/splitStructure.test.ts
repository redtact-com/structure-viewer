// splitStructure 系は「元サイズ維持で座標をずらさない」不変条件の上に
// フォーカス/クロップ/スライスの全描画が乗っている。将来のコピーレス化
// (StructureProvider フィルタビュー) の出力等価検証の基準にもなる。
import { describe, expect, it } from "vitest";
import { Structure } from "deepslate/core";

import {
  filterStructureByY,
  normalizeBlockId,
  normalizeRegion,
  splitStructure,
  splitStructureCropped,
  structureInternals,
} from "./splitStructure";

const SIZE: [number, number, number] = [3, 4, 3];

/** テスト用構造体: stone を全底面 (y=0)、piston を (1,1,1)、lever を (2,3,2) に置く */
function buildStructure(withNbt = false): Structure {
  const s = new Structure(SIZE);
  for (let x = 0; x < 3; x++) {
    for (let z = 0; z < 3; z++) s.addBlock([x, 0, z], "minecraft:stone");
  }
  s.addBlock([1, 1, 1], "minecraft:piston", { facing: "up" });
  s.addBlock(
    [2, 3, 2],
    "minecraft:lever",
    { face: "wall" },
    withNbt ? ({ dummy: true } as unknown as undefined) : undefined,
  );
  return s;
}

const names = (st: Structure) => st.getBlocks().map((b) => b.state.getName().toString());
const posKeys = (st: Structure) => st.getBlocks().map((b) => b.pos.join(","));

describe("normalizeBlockId", () => {
  it("namespace を補完し、既にあればそのまま", () => {
    expect(normalizeBlockId("piston")).toBe("minecraft:piston");
    expect(normalizeBlockId("minecraft:piston")).toBe("minecraft:piston");
    expect(normalizeBlockId("mod:thing")).toBe("mod:thing");
  });
});

describe("normalizeRegion", () => {
  it("start/end の大小を正規化する", () => {
    const { min, max } = normalizeRegion({ start: [2, 3, 2], end: [0, 1, 0] }, SIZE);
    expect(min).toEqual([0, 1, 0]);
    expect(max).toEqual([2, 3, 2]);
  });

  it("サイズ外の座標をクランプする", () => {
    const { min, max } = normalizeRegion({ start: [-5, -5, -5], end: [99, 99, 99] }, SIZE);
    expect(min).toEqual([0, 0, 0]);
    expect(max).toEqual([2, 3, 2]);
  });
});

describe("splitStructure", () => {
  it("inner/outer とも元サイズを維持する (座標をずらさない不変条件)", () => {
    const { inner, outer } = splitStructure(buildStructure(), [
      { region: { start: [0, 0, 0], end: [2, 0, 2] }, materials: null },
    ]);
    expect(inner.getSize()).toEqual(SIZE);
    expect(outer.getSize()).toEqual(SIZE);
  });

  it("region で分割し、全ブロックが inner/outer のどちらかに入る", () => {
    const full = buildStructure();
    const { inner, outer } = splitStructure(full, [
      { region: { start: [0, 0, 0], end: [2, 0, 2] }, materials: null },
    ]);
    expect(inner.getBlocks()).toHaveLength(9); // 底面 stone
    expect(outer.getBlocks()).toHaveLength(2); // piston + lever
    expect(inner.getBlocks().length + outer.getBlocks().length).toBe(full.getBlocks().length);
  });

  it("region と materials は AND (namespace 補完込み)", () => {
    const { inner } = splitStructure(buildStructure(), [
      { region: { start: [0, 0, 0], end: [2, 3, 2] }, materials: ["piston"] },
    ]);
    expect(names(inner)).toEqual(["minecraft:piston"]);
  });

  it("複数 spec は OR", () => {
    const { inner } = splitStructure(buildStructure(), [
      { region: null, materials: ["piston"] },
      { region: null, materials: ["lever"] },
    ]);
    expect(names(inner).sort()).toEqual(["minecraft:lever", "minecraft:piston"]);
  });

  it("positions は region/materials より優先", () => {
    const { inner } = splitStructure(buildStructure(), [
      {
        region: { start: [0, 0, 0], end: [2, 3, 2] }, // 全域
        materials: ["stone"], // 無視されるはず
        positions: ["1,1,1"],
      },
    ]);
    expect(posKeys(inner)).toEqual(["1,1,1"]);
  });

  it("block.nbt を素通しする (看板等の SpecialRenderer が参照する)", () => {
    const { inner } = splitStructure(buildStructure(true), [{ region: null, materials: ["lever"] }]);
    const lever = inner.getBlocks()[0];
    expect(lever.nbt).toEqual({ dummy: true });
  });

  it("空 specs では全ブロックが outer に落ちる", () => {
    const full = buildStructure();
    const { inner, outer } = splitStructure(full, []);
    expect(inner.getBlocks()).toHaveLength(0);
    expect(outer.getBlocks()).toHaveLength(full.getBlocks().length);
  });

  it("state のプロパティを保持し getBlock でも引ける (palette index 参照の整合)", () => {
    const { inner } = splitStructure(buildStructure(), [{ region: null, materials: ["piston"] }]);
    expect(inner.getBlocks()[0].state.getProperties()).toEqual({ facing: "up" });
    expect(inner.getBlock([1, 1, 1])?.state.getName().toString()).toBe("minecraft:piston");
    expect(inner.getBlock([0, 0, 0])).toBeNull(); // outer 側のブロックは引けない
  });
});

// palette は分割時に共有 (コピーレス) するため、後から派生/元のどちらへ addBlock
// しても互いの palette に波及しないことを担保する。
describe("palette の分離 (mutation 非波及)", () => {
  it("派生へ addBlock しても元 Structure に波及しない", () => {
    const full = buildStructure();
    const paletteBefore = structureInternals(full).palette.length;
    const blocksBefore = full.getBlocks().length;
    const { inner, outer } = splitStructure(full, [{ region: null, materials: ["piston"] }]);
    inner.addBlock([0, 2, 0], "minecraft:observer");
    outer.addBlock([1, 2, 0], "minecraft:target");
    expect(structureInternals(full).palette).toHaveLength(paletteBefore);
    expect(full.getBlocks()).toHaveLength(blocksBefore);
  });

  it("元へ addBlock しても派生 Structure に波及しない", () => {
    const full = buildStructure();
    const { inner } = splitStructure(full, [{ region: null, materials: ["piston"] }]);
    const paletteBefore = structureInternals(inner).palette.length;
    full.addBlock([0, 2, 0], "minecraft:observer");
    expect(structureInternals(inner).palette).toHaveLength(paletteBefore);
    expect(names(inner)).toEqual(["minecraft:piston"]);
  });

  it("filterStructureByY / splitStructureCropped の派生も分離される", () => {
    const full = buildStructure();
    const sliced = filterStructureByY(full, 1, 1);
    const { inner, faded } = splitStructureCropped(full, {
      region: { start: [0, 0, 0], end: [2, 3, 2] },
      materials: ["piston"],
    });
    const before = structureInternals(full).palette.length;
    sliced.addBlock([0, 2, 0], "minecraft:observer");
    expect(structureInternals(full).palette).toHaveLength(before);
    inner.addBlock([1, 2, 0], "minecraft:target");
    expect(structureInternals(full).palette).toHaveLength(before);
    faded.addBlock([2, 2, 0], "minecraft:tnt");
    expect(structureInternals(full).palette).toHaveLength(before);
    expect(names(full)).not.toContain("minecraft:observer");
    expect(names(full)).not.toContain("minecraft:target");
    expect(names(full)).not.toContain("minecraft:tnt");
  });
});

describe("splitStructureCropped", () => {
  it("範囲外は捨て、範囲内を materials で inner/faded に分ける", () => {
    const { inner, faded } = splitStructureCropped(buildStructure(), {
      region: { start: [0, 0, 0], end: [2, 1, 2] }, // lever(y=3) は範囲外
      materials: ["piston"],
    });
    expect(names(inner)).toEqual(["minecraft:piston"]);
    expect(faded.getBlocks()).toHaveLength(9); // stone は faded
    expect(inner.getSize()).toEqual(SIZE);
    expect(faded.getSize()).toEqual(SIZE);
  });

  it("positions 指定時はピック座標だけが inner (materials 無視)", () => {
    const { inner, faded } = splitStructureCropped(buildStructure(), {
      region: { start: [0, 0, 0], end: [2, 3, 2] },
      materials: ["stone"],
      positions: ["1,1,1"],
    });
    expect(posKeys(inner)).toEqual(["1,1,1"]);
    expect(faded.getBlocks()).toHaveLength(10); // stone 9 + lever
  });
});

describe("filterStructureByY", () => {
  it("全範囲なら同一オブジェクトを返す (再メッシュ回避の最適化)", () => {
    const full = buildStructure();
    expect(filterStructureByY(full, 0, SIZE[1] - 1)).toBe(full);
    expect(filterStructureByY(full, -1, 99)).toBe(full);
  });

  it("Y 範囲で絞り込み、サイズは維持する", () => {
    const sliced = filterStructureByY(buildStructure(), 1, 1);
    expect(posKeys(sliced)).toEqual(["1,1,1"]);
    expect(sliced.getSize()).toEqual(SIZE);
  });
});
