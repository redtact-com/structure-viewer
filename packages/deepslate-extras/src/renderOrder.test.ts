// 【M1 回帰】チャンク内 quad の**描画順**が全再構築と部分更新で一致することの検証。
//
// なぜ順序が正しさの問題なのか:
// deepslate の Renderer は BLEND を有効にしたまま描画し、FadeStructureRenderer は
// さらに depthMask(false) で描く。over 合成は非可換なので、チャンク内の quad の
// 並びが変わると**最終ピクセルが変わる** (実 WebGL で半透明 2 枚の重なりが
// 102 → 153 になることを確認済み)。
//
// 0.2.0 は 2 つの経路で順序が食い違っていた:
//   全再構築 (素の deepslate)  … blocks 配列順
//   部分更新 (patch (e))       … 座標昇順
// さらに swap-remove が blocks 配列順そのものを壊すため、ピックのたびに
// 「素の順」と「座標昇順」が交互に現れてちらついていた。
//
// 0.3.0 の方針: **両経路を平坦化 index 昇順に統一する**。
//   - splitStructure / splitStructureCropped / filterStructureByY の出力を正規化
//   - removeStoredBlock / addStoredBlock を順序保存 (二分探索 + splice) に変更
// patch (e) の走査順は x→y→z = 平坦化 index 昇順なので、正規化済みなら一致する。
//
// このファイルの比較は必ず ordered=true (並び順込み) で行う。
// ordered=false の集合比較では順序差が構造的にマスクされる。
import { describe, expect, it } from "vitest";
import { Structure } from "deepslate/core";
import { ChunkBuilder } from "deepslate/render";
import type { vec3 } from "gl-matrix";

import { applyDeepslatePatches } from "./deepslatePatches";
import {
  addStoredBlock,
  dirtyChunksFor,
  removeStoredBlock,
  sortStructureBlocks,
  splitStructure,
  storedBlockAt,
  structureBlocksSorted,
  structureInternals,
  type SelectionSpec,
} from "./splitStructure";
import {
  buildFixtureStructure,
  chunkQuadSets,
  createMockGl,
  createMockResources,
  diffChunkQuadSets,
} from "./testFixtures";

applyDeepslatePatches({ releaseQuadsAfterUpload: false, fastPartialChunkUpdate: true });

const SIZE = 16;
const CHUNK_SIZE = 8;
const CS: [number, number, number] = [CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE];
const STRUCTURE_SIZE: [number, number, number] = [SIZE, SIZE, SIZE];
const resources = createMockResources();

/** x < SIZE/2 を inner にする (outer 側にもブロックが残るようにする) */
const SPEC: SelectionSpec = {
  region: { start: [0, 0, 0], end: [SIZE / 2 - 1, SIZE - 1, SIZE - 1] },
  materials: null,
};

/** 半透明 (glassy) だけの構造体。fade / transparentMesh の順序依存が最も出る条件 */
function buildGlassStructure(order: Parameters<typeof buildFixtureStructure>[3]) {
  return buildFixtureStructure(SIZE, 0.5, 7, order, ["minecraft:glassy"]);
}

function build(structure: Structure) {
  const { gl, buffers } = createMockGl();
  return { structure, cb: new ChunkBuilder(gl, structure, resources, CHUNK_SIZE), buffers };
}

const ordered = (b: ReturnType<typeof build>) => chunkQuadSets(b.cb, b.buffers, true);

