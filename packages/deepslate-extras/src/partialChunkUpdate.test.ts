// patch (e) fastPartialChunkUpdate の正確性テスト。
//
// このパッチの生命線は「速いが出力を変えない」ことなので、
//   (1) chunkPositions 未指定 (全再構築) は完全に無改変であること
//   (2) chunkPositions 指定時の出力が素の deepslate 実装と一致すること
//   (3) 同じ最終状態を full 再構築したものとも一致すること
//   (4) releaseQuadsAfterUpload 併用時も正しく再構築されること
// を mock GL で検証する。
//
// 比較はバイト一致ではなく「チャンクごとの quad 集合」で行う。
// 部分更新は座標昇順に走査するため、チャンク内の quad 並びが
// 素の実装 (blocks 配列順) と変わるが、deepslate はチャンク内をソートしないので
// 描画結果は同一 (集合が一致すれば等価)。
import { beforeEach, describe, expect, it } from "vitest";
import { Structure } from "deepslate/core";
import { ChunkBuilder } from "deepslate/render";
import type { vec3 } from "gl-matrix";

import { applyDeepslatePatches } from "./deepslatePatches";
import { dirtyChunksFor, removeStoredBlock, storedBlockAt } from "./splitStructure";
import {
  buildFixtureStructure,
  chunkQuadSets,
  createMockGl,
  createMockResources,
  diffChunkQuadSets,
} from "./testFixtures";

// パッチ適用前に素の実装を退避する (これが「素の deepslate」の基準)
const originalUpdateStructureBuffers = ChunkBuilder.prototype.updateStructureBuffers;

applyDeepslatePatches({ releaseQuadsAfterUpload: false, fastPartialChunkUpdate: true });

const SIZE = 16;
const CHUNK_SIZE = 8;
const CHUNK_SIZE_VEC: [number, number, number] = [CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE];
const STRUCTURE_SIZE: [number, number, number] = [SIZE, SIZE, SIZE];

const resources = createMockResources();

interface Built {
  structure: Structure;
  cb: ChunkBuilder;
  buffers: ReturnType<typeof createMockGl>["buffers"];
}

function build(structure: Structure): Built {
  const { gl, buffers } = createMockGl();
  return { structure, cb: new ChunkBuilder(gl, structure, resources, CHUNK_SIZE), buffers };
}

/** 決定的に選んだ「実在するブロック座標」を n 個返す */
function pickPositions(
  structure: Structure,
  n: number,
  filter?: (pos: readonly [number, number, number]) => boolean,
): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let x = 0; x < SIZE && out.length < n; x++) {
    for (let y = 0; y < SIZE && out.length < n; y++) {
      for (let z = 0; z < SIZE && out.length < n; z++) {
        const pos: [number, number, number] = [x, y, z];
        if (!storedBlockAt(structure, pos)) continue;
        if (filter && !filter(pos)) continue;
        out.push(pos);
      }
    }
  }
  return out;
}

beforeEach(() => {
  applyDeepslatePatches({ releaseQuadsAfterUpload: false, fastPartialChunkUpdate: true });
});

