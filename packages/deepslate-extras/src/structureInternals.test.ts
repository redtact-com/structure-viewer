// deepslate `Structure` の**内部表現の前提**を直接 assert するテスト。
//
// removeStoredBlock / addStoredBlock / splitStructure は private フィールド
// (palette / blocks / blocksMap) を直接読み書きしている。deepslate のマイナー更新で
// 内部表現が変わったとき、描画結果の微妙なズレとしてではなく **このファイルが最初に赤くなる**
// ように、前提を 1 つずつ独立した it に分けて書いてある。
//
// 落ちたときの読み方: どの前提が崩れたかがテスト名でわかるので、
// splitStructure.ts の該当ヘルパを新しい内部表現に合わせて直す。
import { describe, expect, it } from "vitest";
import { Structure } from "deepslate/core";
import { BlockState } from "deepslate/core";

import {
  addStoredBlock,
  dirtyChunksFor,
  removeStoredBlock,
  sortStructureBlocks,
  storedBlockAt,
  structureBlocksSorted,
  structureInternals,
  type StoredBlock,
} from "./splitStructure";

const SIZE: [number, number, number] = [4, 5, 6];

function flatIndex(pos: readonly number[], size: readonly number[]) {
  return pos[0] * size[1] * size[2] + pos[1] * size[2] + pos[2];
}

function buildStructure(): Structure {
  const s = new Structure(SIZE);
  s.addBlock([0, 0, 0], "minecraft:stone");
  s.addBlock([1, 2, 3], "minecraft:planks");
  s.addBlock([3, 4, 5], "minecraft:stone");
  s.addBlock([2, 0, 1], "minecraft:glassy", { lit: "false" });
  return s;
}

describe("deepslate Structure の内部表現の前提", () => {
  it("private フィールド名は palette / blocks / blocksMap である", () => {
    const internal = structureInternals(buildStructure()) as unknown as Record<string, unknown>;
    expect(Array.isArray(internal.palette)).toBe(true);
    expect(Array.isArray(internal.blocks)).toBe(true);
    expect(Array.isArray(internal.blocksMap)).toBe(true);
  });

  it("palette は BlockState の配列で、同一 state は 1 エントリに畳まれる", () => {
    const { palette, blocks } = structureInternals(buildStructure());
    expect(palette.every((s) => s instanceof BlockState)).toBe(true);
    // stone が 2 個あるが palette は stone/planks/glassy の 3 種
    expect(palette.length).toBe(3);
    const stone = blocks.filter((b) => palette[b.state].getName().toString() === "minecraft:stone");
    expect(stone.length).toBe(2);
    expect(stone[0].state).toBe(stone[1].state);
  });

  it("blocks の要素は { pos, state: palette index, nbt? } である", () => {
    const { blocks, palette } = structureInternals(buildStructure());
    for (const block of blocks) {
      expect(block.pos.length).toBe(3);
      expect(typeof block.state).toBe("number");
      expect(palette[block.state]).toBeInstanceOf(BlockState);
    }
  });

  it("blocksMap のキーは x*sy*sz + y*sz + z の平坦化 index である", () => {
    const { blocksMap } = structureInternals(buildStructure());
    const block = blocksMap[flatIndex([1, 2, 3], SIZE)];
    expect(block).toBeDefined();
    expect(block!.pos).toEqual([1, 2, 3]);
  });

  it("getBlock は blocksMap しか見ない (blocks から消しただけでは消えない)", () => {
    const s = buildStructure();
    const internal = structureInternals(s);
    internal.blocks = internal.blocks.filter((b) => flatIndex(b.pos, SIZE) !== flatIndex([1, 2, 3], SIZE));
    expect(s.getBlock([1, 2, 3])).not.toBeNull();
    delete internal.blocksMap[flatIndex([1, 2, 3], SIZE)];
    expect(s.getBlock([1, 2, 3])).toBeNull();
  });

  it("getBlocks は blocks しか見ない (blocksMap から消しただけでは消えない)", () => {
    const s = buildStructure();
    const internal = structureInternals(s);
    delete internal.blocksMap[flatIndex([1, 2, 3], SIZE)];
    expect(s.getBlocks().some((b) => b.pos.join(",") === "1,2,3")).toBe(true);
  });

  it("constructor(size, palette, blocks) は blocks の要素をそのまま blocksMap にも入れる", () => {
    const source = structureInternals(buildStructure());
    const copy = new Structure(SIZE, source.palette.slice(), source.blocks.slice());
    const internal = structureInternals(copy);
    for (const block of internal.blocks) {
      expect(internal.blocksMap[flatIndex(block.pos, SIZE)]).toBe(block);
    }
  });

  it("【要注意】addBlock は blocks と blocksMap に *別オブジェクト* を入れる", () => {
    // この非対称性のせいで「blocksMap から引いた StoredBlock を blocks から
    // indexOf で探す」実装は動かない。removeStoredBlock は座標で引いている。
    const s = new Structure(SIZE);
    s.addBlock([1, 1, 1], "minecraft:stone");
    const { blocks, blocksMap } = structureInternals(s);
    expect(blocksMap[flatIndex([1, 1, 1], SIZE)]).toEqual(blocks[0]);
    expect(blocksMap[flatIndex([1, 1, 1], SIZE)]).not.toBe(blocks[0]);
  });

  it("構造体サイズ外の座標を持つ blocks で構築すると throw する", () => {
    const source = structureInternals(buildStructure());
    expect(
      () =>
        new Structure(SIZE, source.palette.slice(), [
          { pos: [99, 0, 0], state: 0 } as unknown as StoredBlock,
        ]),
    ).toThrow();
  });
});

