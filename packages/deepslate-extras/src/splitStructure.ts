import { Structure } from "deepslate/core";
import type { BlockState } from "deepslate/core";
import type { NbtCompound } from "deepslate/nbt";

// deepslate Structure の private palette/blocks を直接読むための内部型。
// addBlock は palette.findIndex を毎ブロック実行して O(N·P) になるため、
// 分割・スライスは palette を共有した constructor(size, palette, blocks) で直接構築する。
export interface StoredBlock {
  pos: [number, number, number];
  state: number;
  nbt?: NbtCompound;
}

export interface StructureInternal {
  palette: BlockState[];
  blocks: StoredBlock[];
  /**
   * 座標を平坦化した index (`x*sy*sz + y*sz + z`) をキーにした疎配列。
   * `getBlock` はこちらしか見ないため、`blocks` と両方を整合させて更新する必要がある。
   */
  blocksMap: (StoredBlock | undefined)[];
}

/** Structure の内部 palette/blocks/blocksMap を読み出す (palette 単位の前計算・直接構築用)。 */
export function structureInternals(structure: Structure): StructureInternal {
  return structure as unknown as StructureInternal;
}

// ── in-place 差分ヘルパ ────────────────────────────────────────────────
//
// ピック 1 個で Structure を作り直すと O(N) かかるので、inner/outer 間で
// StoredBlock を「移す」だけの操作を提供する。palette は splitStructure /
// splitStructureCropped が slice() で切り離した同一内容のコピーなので、
// palette index はそのまま持ち回れる (再解決不要)。

/** 平坦化 index。Structure.getBlock / constructor と同一の式 */
function flatIndex(pos: readonly number[], size: readonly number[]): number {
  return pos[0] * size[1] * size[2] + pos[1] * size[2] + pos[2];
}

function isInside(pos: readonly number[], size: readonly number[]): boolean {
  return (
    pos[0] >= 0 &&
    pos[0] < size[0] &&
    pos[1] >= 0 &&
    pos[1] < size[1] &&
    pos[2] >= 0 &&
    pos[2] < size[2]
  );
}

/**
 * 平坦化 index → `blocks` 配列内の位置。
 *
 * これが無いと remove ごとに `blocks` の線形走査が入り、ドラッグ確定
 * (数千ブロック) が O(N·M) になる。オブジェクト同一性ではなく座標で引くのは
 * deepslate の `Structure.addBlock` が `blocks` と `blocksMap` に
 * **別々のオブジェクトリテラル**を入れるため (constructor 経路は同一オブジェクト)。
 * キャッシュが配列と食い違っていた場合は線形走査にフォールバックするので、
 * 外部から blocks を直接いじられても壊れない。
 */
const blockPositionCache = new WeakMap<Structure, Map<number, number>>();

function positionCacheFor(
  structure: Structure,
  blocks: StoredBlock[],
  size: readonly number[],
): Map<number, number> {
  let cache = blockPositionCache.get(structure);
  if (!cache) {
    cache = new Map();
    for (let i = 0; i < blocks.length; i++) cache.set(flatIndex(blocks[i].pos, size), i);
    blockPositionCache.set(structure, cache);
  }
  return cache;
}

/** pos にある StoredBlock を返す (PlacedBlock を作らないので O(1) かつ非アロケート)。無ければ null */
export function storedBlockAt(
  structure: Structure,
  pos: readonly [number, number, number],
): StoredBlock | null {
  const size = structure.getSize();
  if (!isInside(pos, size)) return null;
  return structureInternals(structure).blocksMap[flatIndex(pos, size)] ?? null;
}

/**
 * pos のブロックを構造体から取り除いて返す (無ければ null)。
 * `blocks` は swap-remove するため配列順が変わる (チャンク内 quad の並びが変わるだけで
 * 描画結果は不変。deepslate はチャンク内をソートしていない)。
 *
 * 前提: 同一座標に複数の StoredBlock が登録されていないこと (blocksMap は
 * 最後の 1 個しか指さないため、重複があると getBlock と getBlocks が乖離する)。
 * サーバ正規化済みの Java Structure NBT では発生しない。
 */
