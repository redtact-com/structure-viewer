// IncrementalSplitView の正確性テスト。
//
// 中核は scripts/verify-partial.mjs (プロトタイプ) の移植:
// 通常 / チャンク境界 / チャンク角の 3 条件 x 25 ピック = 75 ピックを差分適用し、
// 同じ最終状態を splitStructure から full 再構築したものと
// **チャンクごとの quad 集合**が一致することを確認する。
//
// あわせて「自チャンクだけ更新すると一致しない」ことも回帰テストとして残す。
// これが緑のままになると 6 近傍更新を落としても気付けなくなる。
import { describe, expect, it } from "vitest";
import { Structure } from "deepslate/core";
import { ChunkBuilder } from "deepslate/render";
import type { vec3 } from "gl-matrix";

import { applyDeepslatePatches } from "./deepslatePatches";
import {
  IncrementalSplitView,
  parsePosKey,
  type SplitInputs,
  type SplitRenderTarget,
} from "./incrementalSplit";
import {
  addStoredBlock,
  removeStoredBlock,
  splitStructure,
  storedBlockAt,
  structureInternals,
  type SelectionSpec,
} from "./splitStructure";
import {
  buildFixtureStructure,
  chunkQuadSets,
  createMockGl,
  createMockResources,
  diffChunkQuadSets,
  rng,
} from "./testFixtures";

applyDeepslatePatches({ releaseQuadsAfterUpload: false, fastPartialChunkUpdate: true });

const SIZE = 32;
const CHUNK_SIZE = 8;
const resources = createMockResources();

/** ChunkBuilder を持つ SplitRenderTarget (実物のレンダラと同じ経路を通す) */
class TestTarget implements SplitRenderTarget {
  readonly cb: ChunkBuilder;
  readonly buffers: ReturnType<typeof createMockGl>["buffers"];

  constructor() {
    const { gl, buffers } = createMockGl();
    this.buffers = buffers;
    this.cb = new ChunkBuilder(gl, new Structure([SIZE, SIZE, SIZE]), resources, CHUNK_SIZE);
  }

  setStructure(structure: Parameters<ChunkBuilder["setStructure"]>[0]) {
    this.cb.setStructure(structure);
  }

  updateStructureBuffers(chunkPositions?: vec3[]) {
    this.cb.updateStructureBuffers(chunkPositions);
  }

  quadSets() {
    return chunkQuadSets(this.cb, this.buffers);
  }
}

/** 構造体を丸ごと構築した参照用 ChunkBuilder */
function referenceQuadSets(structure: Structure) {
  const { gl, buffers } = createMockGl();
  const cb = new ChunkBuilder(gl, structure, resources, CHUNK_SIZE);
  return chunkQuadSets(cb, buffers);
}

/** x < SIZE/2 を inner にする region spec (ピック前の初期分割) */
const REGION_SPEC: SelectionSpec = {
  region: { start: [0, 0, 0], end: [SIZE / 2 - 1, SIZE - 1, SIZE - 1] },
  materials: null,
};

function makeInputs(overrides?: Partial<SplitInputs>): SplitInputs {
  return { specs: [REGION_SPEC], crop: null, slice: null, ...overrides };
}

function makeView(full: Structure, inputs = makeInputs()) {
  const targets = { inner: new TestTarget(), outer: new TestTarget() };
  const view = new IncrementalSplitView(full, inputs, targets, { chunkSize: CHUNK_SIZE });
  return { view, targets };
}

/** 差分適用後の最終状態 = region spec ∪ picked positions を full 再構築したもの */
function expectMatchesFullRebuild(
  full: Structure,
  picked: string[],
  targets: { inner: TestTarget; outer: TestTarget },
) {
  const reference = splitStructure(full, [
    REGION_SPEC,
    { region: null, materials: null, positions: picked },
  ]);
  expect(diffChunkQuadSets(targets.inner.quadSets(), referenceQuadSets(reference.inner))).toBeNull();
  expect(diffChunkQuadSets(targets.outer.quadSets(), referenceQuadSets(reference.outer))).toBeNull();
}

type PickMode = "ランダム" | "チャンク境界" | "チャンク角";

/** outer 側 (x >= SIZE/2) から条件に合うブロックを n 個選ぶ */
function choosePicks(full: Structure, mode: PickMode, n: number, seed: number): string[] {
  const candidates: string[] = [];
  for (let x = SIZE / 2; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      for (let z = 0; z < SIZE; z++) {
        if (!storedBlockAt(full, [x, y, z])) continue;
        if (mode === "チャンク境界" && x % CHUNK_SIZE !== 0) continue;
        if (
          mode === "チャンク角" &&
          !(x % CHUNK_SIZE === 0 && y % CHUNK_SIZE === 0 && z % CHUNK_SIZE === 0)
        ) {
          continue;
        }
        candidates.push(`${x},${y},${z}`);
      }
    }
  }
  const rand = rng(seed);
  const chosen = new Set<string>();
  for (let i = 0; i < n * 20 && chosen.size < n && candidates.length; i++) {
    chosen.add(candidates[Math.floor(rand() * candidates.length)]);
  }
  return [...chosen];
}