describe("(e) fastPartialChunkUpdate", () => {
  it("fixture: 複数チャンク・半透明・不透明が混在している (テスト自体の健全性)", () => {
    const { cb, buffers } = build(buildFixtureStructure(SIZE));
    const sets = chunkQuadSets(cb, buffers);
    expect(sets.size).toBeGreaterThan(8);
    expect([...sets.keys()].some((k) => k.endsWith("transparent"))).toBe(true);
    expect([...sets.keys()].some((k) => k.endsWith("opaque"))).toBe(true);
  });

  it("(1) chunkPositions 未指定の全再構築はパッチの有無で完全に一致する", () => {
    applyDeepslatePatches({ fastPartialChunkUpdate: false });
    const off = build(buildFixtureStructure(SIZE));
    applyDeepslatePatches({ fastPartialChunkUpdate: true });
    const on = build(buildFixtureStructure(SIZE));
    expect(
      diffChunkQuadSets(chunkQuadSets(on.cb, on.buffers), chunkQuadSets(off.cb, off.buffers)),
    ).toBeNull();
  });

  it("(1) 全再構築は素の deepslate 実装に委譲される (fastPartialChunkUpdate=true でも)", () => {
    const fast = build(buildFixtureStructure(SIZE));
    const reference = build(buildFixtureStructure(SIZE));
    // 素の実装で明示的に全再構築し直す
    originalUpdateStructureBuffers.call(reference.cb, undefined);
    fast.cb.updateStructureBuffers();
    expect(
      diffChunkQuadSets(
        chunkQuadSets(fast.cb, fast.buffers),
        chunkQuadSets(reference.cb, reference.buffers),
      ),
    ).toBeNull();
  });

  it("(2) chunkPositions 指定時の出力が素の deepslate 実装と一致する", () => {
    const fast = build(buildFixtureStructure(SIZE));
    const reference = build(buildFixtureStructure(SIZE));

    // チャンク内部・チャンク境界・チャンク角をまたぐ位置を削除する (重複は除く)
    const seen = new Set<string>();
    const targets: [number, number, number][] = [
      ...pickPositions(fast.structure, 3, (p) => p[0] % CHUNK_SIZE === 0),
      ...pickPositions(fast.structure, 3, (p) => p[0] % CHUNK_SIZE === 4),
      ...pickPositions(
        fast.structure,
        2,
        (p) => p[0] % CHUNK_SIZE === 0 && p[1] % CHUNK_SIZE === 0 && p[2] % CHUNK_SIZE === 0,
      ),
    ].filter((p) => {
      const key = p.join(",");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    expect(targets.length).toBeGreaterThan(4);

    for (const pos of targets) {
      expect(removeStoredBlock(fast.structure, pos)).not.toBeNull();
      expect(removeStoredBlock(reference.structure, pos)).not.toBeNull();
    }
    const dirty = dirtyChunksFor(targets, CHUNK_SIZE_VEC, STRUCTURE_SIZE) as unknown as vec3[];

    fast.cb.updateStructureBuffers(dirty);
    originalUpdateStructureBuffers.call(reference.cb, dirty);

    expect(
      diffChunkQuadSets(
        chunkQuadSets(fast.cb, fast.buffers),
        chunkQuadSets(reference.cb, reference.buffers),
      ),
    ).toBeNull();
  });

  it("(3) 部分更新の結果が同じ最終状態の full 再構築と一致する", () => {
    const fast = build(buildFixtureStructure(SIZE));
    const targets = pickPositions(fast.structure, 6, (p) => p[0] % CHUNK_SIZE === 0);
    for (const pos of targets) removeStoredBlock(fast.structure, pos);
    fast.cb.updateStructureBuffers(
      dirtyChunksFor(targets, CHUNK_SIZE_VEC, STRUCTURE_SIZE) as unknown as vec3[],
    );

    // 同じ最終状態を最初から構築したもの
    const rebuiltStructure = buildFixtureStructure(SIZE);
    for (const pos of targets) removeStoredBlock(rebuiltStructure, pos);
    const rebuilt = build(rebuiltStructure);

    expect(
      diffChunkQuadSets(
        chunkQuadSets(fast.cb, fast.buffers),
        chunkQuadSets(rebuilt.cb, rebuilt.buffers),
      ),
    ).toBeNull();
  });

  it("(4) releaseQuadsAfterUpload 併用時も部分更新が正しく再構築される", () => {
    applyDeepslatePatches({ releaseQuadsAfterUpload: true, fastPartialChunkUpdate: true });
    try {
      const fast = build(buildFixtureStructure(SIZE));
      // 解放済み (CPU 側 quads が空) であることを確認してから部分更新する
      expect(fast.cb.getMeshes().every((m) => m.quads.length === 0)).toBe(true);

      const targets = pickPositions(fast.structure, 5, (p) => p[0] % CHUNK_SIZE === 0);
      for (const pos of targets) removeStoredBlock(fast.structure, pos);
      fast.cb.updateStructureBuffers(
        dirtyChunksFor(targets, CHUNK_SIZE_VEC, STRUCTURE_SIZE) as unknown as vec3[],
      );

      const rebuiltStructure = buildFixtureStructure(SIZE);
      for (const pos of targets) removeStoredBlock(rebuiltStructure, pos);
      const rebuilt = build(rebuiltStructure);

      expect(
        diffChunkQuadSets(
          chunkQuadSets(fast.cb, fast.buffers),
          chunkQuadSets(rebuilt.cb, rebuilt.buffers),
        ),
      ).toBeNull();
    } finally {
      applyDeepslatePatches({ releaseQuadsAfterUpload: false });
    }
  });

  it("構造体の範囲外チャンクを渡しても空チャンクを積まずに済む (クランプ)", () => {
    const { cb } = build(buildFixtureStructure(SIZE));
    const before = cb.getMeshes().length;
    // 範囲外のチャンク座標。getChunk が空チャンクを作るが quad は増えない
    cb.updateStructureBuffers([[9, 9, 9]] as unknown as vec3[]);
    expect(cb.getMeshes().length).toBe(before);
  });

  it("空の chunkPositions は何もしない", () => {
    const { cb, buffers } = build(buildFixtureStructure(SIZE));
    const before = chunkQuadSets(cb, buffers);
    cb.updateStructureBuffers([]);
    expect(diffChunkQuadSets(chunkQuadSets(cb, buffers), before)).toBeNull();
  });

  it("チャンクが空になったら quad が消える", () => {
    const structure = new Structure([SIZE, SIZE, SIZE]);
    structure.addBlock([0, 0, 0], "minecraft:stone");
    const { cb, buffers } = build(structure);
    expect(chunkQuadSets(cb, buffers).size).toBe(1);
    removeStoredBlock(structure, [0, 0, 0]);
    cb.updateStructureBuffers([[0, 0, 0]] as unknown as vec3[]);
    expect(chunkQuadSets(cb, buffers).size).toBe(0);
    expect(cb.getMeshes().length).toBe(0);
  });
});