describe("チャンク内 quad の描画順", () => {
  it("fixture: 非昇順の構造体を作れている (テスト自体の健全性)", () => {
    expect(structureBlocksSorted(buildGlassStructure("ascending"))).toBe(true);
    expect(structureBlocksSorted(buildGlassStructure("zyx"))).toBe(false);
    expect(structureBlocksSorted(buildGlassStructure("reversed"))).toBe(false);
  });

  it("sortStructureBlocks は非昇順を昇順にし、昇順ならソートしない", () => {
    const unsorted = buildGlassStructure("zyx");
    expect(sortStructureBlocks(unsorted)).toBe(true);
    expect(structureBlocksSorted(unsorted)).toBe(true);
    // 2 回目は何もしない
    expect(sortStructureBlocks(unsorted)).toBe(false);
    // 中身は失われていない
    expect(unsorted.getBlocks().length).toBe(buildGlassStructure("zyx").getBlocks().length);
  });

  it("splitStructure の出力は入力が非昇順でも平坦化 index 昇順に正規化される", () => {
    for (const order of ["ascending", "zyx", "reversed"] as const) {
      const { inner, outer } = splitStructure(buildGlassStructure(order), [SPEC]);
      expect(structureBlocksSorted(inner), order).toBe(true);
      expect(structureBlocksSorted(outer), order).toBe(true);
    }
  });

  it("removeStoredBlock / addStoredBlock は昇順を保つ (swap-remove しない)", () => {
    const s = buildGlassStructure("ascending");
    const { blocks } = structureInternals(s);
    const before = blocks.map((b) => b.pos.join(","));

    const target = blocks[Math.floor(blocks.length / 2)].pos;
    const removed = removeStoredBlock(s, [...target] as [number, number, number])!;
    expect(structureBlocksSorted(s)).toBe(true);
    // 残りの相対順序が保たれている (swap-remove なら末尾要素が中央に来る)
    expect(structureInternals(s).blocks.map((b) => b.pos.join(","))).toEqual(
      before.filter((k) => k !== target.join(",")),
    );

    addStoredBlock(s, removed);
    expect(structureBlocksSorted(s)).toBe(true);
    expect(structureInternals(s).blocks.map((b) => b.pos.join(","))).toEqual(before);
  });

  // ── 本題: 2 経路の描画順が一致するか ──

  it("【M1】正規化済み構造体では部分更新と素の deepslate の quad 並びが完全一致する", () => {
    const original = ChunkBuilderOriginal();
    const fast = build(splitStructure(buildGlassStructure("zyx"), [SPEC]).outer);
    const reference = build(splitStructure(buildGlassStructure("zyx"), [SPEC]).outer);

    const target: [number, number, number] = firstBlock(fast.structure);
    removeStoredBlock(fast.structure, target);
    removeStoredBlock(reference.structure, target);
    const dirty = dirtyChunksFor([target], CS, STRUCTURE_SIZE) as unknown as vec3[];

    fast.cb.updateStructureBuffers(dirty);
    original.call(reference.cb, dirty);

    // 並び順まで含めて一致すること (ここが 0.2.0 では不一致だった)
    expect(diffChunkQuadSets(ordered(fast), ordered(reference))).toBeNull();
  });

  it("【M1】部分更新の並びが「同じ最終状態を全再構築した並び」と一致する", () => {
    const view = build(splitStructure(buildGlassStructure("reversed"), [SPEC]).outer);
    const target = firstBlock(view.structure);
    removeStoredBlock(view.structure, target);
    view.cb.updateStructureBuffers(dirtyChunksFor([target], CS, STRUCTURE_SIZE) as unknown as vec3[]);

    const rebuiltSource = splitStructure(buildGlassStructure("reversed"), [SPEC]).outer;
    removeStoredBlock(rebuiltSource, target);
    const rebuilt = build(rebuiltSource);

    expect(diffChunkQuadSets(ordered(view), ordered(rebuilt))).toBeNull();
  });

  it("【M1】ピックを繰り返しても「全再構築と同じ並び」を保つ (ちらつかない)", () => {
    const source = splitStructure(buildGlassStructure("zyx"), [SPEC]);
    const outer = build(source.outer);
    const inner = build(source.inner);
    const moved: string[] = [];

    const candidates = structureInternals(outer.structure)
      .blocks.map((b) => [...b.pos] as [number, number, number])
      .filter((_, i) => i % 37 === 0)
      .slice(0, 30);
    expect(candidates.length).toBeGreaterThan(20);

    candidates.forEach((pos, i) => {
      const stored = removeStoredBlock(outer.structure, pos);
      if (!stored) return;
      addStoredBlock(inner.structure, stored);
      moved.push(pos.join(","));
      const dirty = dirtyChunksFor([pos], CS, STRUCTURE_SIZE) as unknown as vec3[];
      outer.cb.updateStructureBuffers(dirty);
      inner.cb.updateStructureBuffers(dirty);

      // 同じ最終状態を素から全再構築したものと並び順込みで比較する。
      // 「resplit が走った瞬間に絵が変わる = ちらつく」を検出できる。
      // 参照の全再構築は高価なので数ステップおき + 最終ステップで確認する。
      if (i % 5 !== 0 && i !== candidates.length - 1) return;
      const ref = splitStructure(buildGlassStructure("zyx"), [
        SPEC,
        { region: null, materials: null, positions: [...moved] },
      ]);
      expect(diffChunkQuadSets(ordered(outer), ordered(build(ref.outer))), `step ${i}`).toBeNull();
      expect(diffChunkQuadSets(ordered(inner), ordered(build(ref.inner))), `step ${i}`).toBeNull();
    });
  });

  it("【対照】正規化しない構造体では並びが食い違う (順序比較テスト自体が有効なことの確認)", () => {
    // splitStructure を通さず、非昇順の生 Structure に部分更新をかける
    const original = ChunkBuilderOriginal();
    const fast = build(buildGlassStructure("reversed"));
    const reference = build(buildGlassStructure("reversed"));
    const target = firstBlock(fast.structure);
    removeStoredBlock(fast.structure, target);
    removeStoredBlock(reference.structure, target);
    const dirty = dirtyChunksFor([target], CS, STRUCTURE_SIZE) as unknown as vec3[];
    fast.cb.updateStructureBuffers(dirty);
    original.call(reference.cb, dirty);

    // quad 集合としては一致するが…
    expect(diffChunkQuadSets(chunkQuadSets(fast.cb, fast.buffers), chunkQuadSets(reference.cb, reference.buffers))).toBeNull();
    // 並び順は一致しない (= ordered 比較は本当に順序を見ている)
    expect(diffChunkQuadSets(ordered(fast), ordered(reference))).not.toBeNull();

    // sortStructureBlocks を通せば一致する (回避策が効くことの確認)
    const fixedFast = build(withSorted(buildGlassStructure("reversed")));
    const fixedRef = build(withSorted(buildGlassStructure("reversed")));
    removeStoredBlock(fixedFast.structure, target);
    removeStoredBlock(fixedRef.structure, target);
    fixedFast.cb.updateStructureBuffers(dirty);
    original.call(fixedRef.cb, dirty);
    expect(diffChunkQuadSets(ordered(fixedFast), ordered(fixedRef))).toBeNull();
  });
});

function withSorted(structure: Structure): Structure {
  sortStructureBlocks(structure);
  return structure;
}

function firstBlock(structure: Structure): [number, number, number] {
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      for (let z = 0; z < SIZE; z++) {
        if (storedBlockAt(structure, [x, y, z])) return [x, y, z];
      }
    }
  }
  throw new Error("no block");
}

/**
 * 素の deepslate 実装。applyDeepslatePatches はモジュール評価時に走っているので、
 * `fastPartialChunkUpdate: false` に落として patched 経由で委譲させる。
 */
function ChunkBuilderOriginal() {
  return function (this: ChunkBuilder, chunkPositions?: vec3[]) {
    applyDeepslatePatches({ fastPartialChunkUpdate: false });
    try {
      this.updateStructureBuffers(chunkPositions);
    } finally {
      applyDeepslatePatches({ fastPartialChunkUpdate: true });
    }
  };
}
