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

// ── ブロック順序の正規化 ──────────────────────────────────────────────
//
// **なぜ順序が意味を持つか**: ChunkBuilder はチャンク内の quad を「ブロックを
// 処理した順」に merge し、その並びがそのまま頂点バッファの並び = 描画順になる。
// deepslate の Renderer は BLEND を有効にしたまま描くため、over 合成が非可換な
// 半透明ブロックでは**描画順が最終ピクセルを変える**。FadeStructureRenderer は
// さらに depthMask(false) で描くので、fade レイヤーは全ブロックが順序依存になる。
//
// 全再構築 (素の deepslate) は `blocks` 配列順、部分更新 (patch (e)) は座標昇順に
// 並べるため、両者が食い違うと「ピックのたびにチャンクの色味が変わる」ちらつきになる。
// そこで **blocks を平坦化 index (= 座標 x→y→z 昇順) に正規化**し、両経路の順序を
// 一致させる。patch (e) の走査順は x→y→z なので、正規化済みなら完全に同じ並びになる。

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
 * blocks が平坦化 index の昇順に並んでいるか。
 * 結果は Structure ごとにキャッシュし、remove/add で維持する。
 */
const sortedFlag = new WeakMap<Structure, boolean>();

function computeSorted(blocks: StoredBlock[], size: readonly number[]): boolean {
  for (let i = 1; i < blocks.length; i++) {
    if (flatIndex(blocks[i - 1].pos, size) > flatIndex(blocks[i].pos, size)) return false;
  }
  return true;
}

function isSorted(structure: Structure, blocks: StoredBlock[], size: readonly number[]): boolean {
  let flag = sortedFlag.get(structure);
  if (flag === undefined) {
    flag = computeSorted(blocks, size);
    sortedFlag.set(structure, flag);
  }
  return flag;
}

/**
 * blocks を平坦化 index の昇順に並べ替える (既に昇順なら何もしない)。
 *
 * `splitStructure` / `splitStructureCropped` / `filterStructureByY` の出力は
 * 自動的に正規化されるので、通常はこれを直接呼ぶ必要はない。
 * **分割を経由せず生の Structure をレンダラに渡したうえで
 * `fastPartialChunkUpdate` の部分更新を使う場合**は、全再構築と部分更新の
 * 描画順を一致させるためにこれを一度通しておくこと。
 *
 * @returns 実際に並べ替えたら true (既に昇順なら false)
 */
export function sortStructureBlocks(structure: Structure): boolean {
  const size = structure.getSize();
  const { blocks } = structureInternals(structure);
  if (computeSorted(blocks, size)) {
    sortedFlag.set(structure, true);
    return false;
  }
  blocks.sort((a, b) => flatIndex(a.pos, size) - flatIndex(b.pos, size));
  sortedFlag.set(structure, true);
  return true;
}

/** blocks が平坦化 index 昇順に正規化済みか (テスト・診断用) */
export function structureBlocksSorted(structure: Structure): boolean {
  return computeSorted(structureInternals(structure).blocks, structure.getSize());
}

/** 分割結果を正規化して Structure を作る (入力が昇順なら sort は走らない) */
function createNormalized(
  size: [number, number, number],
  palette: BlockState[],
  blocks: StoredBlock[],
): Structure {
  if (!computeSorted(blocks, size)) {
    blocks.sort((a, b) => flatIndex(a.pos, size) - flatIndex(b.pos, size));
  }
  const structure = new Structure(size, palette, blocks);
  sortedFlag.set(structure, true);
  return structure;
}

// ── in-place 差分ヘルパ ────────────────────────────────────────────────
//
// ピック 1 個で Structure を作り直すと O(N) かかるので、inner/outer 間で
// StoredBlock を「移す」だけの操作を提供する。palette は splitStructure /
// splitStructureCropped が slice() で切り離した同一内容のコピーなので、
// palette index はそのまま持ち回れる (再解決不要)。
//
// **順序保存**: 昇順に正規化された blocks に対しては二分探索 + splice で
// 昇順を保ったまま出し入れする (131k ブロックで 1 操作あたり実測 0.01ms 未満)。
// 以前の swap-remove は O(1) だったが、削除位置に配列末尾の要素を持ってくるため
// **無関係な遠方チャンクの描画順まで変えてしまう**ので使わない。