describe("IncrementalSplitView", () => {
  it("fixture: outer 側にチャンク境界・チャンク角の候補が十分ある", () => {
    const full = buildFixtureStructure(SIZE, 0.4);
    expect(choosePicks(full, "ランダム", 25, 1).length).toBe(25);
    expect(choosePicks(full, "チャンク境界", 25, 2).length).toBe(25);
    expect(choosePicks(full, "チャンク角", 25, 3).length).toBeGreaterThan(4);
  });

  // 素の deepslate の部分更新経路でも patch (e) 経路でも同じ結果になること
  for (const fastPartial of [false, true]) {
    describe(`fastPartialChunkUpdate=${fastPartial}`, () => {
      for (const [seed, mode] of [
        [11, "ランダム"],
        [22, "チャンク境界"],
        [33, "チャンク角"],
      ] as const) {
        it(`${mode}ピックの差分適用が full 再構築と一致する`, () => {
          applyDeepslatePatches({ fastPartialChunkUpdate: fastPartial });
          try {
            const full = buildFixtureStructure(SIZE, 0.4);
            const { view, targets } = makeView(full);
            const picks = choosePicks(full, mode, 25, seed);
            expect(picks.length).toBeGreaterThan(4);

            for (const key of picks) {
              expect(view.toggle([key], true, makeInputs())).toBeGreaterThan(0);
            }
            expect(view.verifyConsistency()).toBeNull();
            expectMatchesFullRebuild(full, picks, targets);
          } finally {
            applyDeepslatePatches({ fastPartialChunkUpdate: true });
          }
        });
      }
    });
  }

  it("まとめてトグル (ドラッグ確定相当) でも full 再構築と一致する", () => {
    const full = buildFixtureStructure(SIZE, 0.4);
    const { view, targets } = makeView(full);
    const picks = choosePicks(full, "ランダム", 20, 77);
    expect(view.toggle(picks, true, makeInputs())).toBeGreaterThan(0);
    expect(view.verifyConsistency()).toBeNull();
    expectMatchesFullRebuild(full, picks, targets);
  });

  it("トグルを戻す (add=false) と元の分割に戻る", () => {
    const full = buildFixtureStructure(SIZE, 0.4);
    const { view, targets } = makeView(full);
    const baselineInner = targets.inner.quadSets();
    const baselineOuter = targets.outer.quadSets();

    const picks = choosePicks(full, "チャンク境界", 10, 55);
    view.toggle(picks, true, makeInputs());
    view.toggle(picks, false, makeInputs());

    expect(view.verifyConsistency()).toBeNull();
    expect(diffChunkQuadSets(targets.inner.quadSets(), baselineInner)).toBeNull();
    expect(diffChunkQuadSets(targets.outer.quadSets(), baselineOuter)).toBeNull();
  });

  it("【回帰】自チャンクだけ更新すると full 再構築と一致しない (6 近傍更新が必須の証明)", () => {
    const full = buildFixtureStructure(SIZE, 0.4);
    const { inner, outer } = splitStructure(full, [REGION_SPEC]);

    // チャンク境界にあり、境界の向こう側 (x-1) が同じ outer 側の不透明ブロックである
    // ものを選ぶ。両方が不透明でないと「カリングされていた面が復活する」差が出ない。
    const isOpaqueCube = (pos: [number, number, number]) => {
      const block = outer.getBlock(pos);
      if (!block) return false;
      const path = block.state.getName().path;
      return path === "stone" || path === "planks" || path === "lamp";
    };
    let target: [number, number, number] | null = null;
    // region 境界 (x = SIZE/2) より内側だと x-1 が inner 側になるので 1 チャンク先から探す
    for (let x = SIZE / 2 + CHUNK_SIZE; x < SIZE && !target; x += CHUNK_SIZE) {
      for (let y = 0; y < SIZE && !target; y++) {
        for (let z = 0; z < SIZE && !target; z++) {
          if (!isOpaqueCube([x, y, z])) continue;
          if (!isOpaqueCube([x - 1, y, z])) continue;
          target = [x, y, z];
        }
      }
    }
    expect(target).not.toBeNull();
    const [tx, ty, tz] = target!;
    const ownChunk: vec3[] = [
      [
        Math.floor(tx / CHUNK_SIZE),
        Math.floor(ty / CHUNK_SIZE),
        Math.floor(tz / CHUNK_SIZE),
      ] as unknown as vec3,
    ];

    const onlyOwn = new TestTarget();
    onlyOwn.setStructure(outer);
    const stored = removeStoredBlock(outer, [tx, ty, tz])!;
    addStoredBlock(inner, stored);
    onlyOwn.updateStructureBuffers(ownChunk);

    // 自チャンクだけでは、境界の向こう (x-1 側チャンク) のカリング面が古いまま残る
    expect(diffChunkQuadSets(onlyOwn.quadSets(), referenceQuadSets(outer))).not.toBeNull();

    // 6 近傍込みなら一致する
    const neighborChunk: vec3[] = [
      ...ownChunk,
      [
        Math.floor((tx - 1) / CHUNK_SIZE),
        Math.floor(ty / CHUNK_SIZE),
        Math.floor(tz / CHUNK_SIZE),
      ] as unknown as vec3,
    ];
    onlyOwn.updateStructureBuffers(neighborChunk);
    expect(diffChunkQuadSets(onlyOwn.quadSets(), referenceQuadSets(outer))).toBeNull();
  });

  describe("戻り値と自己検証", () => {
    it("空 / 不正キー / 対象外の座標は 0 を返す (再メッシュしない)", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const { view } = makeView(full);
      expect(view.toggle([], true, makeInputs())).toBe(0);
      expect(view.toggle(["こわれたキー"], true, makeInputs())).toBe(0);
      expect(view.toggle(["1,2"], true, makeInputs())).toBe(0);
      // 空気の座標 / 既に inner 側にある座標
      expect(view.toggle(["999,999,999"], true, makeInputs())).toBe(0);
      expect(view.toggle(["0,0,0"], true, makeInputs())).toBe(0);
    });

    it("dirty チャンクが閾値を超えたら -1 を返し、構造体を一切変更しない", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const targets = { inner: new TestTarget(), outer: new TestTarget() };
      const view = new IncrementalSplitView(full, makeInputs(), targets, {
        chunkSize: CHUNK_SIZE,
        fullRebuildChunkThreshold: 2,
      });
      const before = targets.outer.quadSets();
      const picks = choosePicks(full, "ランダム", 25, 99);

      expect(view.toggle(picks, true, makeInputs())).toBe(-1);
      // 未変更であること (呼び出し側が resplit する前提)
      for (const key of picks) {
        expect(storedBlockAt(view.outer, parsePosKey(key)!)).not.toBeNull();
      }
      expect(diffChunkQuadSets(targets.outer.quadSets(), before)).toBeNull();
    });

    it("構造シグネチャが食い違ったら強制 resplit して -1 を返す", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const { view, targets } = makeView(full);

      // 呼び出し側の specs が変わったのに差分経路に来てしまったケース
      const changed: SelectionSpec = {
        region: { start: [0, 0, 0], end: [3, SIZE - 1, SIZE - 1] },
        materials: null,
      };
      const picks = choosePicks(full, "ランダム", 3, 5);
      expect(view.toggle(picks, true, { specs: [changed] })).toBe(-1);

      // 新しい specs で再分割済み = 画面が乖離しない
      const reference = splitStructure(full, [changed]);
      expect(
        diffChunkQuadSets(targets.inner.quadSets(), referenceQuadSets(reference.inner)),
      ).toBeNull();
      expect(view.verifyConsistency()).toBeNull();
    });

    it("positions が空になる遷移 (ピックモード解除) もシグネチャ不一致として検出する", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const withPositions = makeInputs({
        specs: [{ region: null, materials: null, positions: ["12,0,0"] }],
      });
      const { view } = makeView(full, withPositions);
      const withoutPositions = makeInputs({
        specs: [{ region: null, materials: null, positions: [] }],
      });
      expect(view.toggle(["13,0,0"], true, withoutPositions)).toBe(-1);
    });

    it("expected を渡さなければシグネチャ検証をせずに差分適用する", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const { view, targets } = makeView(full);
      const picks = choosePicks(full, "ランダム", 5, 8);
      expect(view.toggle(picks, true)).toBeGreaterThan(0);
      expectMatchesFullRebuild(full, picks, targets);
    });

    it("verifyConsistency は blocksMap を壊すと検出する", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const { view } = makeView(full);
      expect(view.verifyConsistency()).toBeNull();
      const internal = structureInternals(view.outer);
      // inner に既にある座標を outer にも生やす = 重複保持
      const innerBlock = structureInternals(view.inner).blocks[0];
      internal.blocks.push(innerBlock);
      internal.blocksMap[
        innerBlock.pos[0] * SIZE * SIZE + innerBlock.pos[1] * SIZE + innerBlock.pos[2]
      ] = innerBlock;
      expect(view.verifyConsistency()).toContain("重複保持");
    });
  });

  describe("slice / crop との組み合わせ", () => {
    it("スライス適用後の実体を保持し、範囲外の座標のトグルは no-op になる", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const slice: [number, number] = [0, 7];
      const inputs = makeInputs({ slice });
      const { view, targets } = makeView(full, inputs);

      // スライス範囲内はすべて y <= 7
      expect(view.inner.getBlocks().every((b) => b.pos[1] <= 7)).toBe(true);
      expect(view.outer.getBlocks().every((b) => b.pos[1] <= 7)).toBe(true);

      // 範囲外 (y >= 8) のピックは差分に現れない
      const outside = choosePicks(full, "ランダム", 40, 4).filter((k) => parsePosKey(k)![1] >= 8);
      expect(outside.length).toBeGreaterThan(0);
      expect(view.toggle(outside, true, inputs)).toBe(0);

      // 範囲内のピックは通常どおり差分適用され、full 再構築と一致する
      const inside = choosePicks(full, "ランダム", 40, 4).filter((k) => parsePosKey(k)![1] <= 7);
      expect(inside.length).toBeGreaterThan(0);
      expect(view.toggle(inside, true, inputs)).toBeGreaterThan(0);

      const reference = splitStructure(full, [
        REGION_SPEC,
        { region: null, materials: null, positions: inside },
      ]);
      const sliced = (s: Structure) =>
        new Structure(
          [SIZE, SIZE, SIZE],
          structureInternals(s).palette.slice(),
          structureInternals(s).blocks.filter((b) => b.pos[1] <= 7),
        );
      expect(
        diffChunkQuadSets(targets.inner.quadSets(), referenceQuadSets(sliced(reference.inner))),
      ).toBeNull();
      expect(
        diffChunkQuadSets(targets.outer.quadSets(), referenceQuadSets(sliced(reference.outer))),
      ).toBeNull();
    });

    it("slice の変更はシグネチャ不一致として resplit に落ちる", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const inputs = makeInputs({ slice: [0, 7] });
      const { view } = makeView(full, inputs);
      expect(view.toggle(["12,0,0"], true, makeInputs({ slice: [0, 15] }))).toBe(-1);
      expect(view.inner.getBlocks().concat(view.outer.getBlocks()).some((b) => b.pos[1] > 7)).toBe(
        true,
      );
    });

    it("crop モードでは faded 側が outer になり、範囲外はどちらにも入らない", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const crop = {
        region: { start: [0, 0, 0] as [number, number, number], end: [11, 11, 11] as [number, number, number] },
        materials: null,
        positions: ["1,1,1"],
      };
      const { view, targets } = makeView(full, makeInputs({ crop }));
      const all = view.inner.getBlocks().concat(view.outer.getBlocks());
      expect(all.every((b) => b.pos.every((v) => v <= 11))).toBe(true);
      expect(all.length).toBeGreaterThan(0);

      // crop 範囲外のトグルは no-op、範囲内は差分適用される
      expect(view.toggle(["20,20,20"], true)).toBe(0);
      const inside = view.outer.getBlocks()[0].pos.join(",");
      expect(view.toggle([inside], true)).toBeGreaterThan(0);
      expect(view.verifyConsistency()).toBeNull();
      expect(targets.inner.quadSets().size).toBeGreaterThan(0);
    });

    it("resplit は specs を差し替えて両レンダラを作り直す", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const { view, targets } = makeView(full);
      const newSpec: SelectionSpec = { region: null, materials: ["minecraft:stone"] };
      view.resplit([newSpec]);
      const reference = splitStructure(full, [newSpec]);
      expect(
        diffChunkQuadSets(targets.inner.quadSets(), referenceQuadSets(reference.inner)),
      ).toBeNull();
      expect(
        diffChunkQuadSets(targets.outer.quadSets(), referenceQuadSets(reference.outer)),
      ).toBeNull();
      // resplit 後は新しいシグネチャで差分が通る
      expect(view.toggle([], true, { specs: [newSpec] })).toBe(0);
    });
  });

  describe("parsePosKey", () => {
    it("整数 3 つのみを受け付ける", () => {
      expect(parsePosKey("1,2,3")).toEqual([1, 2, 3]);
      expect(parsePosKey("-1,0,7")).toEqual([-1, 0, 7]);
      expect(parsePosKey("1,2")).toBeNull();
      expect(parsePosKey("1,2,3,4")).toBeNull();
      expect(parsePosKey("1,2,x")).toBeNull();
      expect(parsePosKey("1,2,3.5")).toBeNull();
      expect(parsePosKey("")).toBeNull();
    });
  });
});
