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

/**
 * ChunkBuilder を持つ SplitRenderTarget (実物のレンダラと同じ経路を通す)。
 * `log` に呼び出し履歴を残すので「内部で resplit していないか」を検証できる。
 */
class TestTarget implements SplitRenderTarget {
  readonly cb: ChunkBuilder;
  readonly buffers: ReturnType<typeof createMockGl>["buffers"];
  readonly chunkSize: readonly [number, number, number];
  readonly log: string[] = [];

  constructor(chunkSize = CHUNK_SIZE) {
    const { gl, buffers } = createMockGl();
    this.buffers = buffers;
    this.chunkSize = [chunkSize, chunkSize, chunkSize];
    this.cb = new ChunkBuilder(gl, new Structure([SIZE, SIZE, SIZE]), resources, chunkSize);
  }

  setStructure(structure: Parameters<ChunkBuilder["setStructure"]>[0]) {
    this.log.push("set");
    this.cb.setStructure(structure);
  }

  updateStructureBuffers(chunkPositions?: vec3[]) {
    this.log.push(`update:${chunkPositions?.length ?? "all"}`);
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

/**
 * ピックモードの specs。positions が非空の spec は region/materials を無視するので、
 * 差分が通るのは「positions 非空のまま中身だけ変わる」区間だけ。
 * 0 個 ⇄ 1 個 の遷移は分割の意味論が変わるため必ず resplit になる (仕様)。
 */
function specsWith(positions: readonly string[]): SelectionSpec[] {
  return [{ region: null, materials: null, positions: [...positions] }];
}

function pickInputs(positions: readonly string[], overrides?: Partial<SplitInputs>): SplitInputs {
  return { specs: specsWith(positions), crop: null, slice: null, ...overrides };
}

function makeView(full: Structure, inputs = makeInputs()) {
  const targets = { inner: new TestTarget(), outer: new TestTarget() };
  const view = new IncrementalSplitView(full, inputs, targets, { chunkSize: CHUNK_SIZE });
  return { view, targets };
}

/** 差分適用後の最終状態 = picked positions を full 再構築したもの */
function expectMatchesFullRebuild(
  full: Structure,
  picked: readonly string[],
  targets: { inner: TestTarget; outer: TestTarget },
) {
  const reference = splitStructure(full, specsWith(picked));
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
            const picks = choosePicks(full, mode, 25, seed);
            expect(picks.length).toBeGreaterThan(4);
            // 1 個目でピックモードに入った状態から差分を始める
            const applied = [picks[0]];
            const { view, targets } = makeView(full, pickInputs(applied));

            for (const key of picks.slice(1)) {
              applied.push(key);
              const result = view.toggle([key], true, pickInputs(applied));
              expect(result.status).toBe("applied");
              expect(result.chunks).toBeGreaterThan(0);
            }
            expect(view.verifyConsistency()).toBeNull();
            expectMatchesFullRebuild(full, applied, targets);
          } finally {
            applyDeepslatePatches({ fastPartialChunkUpdate: true });
          }
        });
      }
    });
  }

  it("まとめてトグル (ドラッグ確定相当) でも full 再構築と一致する", () => {
    const full = buildFixtureStructure(SIZE, 0.4);
    const picks = choosePicks(full, "ランダム", 20, 77);
    const { view, targets } = makeView(full, pickInputs([picks[0]]));
    const rest = picks.slice(1);
    const result = view.toggle(rest, true, pickInputs(picks));
    expect(result.status).toBe("applied");
    expect(result.moved).toBe(rest.length);
    expect(view.verifyConsistency()).toBeNull();
    expectMatchesFullRebuild(full, picks, targets);
  });

  it("トグルを戻す (add=false) と元の分割に戻る", () => {
    const full = buildFixtureStructure(SIZE, 0.4);
    const picks = choosePicks(full, "チャンク境界", 11, 55);
    const seedKeys = [picks[0]];
    const rest = picks.slice(1);
    const { view, targets } = makeView(full, pickInputs(seedKeys));
    const baselineInner = targets.inner.quadSets();
    const baselineOuter = targets.outer.quadSets();

    expect(view.toggle(rest, true, pickInputs(picks)).status).toBe("applied");
    expect(view.toggle(rest, false, pickInputs(seedKeys)).status).toBe("applied");

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
    it("空 / 不正キー / 対象外の座標は noop を返す (再メッシュしない)", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const seed = choosePicks(full, "ランダム", 1, 1);
      const { view } = makeView(full, pickInputs(seed));
      expect(view.toggle([], true, pickInputs(seed))).toMatchObject({
        status: "noop",
        skipped: 0,
      });
      // 不正キー / 空気の座標は skipped として報告する
      expect(view.toggle(["こわれたキー"], true, pickInputs([...seed, "こわれたキー"]))).toMatchObject({
        status: "noop",
        skipped: 1,
      });
      expect(
        view.toggle(["999,999,999"], true, pickInputs([...seed, "こわれたキー", "999,999,999"])),
      ).toMatchObject({ status: "noop", skipped: 1 });
    });

    it("【M3】閾値超過は needs-resplit(threshold) を返し、内部で resplit しない", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const picks = choosePicks(full, "ランダム", 25, 99);
      const targets = { inner: new TestTarget(), outer: new TestTarget() };
      const view = new IncrementalSplitView(full, pickInputs([picks[0]]), targets, {
        chunkSize: CHUNK_SIZE,
        fullRebuildChunkThreshold: 2,
      });
      const before = targets.outer.quadSets();
      targets.inner.log.length = 0;
      targets.outer.log.length = 0;

      const result = view.toggle(picks.slice(1), true, pickInputs(picks));
      expect(result).toMatchObject({ status: "needs-resplit", reason: "threshold", chunks: 0 });
      // ビューは完全に無変更 (setStructure も updateStructureBuffers も呼ばれない)
      expect(targets.inner.log).toEqual([]);
      expect(targets.outer.log).toEqual([]);
      for (const key of picks.slice(1)) {
        expect(storedBlockAt(view.outer, parsePosKey(key)!)).not.toBeNull();
      }
      expect(diffChunkQuadSets(targets.outer.quadSets(), before)).toBeNull();
    });

    it("【M3】構造シグネチャ不一致でも内部 resplit せず needs-resplit(structure) を返す", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const { view, targets } = makeView(full, pickInputs(choosePicks(full, "ランダム", 1, 2)));
      targets.inner.log.length = 0;
      targets.outer.log.length = 0;

      const changed: SelectionSpec = {
        region: { start: [0, 0, 0], end: [3, SIZE - 1, SIZE - 1] },
        materials: null,
      };
      const picks = choosePicks(full, "ランダム", 3, 5);
      const next: SplitInputs = { specs: [changed], crop: null, slice: null };
      expect(view.toggle(picks, true, next)).toMatchObject({
        status: "needs-resplit",
        reason: "structure",
      });
      // 0.2.0 はここで内部 resplit していたため、呼び出し側と合わせて全再構築が 2 回走った
      expect(targets.inner.log).toEqual([]);
      expect(targets.outer.log).toEqual([]);

      // 呼び出し側が 1 回だけ resplit すれば正しくなる
      view.resplit(next);
      expect(targets.inner.log).toEqual(["set"]);
      const reference = splitStructure(full, [changed]);
      expect(
        diffChunkQuadSets(targets.inner.quadSets(), referenceQuadSets(reference.inner)),
      ).toBeNull();
      expect(view.verifyConsistency()).toBeNull();
    });

    it("【M3】最後の 1 個を解除する遷移 (positions 1→0) でも全再構築は 1 回だけ", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const key = choosePicks(full, "ランダム", 1, 3)[0];
      const { view, targets } = makeView(full, pickInputs([key]));

      targets.inner.log.length = 0;
      targets.outer.log.length = 0;
      // positions 1 → 0 は分割の意味論が変わるので needs-resplit になる
      const cleared = pickInputs([]);
      expect(view.toggle([key], false, cleared)).toMatchObject({
        status: "needs-resplit",
        reason: "structure",
      });
      expect(targets.inner.log).toEqual([]);
      view.resplit(cleared);
      // setStructure は inner/outer 各 1 回だけ = 全再構築 1 回
      expect(targets.inner.log).toEqual(["set"]);
      expect(targets.outer.log).toEqual(["set"]);
    });

    it("【M2】positions の総入れ替えを検出して needs-resplit(positions) を返す", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const [a, b] = choosePicks(full, "ランダム", 2, 42);
      const { view, targets } = makeView(full, pickInputs([a]));
      expect(storedBlockAt(view.inner, parsePosKey(a)!)).not.toBeNull();

      targets.inner.log.length = 0;
      // 無修飾クリック = 選択の置換。アプリ state は [b] になっているが
      // 差分としては「b を追加」しか渡ってこない
      const result = view.toggle([b], true, pickInputs([b]));
      expect(result).toMatchObject({ status: "needs-resplit", reason: "positions" });
      // 0.2.0 はここで applied を返し、a が inner に残り続けていた
      expect(targets.inner.log).toEqual([]);
      expect(storedBlockAt(view.inner, parsePosKey(b)!)).toBeNull();

      view.resplit(pickInputs([b]));
      expect(storedBlockAt(view.inner, parsePosKey(a)!)).toBeNull();
      expect(storedBlockAt(view.inner, parsePosKey(b)!)).not.toBeNull();
    });

    it("【M5】inputs は「トグル適用後」の状態。適用前を渡すと needs-resplit になる", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const [seed, key] = choosePicks(full, "ランダム", 2, 9);
      const { view } = makeView(full, pickInputs([seed]));
      // 適用「前」の inputs を渡す = README が 0.2.0 で教えていた規約
      expect(view.toggle([key], true, pickInputs([seed]))).toMatchObject({
        status: "needs-resplit",
        reason: "positions",
      });
      // 適用「後」を渡せば通る
      expect(view.toggle([key], true, pickInputs([seed, key])).status).toBe("applied");
    });

    it("【M4】validate 既定 on で、重複座標を含む構造体は構築時に報告される", () => {
      const messages: string[] = [];
      const dup = new Structure([SIZE, SIZE, SIZE]);
      dup.addBlock([1, 1, 1], "minecraft:stone");
      dup.addBlock([1, 1, 1], "minecraft:planks"); // 同一座標に 2 エントリ
      dup.addBlock([2, 1, 1], "minecraft:stone");

      new IncrementalSplitView(
        dup,
        { specs: [{ region: null, materials: ["minecraft:stone"] }] },
        { inner: new TestTarget(), outer: new TestTarget() },
        { chunkSize: CHUNK_SIZE, onValidationError: (m) => messages.push(m) },
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0]).toMatch(/重複/);
    });

    it("【M4】validate: false なら検証しない", () => {
      const messages: string[] = [];
      const dup = new Structure([SIZE, SIZE, SIZE]);
      dup.addBlock([1, 1, 1], "minecraft:stone");
      dup.addBlock([1, 1, 1], "minecraft:planks");
      new IncrementalSplitView(
        dup,
        { specs: [{ region: null, materials: ["minecraft:stone"] }] },
        { inner: new TestTarget(), outer: new TestTarget() },
        { chunkSize: CHUNK_SIZE, validate: false, onValidationError: (m) => messages.push(m) },
      );
      expect(messages).toEqual([]);
    });

    it("verifyConsistency は palette index の範囲外を検出する", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const { view } = makeView(full);
      expect(view.verifyConsistency()).toBeNull();
      const internal = structureInternals(view.inner);
      internal.blocks[0].state = 999;
      internal.blocksMap[
        internal.blocks[0].pos[0] * SIZE * SIZE +
          internal.blocks[0].pos[1] * SIZE +
          internal.blocks[0].pos[2]
      ]!.state = 999;
      expect(view.verifyConsistency()).toContain("palette index");
    });

    it("verifyConsistency は inner/outer の座標重複を検出する", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const { view } = makeView(full);
      const internal = structureInternals(view.outer);
      const innerBlock = structureInternals(view.inner).blocks[0];
      internal.blocks.push(innerBlock);
      internal.blocksMap[
        innerBlock.pos[0] * SIZE * SIZE + innerBlock.pos[1] * SIZE + innerBlock.pos[2]
      ] = innerBlock;
      expect(view.verifyConsistency()).toContain("重複保持");
    });
  });

  describe("chunkSize", () => {
    it("target が chunkSize を公開していて view と食い違うなら構築時に throw する", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const target = new TestTarget();
      expect(
        () =>
          new IncrementalSplitView(full, makeInputs(), { inner: target, outer: new TestTarget() }, {
            chunkSize: 16,
          }),
      ).toThrow(/chunkSize/);
    });

    it("一致していれば throw しない / chunkSize を公開しない target は検証をスキップ", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      expect(() => makeView(full)).not.toThrow();
      const opaqueTarget: SplitRenderTarget = {
        setStructure: () => {},
        updateStructureBuffers: () => {},
      };
      expect(
        () =>
          new IncrementalSplitView(
            full,
            makeInputs(),
            { inner: opaqueTarget, outer: opaqueTarget },
            { chunkSize: 4 },
          ),
      ).not.toThrow();
    });

    it("既定の fullRebuildChunkThreshold はチャンクサイズ連動 (走査セル数ベース)", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const make = (cs: number) =>
        new IncrementalSplitView(
          full,
          makeInputs(),
          { inner: new TestTarget(cs), outer: new TestTarget(cs) },
          { chunkSize: cs },
        ).fullRebuildChunkThreshold;
      expect(make(16)).toBe(48);
      expect(make(8)).toBe(384);
      expect(make(32)).toBe(6);
    });
  });

  describe("slice / crop との組み合わせ", () => {
    it("スライス適用後の実体を保持し、範囲外の座標のトグルは skipped になる", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const slice: [number, number] = [0, 7];
      const seed = choosePicks(full, "ランダム", 40, 12)
        .filter((k) => parsePosKey(k)![1] <= 7)
        .slice(0, 1);
      expect(seed.length).toBe(1);
      const { view, targets } = makeView(full, pickInputs(seed, { slice }));

      expect(view.inner.getBlocks().every((b) => b.pos[1] <= 7)).toBe(true);
      expect(view.outer.getBlocks().every((b) => b.pos[1] <= 7)).toBe(true);

      // 範囲外 (y >= 8) のピックは差分に現れない (skipped で申告される)
      const outside = choosePicks(full, "ランダム", 40, 4).filter((k) => parsePosKey(k)![1] >= 8);
      expect(outside.length).toBeGreaterThan(0);
      expect(
        view.toggle(outside, true, pickInputs([...seed, ...outside], { slice })),
      ).toMatchObject({ status: "noop", skipped: outside.length });

      // 範囲内のピックは通常どおり差分適用され、full 再構築と一致する
      const inside = choosePicks(full, "ランダム", 40, 4)
        .filter((k) => parsePosKey(k)![1] <= 7)
        .filter((k) => !seed.includes(k));
      expect(inside.length).toBeGreaterThan(0);
      expect(
        view.toggle(inside, true, pickInputs([...seed, ...outside, ...inside], { slice })).status,
      ).toBe("applied");

      const reference = splitStructure(full, specsWith([...seed, ...inside]));
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

    it("slice の変更はシグネチャ不一致として needs-resplit になる", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const [seed, key] = choosePicks(full, "ランダム", 2, 6);
      const { view } = makeView(full, pickInputs([seed], { slice: [0, 7] }));
      expect(
        view.toggle([key], true, pickInputs([seed, key], { slice: [0, 15] })),
      ).toMatchObject({ status: "needs-resplit", reason: "structure" });
    });

    it("crop モードでは faded 側が outer になり、範囲外はどちらにも入らない", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const cropOf = (positions: string[]) => ({
        region: {
          start: [0, 0, 0] as [number, number, number],
          end: [11, 11, 11] as [number, number, number],
        },
        materials: null,
        positions,
      });
      const { view, targets } = makeView(full, { specs: [], crop: cropOf(["1,1,1"]) });
      const all = view.inner.getBlocks().concat(view.outer.getBlocks());
      expect(all.every((b) => b.pos.every((v) => v <= 11))).toBe(true);
      expect(all.length).toBeGreaterThan(0);

      // crop 範囲外のトグルは skipped
      expect(
        view.toggle(["20,20,20"], true, { specs: [], crop: cropOf(["1,1,1", "20,20,20"]) }),
      ).toMatchObject({ status: "noop", skipped: 1 });

      const inside = view.outer.getBlocks()[0].pos.join(",");
      expect(
        view.toggle([inside], true, {
          specs: [],
          crop: cropOf(["1,1,1", "20,20,20", inside]),
        }).status,
      ).toBe("applied");
      expect(view.verifyConsistency()).toBeNull();
      expect(targets.inner.quadSets().size).toBeGreaterThan(0);
    });

    it("【minor】resplit は SplitInputs を受けるので crop/slice が落ちない", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const inputs = makeInputs({ slice: [0, 7] });
      const { view } = makeView(full, inputs);
      // 0.2.0 の位置引数版は resplit(specs) だけ呼ぶと slice が消えていた
      view.resplit(inputs);
      expect(view.inner.getBlocks().every((b) => b.pos[1] <= 7)).toBe(true);
      expect(view.outer.getBlocks().every((b) => b.pos[1] <= 7)).toBe(true);
    });

    it("resplit は specs を差し替えて両レンダラを作り直す", () => {
      const full = buildFixtureStructure(SIZE, 0.4);
      const { view, targets } = makeView(full);
      const newSpec: SelectionSpec = { region: null, materials: ["minecraft:stone"] };
      view.resplit({ specs: [newSpec] });
      const reference = splitStructure(full, [newSpec]);
      expect(
        diffChunkQuadSets(targets.inner.quadSets(), referenceQuadSets(reference.inner)),
      ).toBeNull();
      expect(
        diffChunkQuadSets(targets.outer.quadSets(), referenceQuadSets(reference.outer)),
      ).toBeNull();
      // resplit 後は新しいシグネチャで差分が通る
      expect(view.toggle([], true, { specs: [newSpec] }).status).toBe("noop");
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