describe("storedBlockAt", () => {
  it("PlacedBlock ではなく内部の StoredBlock (palette index 付き) を返す", () => {
    const s = buildStructure();
    const stored = storedBlockAt(s, [1, 2, 3]);
    expect(stored).not.toBeNull();
    expect(typeof stored!.state).toBe("number");
  });

  it("空き座標・範囲外座標では null", () => {
    const s = buildStructure();
    expect(storedBlockAt(s, [0, 0, 1])).toBeNull();
    expect(storedBlockAt(s, [-1, 0, 0])).toBeNull();
    expect(storedBlockAt(s, [4, 0, 0])).toBeNull();
  });
});

describe("removeStoredBlock / addStoredBlock", () => {
  it("remove 後も getBlock と getBlocks が一致する", () => {
    const s = buildStructure();
    const removed = removeStoredBlock(s, [0, 0, 0]);
    expect(removed).not.toBeNull();
    expect(s.getBlock([0, 0, 0])).toBeNull();
    const keys = s.getBlocks().map((b) => b.pos.join(","));
    expect(keys).not.toContain("0,0,0");
    expect(keys.length).toBe(3);
    // 残り 3 個はすべて getBlock からも引ける
    for (const key of keys) {
      const pos = key.split(",").map(Number) as [number, number, number];
      expect(s.getBlock(pos)).not.toBeNull();
    }
  });

  it("複数個を連続で remove しても blocks / blocksMap が整合する", () => {
    const s = buildStructure();
    for (const pos of [
      [0, 0, 0],
      [3, 4, 5],
      [1, 2, 3],
    ] as [number, number, number][]) {
      expect(removeStoredBlock(s, pos)).not.toBeNull();
      expect(s.getBlock(pos)).toBeNull();
    }
    expect(s.getBlocks().map((b) => b.pos.join(","))).toEqual(["2,0,1"]);
  });

  it("存在しない座標・範囲外座標では null を返し、何も壊さない", () => {
    const s = buildStructure();
    expect(removeStoredBlock(s, [0, 0, 1])).toBeNull();
    expect(removeStoredBlock(s, [-1, 0, 0])).toBeNull();
    expect(removeStoredBlock(s, [99, 99, 99])).toBeNull();
    expect(s.getBlocks().length).toBe(4);
  });

  it("palette を共有する別構造体へ移しても palette index が変わらない", () => {
    const source = buildStructure();
    const internal = structureInternals(source);
    const target = new Structure(SIZE, internal.palette.slice(), []);

    const stored = removeStoredBlock(source, [1, 2, 3])!;
    const stateIndex = stored.state;
    addStoredBlock(target, stored);

    expect(stored.state).toBe(stateIndex);
    expect(target.getBlock([1, 2, 3])!.state.getName().toString()).toBe("minecraft:planks");
    expect(structureInternals(target).blocks[0].state).toBe(stateIndex);
  });

  it("往復 (remove → add → remove → add) で元の状態に戻る", () => {
    const a = buildStructure();
    const internal = structureInternals(a);
    const b = new Structure(SIZE, internal.palette.slice(), []);
    const before = a
      .getBlocks()
      .map((x) => x.pos.join(","))
      .sort();

    const stored = removeStoredBlock(a, [2, 0, 1])!;
    addStoredBlock(b, stored);
    expect(b.getBlocks().length).toBe(1);
    const back = removeStoredBlock(b, [2, 0, 1])!;
    addStoredBlock(a, back);

    expect(b.getBlocks().length).toBe(0);
    expect(
      a
        .getBlocks()
        .map((x) => x.pos.join(","))
        .sort(),
    ).toEqual(before);
    expect(a.getBlock([2, 0, 1])).not.toBeNull();
  });

  it("nbt 付きブロックも nbt を保ったまま移動する", () => {
    const s = new Structure(SIZE);
    s.addBlock([0, 0, 0], "minecraft:chest", {}, { marker: 1 } as never);
    const target = new Structure(SIZE, structureInternals(s).palette.slice(), []);
    const stored = removeStoredBlock(s, [0, 0, 0])!;
    expect(stored.nbt).toBeDefined();
    addStoredBlock(target, stored);
    expect(target.getBlock([0, 0, 0])!.nbt).toBe(stored.nbt);
  });

  it("addStoredBlock は範囲外座標で throw する", () => {
    const s = buildStructure();
    expect(() => addStoredBlock(s, { pos: [99, 0, 0], state: 0 })).toThrow();
  });

  it("blocks が昇順でない構造体でも正しく remove / add できる (線形フォールバック)", () => {
    // 二分探索は昇順前提なので、非昇順の構造体では線形走査に落ちる必要がある
    const s = new Structure(SIZE);
    s.addBlock([3, 4, 5], "minecraft:stone");
    s.addBlock([0, 0, 0], "minecraft:stone");
    s.addBlock([1, 2, 3], "minecraft:planks");
    expect(structureBlocksSorted(s)).toBe(false);

    const removed = removeStoredBlock(s, [0, 0, 0]);
    expect(removed).not.toBeNull();
    expect(s.getBlock([0, 0, 0])).toBeNull();
    expect(s.getBlocks().map((b) => b.pos.join(","))).toEqual(["3,4,5", "1,2,3"]);

    addStoredBlock(s, removed!);
    expect(s.getBlock([0, 0, 0])).not.toBeNull();
    expect(s.getBlocks().length).toBe(3);
  });

  it("sortStructureBlocks 後は昇順が維持され、remove/add でも崩れない", () => {
    const s = new Structure(SIZE);
    s.addBlock([3, 4, 5], "minecraft:stone");
    s.addBlock([0, 0, 0], "minecraft:stone");
    s.addBlock([1, 2, 3], "minecraft:planks");
    expect(sortStructureBlocks(s)).toBe(true);
    expect(structureInternals(s).blocks.map((b) => b.pos.join(","))).toEqual([
      "0,0,0",
      "1,2,3",
      "3,4,5",
    ]);
    const removed = removeStoredBlock(s, [1, 2, 3])!;
    expect(structureBlocksSorted(s)).toBe(true);
    addStoredBlock(s, removed);
    expect(structureBlocksSorted(s)).toBe(true);
    expect(structureInternals(s).blocks.map((b) => b.pos.join(","))).toEqual([
      "0,0,0",
      "1,2,3",
      "3,4,5",
    ]);
  });

  it("addBlock で作った構造体 (blocks/blocksMap が別オブジェクト) でも正しく remove できる", () => {
    // 座標キーではなくオブジェクト同一性で探す実装だと、ここで blocks 側に
    // ゴミが残り getBlocks() だけにブロックが残る (= 消したはずの面が描画される)
    const s = new Structure(SIZE);
    s.addBlock([1, 1, 1], "minecraft:stone");
    expect(removeStoredBlock(s, [1, 1, 1])).not.toBeNull();
    expect(s.getBlock([1, 1, 1])).toBeNull();
    expect(s.getBlocks().length).toBe(0);
  });
});