export function removeStoredBlock(
  structure: Structure,
  pos: readonly [number, number, number],
): StoredBlock | null {
  const size = structure.getSize();
  if (!isInside(pos, size)) return null;
  const internal = structureInternals(structure);
  const index = flatIndex(pos, size);
  const stored = internal.blocksMap[index];
  if (!stored) return null;
  delete internal.blocksMap[index];

  const blocks = internal.blocks;
  const cache = positionCacheFor(structure, blocks, size);
  let at = cache.get(index);
  if (at === undefined || !blocks[at] || flatIndex(blocks[at].pos, size) !== index) {
    at = blocks.findIndex((b) => flatIndex(b.pos, size) === index);
  }
  cache.delete(index);
  if (at < 0) return stored;

  const removed = blocks[at];
  const last = blocks[blocks.length - 1];
  blocks[at] = last;
  blocks.pop();
  if (last !== removed) cache.set(flatIndex(last.pos, size), at);
  return removed;
}

/**
 * StoredBlock を palette index そのままで追加する。
 * removeStoredBlock で取り出したものを、palette を共有する別の構造体
 * (splitStructure の inner/outer) へ移すために使う。
 */
export function addStoredBlock(structure: Structure, block: StoredBlock): void {
  const size = structure.getSize();
  if (!isInside(block.pos, size)) {
    throw new Error(`Cannot add block at ${block.pos} outside the structure bounds ${size}`);
  }
  const internal = structureInternals(structure);
  const index = flatIndex(block.pos, size);
  internal.blocks.push(block);
  internal.blocksMap[index] = block;
  blockPositionCache.get(structure)?.set(index, internal.blocks.length - 1);
}

/** 自身 + 6 近傍。needsCull が隣接ブロックを見るため近傍チャンクも dirty になる */
const NEIGHBOR_OFFSETS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * 変更した座標群から、再メッシュが必要なチャンク座標の集合を求める。
 *
 * 変更ブロック自身のチャンクだけでは足りない: `needsCull` は隣接ブロックの
 * opaque 判定を見るので、チャンク境界のブロックを足し引きすると
 * **隣のチャンク側の面**が復活/消滅する。6 近傍を含めないと
 * 「消したはずのブロックの面が残る」視覚バグになる (incrementalSplit.test.ts の回帰テスト参照)。
 *
 * 構造体の範囲外に出た近傍座標は捨てる。範囲外チャンクを渡すと
 * ChunkBuilder.getChunk が空チャンクを遅延生成して chunks 配列が肥大するため。
 */
export function dirtyChunksFor(
  positions: Iterable<readonly [number, number, number]>,
  chunkSize: readonly [number, number, number],
  size: readonly [number, number, number],
): [number, number, number][] {
  const out = new Map<string, [number, number, number]>();
  for (const pos of positions) {
    for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
      const x = pos[0] + dx;
      const y = pos[1] + dy;
      const z = pos[2] + dz;
      if (!isInside([x, y, z], size)) continue;
      const chunk: [number, number, number] = [
        Math.floor(x / chunkSize[0]),
        Math.floor(y / chunkSize[1]),
        Math.floor(z / chunkSize[2]),
      ];
      out.set(`${chunk[0]},${chunk[1]},${chunk[2]}`, chunk);
    }
  }
  return [...out.values()];
}

/** 選択範囲（両端を含む直方体、ブロック座標） */
export interface Region {
  start: [number, number, number];
  end: [number, number, number];
}

/**
 * 1 つの選択条件。region と materials は AND で組み合わせる。
 * - region: null なら位置の制限なし
 * - materials: null なら材料の制限なし。配列ならそのブロック ID のみ選択
 */
export interface SelectionSpec {
  region: Region | null;
  materials: string[] | null;
  /** ブロック座標を直接指定（"x,y,z" 形式）。非空の場合は region/materials より優先（ピックモード） */
  positions?: string[] | null;
  /** 枠線・トグルの色 index（省略時は specs 配列の位置） */
  colorIndex?: number;
}

/** 埋め込みプレビュー用: 範囲外は描画せず、範囲内の材料除外分だけフェードする */
export interface CropSpec {
  region: Region;
  materials: string[] | null;
  /** ピック座標 ("x,y,z")。非空なら範囲(region)へズームしつつ、この座標集合だけを inner にする */
  positions?: string[] | null;
}

/** "piston" → "minecraft:piston" のように namespace を補完する */
export function normalizeBlockId(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}

/** start/end の大小関係を正規化し、構造体サイズ内にクランプした inclusive な min/max を返す */
export function normalizeRegion(region: Region, size: [number, number, number]) {
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const a = Math.min(region.start[i], region.end[i]);
    const b = Math.max(region.start[i], region.end[i]);
    min[i] = Math.max(0, Math.min(a, size[i] - 1));
    max[i] = Math.max(0, Math.min(b, size[i] - 1));
  }
  return { min, max };
}