/** 昇順配列で index の位置を返す (無ければ -1)。非昇順なら線形走査にフォールバック */
function findBlockIndex(
  blocks: StoredBlock[],
  target: number,
  size: readonly number[],
  sorted: boolean,
): number {
  if (!sorted) {
    return blocks.findIndex((b) => flatIndex(b.pos, size) === target);
  }
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const key = flatIndex(blocks[mid].pos, size);
    if (key === target) return mid;
    if (key < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** 昇順配列で target を挿入すべき位置 (最初に target より大きい要素の index) */
function findInsertIndex(
  blocks: StoredBlock[],
  target: number,
  size: readonly number[],
): number {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (flatIndex(blocks[mid].pos, size) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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
 * 残りのブロックの相対順序は保たれる (= 描画順を変えない)。
 *
 * 前提: 同一座標に複数の StoredBlock が登録されていないこと (blocksMap は
 * 最後の 1 個しか指さないため、重複があると getBlock と getBlocks が乖離する)。
 * `IncrementalSplitView` は構築時にこれを検証して警告する。
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
  // オブジェクト同一性ではなく座標で引く: Structure.addBlock は blocks と blocksMap に
  // 別オブジェクトを入れるため (constructor 経路は同一オブジェクト)。
  const at = findBlockIndex(blocks, index, size, isSorted(structure, blocks, size));
  if (at < 0) return stored;
  const removed = blocks[at];
  blocks.splice(at, 1);
  return removed;
}

/**
 * StoredBlock を palette index そのままで追加する。
 * removeStoredBlock で取り出したものを、palette を共有する別の構造体
 * (splitStructure の inner/outer) へ移すために使う。
 * 昇順に正規化された構造体では昇順を保つ位置に挿入する。
 */
export function addStoredBlock(structure: Structure, block: StoredBlock): void {
  const size = structure.getSize();
  if (!isInside(block.pos, size)) {
    throw new Error(`Cannot add block at ${block.pos} outside the structure bounds ${size}`);
  }
  const internal = structureInternals(structure);
  const index = flatIndex(block.pos, size);
  const blocks = internal.blocks;
  if (isSorted(structure, blocks, size)) {
    blocks.splice(findInsertIndex(blocks, index, size), 0, block);
  } else {
    blocks.push(block);
  }
  internal.blocksMap[index] = block;
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
 * deepslate 0.25.1 では隣接依存は needsCull の 6 方向のみ (AO 等が無い) なので
 * 斜め隣接は不要。
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
  // palette は slice で切り離す (共有すると派生側への addBlock が元 Structure に波及する)。
  // blocks は平坦化 index 昇順に正規化する (部分更新と描画順を一致させるため)。
  return {
    inner: createNormalized(size, palette.slice(), innerBlocks),
    faded: createNormalized(size, palette.slice(), fadedBlocks),
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
    inner: createNormalized(size, palette.slice(), innerBlocks),
    outer: createNormalized(size, palette.slice(), outerBlocks),
  };
}

/** 構造体を Y の [minY, maxY] (inclusive) で絞り込んだ新しい構造体を返す (レイヤースライス用)。 */
export function filterStructureByY(structure: Structure, minY: number, maxY: number): Structure {
  const size = structure.getSize() as [number, number, number];
  if (minY <= 0 && maxY >= size[1] - 1) return structure; // 全体ならそのまま
  const { palette, blocks } = structureInternals(structure);
  const filtered = blocks.filter((b) => b.pos[1] >= minY && b.pos[1] <= maxY);
  return createNormalized(size, palette.slice(), filtered);
}