describe("dirtyChunksFor", () => {
  const CS: [number, number, number] = [8, 8, 8];
  const BIG: [number, number, number] = [32, 32, 32];
  const sortKeys = (chunks: [number, number, number][]) => chunks.map((c) => c.join(",")).sort();

  it("チャンク中央の 1 座標なら自チャンクだけ", () => {
    expect(sortKeys(dirtyChunksFor([[4, 4, 4]], CS, BIG))).toEqual(["0,0,0"]);
  });

  it("チャンク境界 (x%8===0) なら X 方向の隣チャンクも含む", () => {
    expect(sortKeys(dirtyChunksFor([[8, 4, 4]], CS, BIG))).toEqual(["0,0,0", "1,0,0"]);
  });

  it("チャンク角なら 3 方向すべての隣チャンクを含む (計 4 チャンク)", () => {
    expect(sortKeys(dirtyChunksFor([[8, 8, 8]], CS, BIG))).toEqual([
      "0,1,1",
      "1,0,1",
      "1,1,0",
      "1,1,1",
    ]);
  });

  it("構造体の端では範囲外に出た近傍を捨てる (空チャンクを作らない)", () => {
    expect(sortKeys(dirtyChunksFor([[0, 0, 0]], CS, BIG))).toEqual(["0,0,0"]);
    expect(sortKeys(dirtyChunksFor([[31, 31, 31]], CS, BIG))).toEqual(["3,3,3"]);
  });

  it("負のチャンク座標は生成されない", () => {
    for (const chunk of dirtyChunksFor([[0, 0, 0]], CS, BIG)) {
      expect(chunk.every((v) => v >= 0)).toBe(true);
    }
  });

  it("構造体サイズ外の座標は無視される", () => {
    expect(dirtyChunksFor([[100, 100, 100]], CS, BIG)).toEqual([]);
    expect(sortKeys(dirtyChunksFor([[-1, 0, 0]], CS, BIG))).toEqual(["0,0,0"]);
  });

  it("複数座標で重複するチャンクは 1 個にまとまる", () => {
    const chunks = dirtyChunksFor(
      [
        [4, 4, 4],
        [5, 5, 5],
        [6, 6, 6],
      ],
      CS,
      BIG,
    );
    expect(chunks.length).toBe(1);
  });

  it("チャンクサイズが構造体サイズを割り切らなくても末端チャンクを返す", () => {
    const odd: [number, number, number] = [10, 10, 10];
    expect(sortKeys(dirtyChunksFor([[9, 9, 9]], CS, odd))).toEqual(["1,1,1"]);
  });

  it("非等方チャンクサイズ ([x,y,z] が異なる) でも軸ごとに正しく割る", () => {
    // 自 (0,1,2) / y-1=3 → (0,0,2) / z-1=3 → (0,1,1)。x±1 は同一チャンク
    expect(sortKeys(dirtyChunksFor([[4, 4, 4]], [8, 4, 2], BIG))).toEqual([
      "0,0,2",
      "0,1,1",
      "0,1,2",
    ]);
  });
});