function contains(min: number[], max: number[], pos: readonly number[]) {
  return (
    pos[0] >= min[0] &&
    pos[0] <= max[0] &&
    pos[1] >= min[1] &&
    pos[1] <= max[1] &&
    pos[2] >= min[2] &&
    pos[2] <= max[2]
  );
}

/**
 * クロップ分割: 選択範囲外のブロックは捨て、範囲内を材料条件で
 * inner（通常描画）/ faded（半透明描画）に分ける。
 * どちらも元のサイズを保つので座標はずれない（カメラ側で範囲中心に寄せる）。
 */
export function splitStructureCropped(
  full: Structure,
  crop: CropSpec,
): { inner: Structure; faded: Structure } {
  const size = full.getSize() as [number, number, number];
  const bounds = normalizeRegion(crop.region, size);
  const materialSet = crop.materials ? new Set(crop.materials.map(normalizeBlockId)) : null;
  const positionSet = crop.positions?.length ? new Set(crop.positions) : null;

  const { palette, blocks } = structureInternals(full);
  // 材料判定は palette index 単位で前計算する (ブロック毎の getName().toString() を避ける)
  const materialMatch = materialSet
    ? palette.map((st) => materialSet.has(st.getName().toString()))
    : null;
  const innerBlocks: StoredBlock[] = [];
  const fadedBlocks: StoredBlock[] = [];
  for (const block of blocks) {
    if (!contains(bounds.min, bounds.max, block.pos)) continue;
    // positions モード: 範囲(region)へズームしつつ、ピックした座標だけを inner にする。
    const isInner = positionSet
      ? positionSet.has(`${block.pos[0]},${block.pos[1]},${block.pos[2]}`)
      : !materialMatch || materialMatch[block.state];
    (isInner ? innerBlocks : fadedBlocks).push(block);
  }
  // palette は slice で切り離す (共有すると派生側への addBlock が元 Structure に波及する)
  return {
    inner: new Structure(size, palette.slice(), innerBlocks),
    faded: new Structure(size, palette.slice(), fadedBlocks),
  };
}

/**
 * 構造体を選択条件の内側 / 外側の 2 つに分割する。
 * 複数 spec は OR（いずれかに該当すれば内側）、spec 内の region と materials は AND。
 * どちらも元と同じサイズを保つため、2 つを重ねて描画しても座標がずれない。
 */
export function splitStructure(
  full: Structure,
  specs: SelectionSpec[],
): { inner: Structure; outer: Structure } {
  const size = full.getSize() as [number, number, number];
  const { palette, blocks } = structureInternals(full);
  const matchers = specs.map((spec) => {
    const materialSet = spec.materials ? new Set(spec.materials.map(normalizeBlockId)) : null;
    return {
      bounds: spec.region ? normalizeRegion(spec.region, size) : null,
      // 材料判定は palette index 単位で前計算する (ブロック毎の getName().toString() を避ける)
      materialMatch: materialSet
        ? palette.map((st) => materialSet.has(st.getName().toString()))
        : null,
      positionSet: spec.positions?.length ? new Set(spec.positions) : null,
    };
  });
  const anyPositions = matchers.some((m) => m.positionSet);

  const innerBlocks: StoredBlock[] = [];
  const outerBlocks: StoredBlock[] = [];
  for (const block of blocks) {
    const key = anyPositions ? `${block.pos[0]},${block.pos[1]},${block.pos[2]}` : "";
    const isInner = matchers.some(({ bounds, materialMatch, positionSet }) => {
      // positions モード: 座標セットに一致するブロックのみ inner
      if (positionSet) return positionSet.has(key);
      const inRegion = !bounds || contains(bounds.min, bounds.max, block.pos);
      const inMaterial = !materialMatch || materialMatch[block.state];
      return inRegion && inMaterial;
    });
    (isInner ? innerBlocks : outerBlocks).push(block);
  }
  return {
    inner: new Structure(size, palette.slice(), innerBlocks),
    outer: new Structure(size, palette.slice(), outerBlocks),
  };
}

/** 構造体を Y の [minY, maxY] (inclusive) で絞り込んだ新しい構造体を返す (レイヤースライス用)。 */
export function filterStructureByY(structure: Structure, minY: number, maxY: number): Structure {
  const size = structure.getSize() as [number, number, number];
  if (minY <= 0 && maxY >= size[1] - 1) return structure; // 全体ならそのまま
  const { palette, blocks } = structureInternals(structure);
  const filtered = blocks.filter((b) => b.pos[1] >= minY && b.pos[1] <= maxY);
  return new Structure(size, palette.slice(), filtered);
}
