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
import type { BlockPos, StructureProvider } from "deepslate/core";
import { ChunkBuilder, Mesh } from "deepslate/render";
import type { Resources } from "deepslate/render";
import type { vec3 } from "gl-matrix";

import { applyDeepslatePatches } from "./deepslatePatches";
import { dirtyChunksFor, removeStoredBlock, storedBlockAt } from "./splitStructure";
import {
  FIXTURE_NAMES,
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

  // ── 走査範囲のエッジケース (issue のレビューで追加) ──

  describe("チャンクサイズと構造サイズの組み合わせ", () => {
    /** 任意サイズ・任意チャンクサイズで「部分更新 == 素の実装」を確認する */
    function expectPartialMatchesStock(
      structureSize: [number, number, number],
      chunkSize: number | [number, number, number],
    ) {
      const make = () => {
        const s = new Structure(structureSize);
        let i = 0;
        for (let x = 0; x < structureSize[0]; x++) {
          for (let y = 0; y < structureSize[1]; y++) {
            for (let z = 0; z < structureSize[2]; z++) {
              if ((x * 7 + y * 13 + z * 17) % 3 === 0) continue;
              s.addBlock([x, y, z], FIXTURE_NAMES[i++ % FIXTURE_NAMES.length]);
            }
          }
        }
        return s;
      };
      const buildWith = (structure: Structure) => {
        const { gl, buffers } = createMockGl();
        return { structure, cb: new ChunkBuilder(gl, structure, resources, chunkSize), buffers };
      };
      const cs = typeof chunkSize === "number" ? [chunkSize, chunkSize, chunkSize] : chunkSize;
      const fast = buildWith(make());
      const reference = buildWith(make());

      // 構造体の端 (クランプが効く場所) を含む座標を落とす
      const candidates: [number, number, number][] = [
        [0, 0, 0],
        [structureSize[0] - 1, structureSize[1] - 1, structureSize[2] - 1],
        [Math.min(cs[0], structureSize[0] - 1), 0, 0],
      ];
      const targets = candidates.filter((pos) => storedBlockAt(fast.structure, pos));
      expect(targets.length).toBeGreaterThan(0);
      for (const pos of targets) {
        removeStoredBlock(fast.structure, pos);
        removeStoredBlock(reference.structure, pos);
      }
      const dirty = dirtyChunksFor(
        targets,
        cs as [number, number, number],
        structureSize,
      ) as unknown as vec3[];
      fast.cb.updateStructureBuffers(dirty);
      originalUpdateStructureBuffers.call(reference.cb, dirty);
      expect(
        diffChunkQuadSets(
          chunkQuadSets(fast.cb, fast.buffers),
          chunkQuadSets(reference.cb, reference.buffers),
        ),
      ).toBeNull();
    }

    it("チャンクサイズが構造サイズを割り切らない (13x7x21 / cs=8)", () => {
      expectPartialMatchesStock([13, 7, 21], 8);
    });

    it("構造体が 1 チャンクより薄い (17x3x5 / cs=16)", () => {
      expectPartialMatchesStock([17, 3, 5], 16);
    });

    it("非等方チャンクサイズ (9x9x9 / cs=[4,8,16])", () => {
      expectPartialMatchesStock([9, 9, 9], [4, 8, 16]);
    });

    it("チャンクサイズ 1 (2x2x2 / cs=1)", () => {
      expectPartialMatchesStock([2, 2, 2], 1);
    });
  });

  it("Structure 以外の StructureProvider には適用せず素の実装に委譲する", () => {
    // 0 起点でない provider は座標総当りでは拾えない。素の実装は getBlocks() を
    // 全走査するので拾える。型で分岐して安全側に倒していることを確認する。
    const blocks = [
      { pos: [-2, 0, 0] as BlockPos, name: "minecraft:stone" },
      { pos: [1, 0, 0] as BlockPos, name: "minecraft:stone" },
    ];
    const backing = new Structure([4, 4, 4]);
    backing.addBlock([0, 0, 0], "minecraft:stone");
    const state = backing.getBlock([0, 0, 0])!.state;
    const provider: StructureProvider = {
      getSize: () => [4, 4, 4] as BlockPos,
      getBlocks: () => blocks.map((b) => ({ pos: b.pos, state })),
      getBlock: (pos: BlockPos) => {
        const hit = blocks.find(
          (b) => b.pos[0] === pos[0] && b.pos[1] === pos[1] && b.pos[2] === pos[2],
        );
        return hit ? { pos: hit.pos, state } : null;
      },
    };
    const { gl, buffers } = createMockGl();
    const cb = new ChunkBuilder(gl, provider, resources, 2);
    cb.updateStructureBuffers([
      [-1, 0, 0],
      [0, 0, 0],
    ] as unknown as vec3[]);
    const chunks = [...chunkQuadSets(cb, buffers).keys()];
    // 負チャンク (getChunk の符号エンコードで x=3) が残っていること
    expect(chunks.some((k) => k.startsWith("3,0,0"))).toBe(true);
    expect(chunks.some((k) => k.startsWith("0,0,0"))).toBe(true);
  });

  it("設定は prototype 上の共有オブジェクトに置かれる (ESM/CJS 二重インスタンス対策)", () => {
    // モジュールのコピーが 2 つあると、後から applyDeepslatePatches を呼んだ側の
    // 指定が prototype に載っている側に届かない。設定を prototype 上に置くことで
    // 「どのコピーから設定しても効く」ことを、外部から直接書き換えて確認する。
    const config = (Mesh.prototype as unknown as Record<string, { fastPartialChunkUpdate: boolean }>)
      .__redtactDeepslateConfig;
    expect(config).toBeDefined();

    const structure = buildFixtureStructure(SIZE);
    let getBlocksCalls = 0;
    const originalGetBlocks = structure.getBlocks.bind(structure);
    structure.getBlocks = () => {
      getBlocksCalls++;
      return originalGetBlocks();
    };
    const { gl } = createMockGl();
    const cb = new ChunkBuilder(gl, structure, resources, CHUNK_SIZE);

    // 高速経路は getBlocks を呼ばない
    getBlocksCalls = 0;
    cb.updateStructureBuffers([[0, 0, 0]] as unknown as vec3[]);
    expect(getBlocksCalls).toBe(0);

    // 共有オブジェクトを直接書き換えると素の経路に戻る (= 別コピーからの設定も効く)
    config.fastPartialChunkUpdate = false;
    try {
      cb.updateStructureBuffers([[0, 0, 0]] as unknown as vec3[]);
      expect(getBlocksCalls).toBeGreaterThan(0);
    } finally {
      config.fastPartialChunkUpdate = true;
    }
  });
});
