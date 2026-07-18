// inner/outer 2 構造 (フォーカス表示) を「作り直さずに保守する」ビュー。
//
// 背景: ピック 1 個で splitStructure + 両レンダラ setStructure をやり直すと、
// 131k ブロック構造で約 2.3s の同期フリーズになる。ピックの実体は
// 「その座標のブロックが outer から消えて inner に現れる」だけなので、
// StoredBlock を in-place で移し、影響チャンクだけ再メッシュすれば
// 数十 ms で済む (実測 131k / chunkSize=16 で 30〜50ms)。
//
// 差分にしないもの: specs / crop / slice の変更は影響チャンクが広く、
// 差分にしても全再構築の 2〜3 倍程度にしかならないので resplit() に落とす。

import { Structure } from "deepslate/core";
import type { StructureProvider } from "deepslate/core";
import type { vec3 } from "gl-matrix";

import {
  addStoredBlock,
  dirtyChunksFor,
  filterStructureByY,
  removeStoredBlock,
  splitStructure,
  splitStructureCropped,
  storedBlockAt,
  structureInternals,
  type CropSpec,
  type SelectionSpec,
} from "./splitStructure";

/**
 * 再メッシュ先。`StructureRenderer` と `FadeStructureRenderer` の
 * どちらもこの形を満たす (FadeStructureRenderer には 0.2.0 で
 * `updateStructureBuffers` を追加した)。
 */
export interface SplitRenderTarget {
  setStructure(structure: StructureProvider): void;
  updateStructureBuffers(chunkPositions?: vec3[]): void;
}

export interface SplitTargets {
  /** 選択範囲側 (通常描画) */
  inner: SplitRenderTarget;
  /** 範囲外側 (フェード描画)。crop モードでは faded 構造体が入る */
  outer: SplitRenderTarget;
}

/** Y スライス範囲 (inclusive)。null は全体 */
export type SliceRange = readonly [number, number] | null;

/** 分割の入力一式。positions 以外が「構造シグネチャ」を成す */
export interface SplitInputs {
  specs: SelectionSpec[];
  /** 指定すると splitStructureCropped 経路になり、outer には faded が入る */
  crop?: CropSpec | null;
  slice?: SliceRange;
}

export interface IncrementalSplitViewOptions {
  /**
   * dirty チャンク算出に使うチャンクサイズ。
   * **targets の ChunkBuilder と同じ値でなければならない** (既定 16)。
   */
  chunkSize?: number | readonly [number, number, number];
  /**
   * dirty チャンク数がこれを超えたら差分をやめて -1 を返す (既定 48)。
   * 実測の損益分岐は chunkSize=16 で約 73 チャンクなので安全側に倒してある。
   */
  fullRebuildChunkThreshold?: number;
}

const DEFAULT_CHUNK_SIZE = 16;
const DEFAULT_FULL_REBUILD_CHUNK_THRESHOLD = 48;

function toChunkSize(value: IncrementalSplitViewOptions["chunkSize"]): [number, number, number] {
  if (value === undefined) return [DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_SIZE];
  if (typeof value === "number") return [value, value, value];
  return [value[0], value[1], value[2]];
}

/** "x,y,z" 形式のキーを座標に戻す。不正なら null */
export function parsePosKey(key: string): [number, number, number] | null {
  const parts = key.split(",");
  if (parts.length !== 3) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const z = Number(parts[2]);
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return null;
  return [x, y, z];
}

/**
 * positions を除いた「構造シグネチャ」。これが変わったら差分では追随できない。
 *
 * positions そのものは差分の対象なので含めないが、**positions が空か否か**は含める:
 * splitStructure は positions が非空のとき region/materials を無視するので、
 * 1 個 → 0 個 の遷移で分割の意味論そのものが変わる。
 */
function structuralSignature(inputs: SplitInputs): string {
  return JSON.stringify({
    specs: inputs.specs.map((spec) => [
      spec.region ?? null,
      spec.materials ?? null,
      spec.colorIndex ?? null,
      (spec.positions?.length ?? 0) > 0,
    ]),
    crop: inputs.crop
      ? [inputs.crop.region, inputs.crop.materials ?? null, (inputs.crop.positions?.length ?? 0) > 0]
      : null,
    slice: inputs.slice ?? null,
  });
}

/**
 * inner / outer を差分で保守するビュー。
 *
 * ```ts
 * const view = new IncrementalSplitView(full, { specs }, { inner: renderer, outer: fadeRenderer });
 * // ピック 1 個
 * if (view.toggle(["3,4,5"], true, { specs, crop, slice }) < 0) {
 *   view.resplit(specs, crop, slice); // 閾値超過 / 構造変化 → 全再構築
 * }
 * ```
 */
export class IncrementalSplitView {
  private readonly full: Structure;
  private readonly targets: SplitTargets;
  private readonly size: [number, number, number];
  private readonly chunkSizeVec: [number, number, number];
  private readonly threshold: number;
  private innerStructure: Structure;
  private outerStructure: Structure;
  private signature: string;

  constructor(
    full: Structure,
    inputs: SplitInputs,
    targets: SplitTargets,
    options?: IncrementalSplitViewOptions,
  ) {
    this.full = full;
    this.targets = targets;
    this.size = full.getSize() as [number, number, number];
    this.chunkSizeVec = toChunkSize(options?.chunkSize);
    this.threshold =
      options?.fullRebuildChunkThreshold ?? DEFAULT_FULL_REBUILD_CHUNK_THRESHOLD;
    // resplit が確実に埋めるが、TS の definite assignment のため空で初期化しておく
    this.innerStructure = Structure.EMPTY;
    this.outerStructure = Structure.EMPTY;
    this.signature = "";
    this.resplit(inputs.specs, inputs.crop ?? null, inputs.slice ?? null);
  }

  /** 現在の inner 構造体 (スライス適用後の実体)。レンダラに渡っているものと同一 */
  get inner(): Structure {
    return this.innerStructure;
  }

  /** 現在の outer / faded 構造体 (スライス適用後の実体) */
  get outer(): Structure {
    return this.outerStructure;
  }

  /** dirty チャンク算出に使っているチャンクサイズ */
  get chunkSize(): [number, number, number] {
    return [this.chunkSizeVec[0], this.chunkSizeVec[1], this.chunkSizeVec[2]];
  }

  /**
   * specs / crop / slice の変更。splitStructure + スライス + 両レンダラ
   * setStructure の全再構築を行い、構造シグネチャを更新する。
   */
  resplit(specs: SelectionSpec[], crop: CropSpec | null = null, slice: SliceRange = null): void {
    let inner: Structure;
    let outer: Structure;
    if (crop) {
      const result = splitStructureCropped(this.full, crop);
      inner = result.inner;
      outer = result.faded;
    } else {
      const result = splitStructure(this.full, specs);
      inner = result.inner;
      outer = result.outer;
    }
    if (slice) {
      inner = filterStructureByY(inner, slice[0], slice[1]);
      outer = filterStructureByY(outer, slice[0], slice[1]);
    }
    this.innerStructure = inner;
    this.outerStructure = outer;
    this.signature = structuralSignature({ specs, crop, slice });
    this.targets.inner.setStructure(inner);
    this.targets.outer.setStructure(outer);
  }

  /**
   * ピック差分。`keys` ("x,y,z") のブロックを inner(add=true) / outer(add=false) へ移し、
   * 影響チャンク (6 近傍込み) だけを両レンダラで再メッシュする。
   *
   * @param expected 呼び出し側の現在の入力。構造シグネチャが保持中のものと
   *   食い違っていたら差分をあきらめて resplit する (アプリ側の分岐ミスで
   *   画面と状態が乖離しても壊れないようにするための自己検証。渡すことを強く推奨)。
   * @returns 再メッシュしたチャンク数。0 = 変更なし。
   *   **-1 = 差分を適用しなかった (構造が変わった / 閾値超過)** ので、
   *   呼び出し側で `resplit()` すること。expected を渡していた場合は
   *   シグネチャ不一致のときのみビュー側で resplit 済み。
   */
  toggle(keys: readonly string[], add: boolean, expected?: SplitInputs): number {
    if (expected && structuralSignature(expected) !== this.signature) {
      this.resplit(expected.specs, expected.crop ?? null, expected.slice ?? null);
      return -1;
    }
    const from = add ? this.outerStructure : this.innerStructure;
    const to = add ? this.innerStructure : this.outerStructure;

    // 先に「実際に動くもの」だけを確定させる。スライス範囲外・crop 範囲外・
    // 既に移動済みの座標は from に存在しないので自動的に no-op になる。
    const moving: [number, number, number][] = [];
    for (const key of keys) {
      const pos = parsePosKey(key);
      if (!pos) continue;
      if (!storedBlockAt(from, pos)) continue;
      moving.push(pos);
    }
    if (moving.length === 0) return 0;

    // 閾値判定は構造を触る前に行う。-1 を返した時点でビューは完全に無変更。
    const dirty = dirtyChunksFor(moving, this.chunkSizeVec, this.size);
    if (dirty.length > this.threshold) return -1;

    for (const pos of moving) {
      const stored = removeStoredBlock(from, pos);
      if (!stored) continue;
      addStoredBlock(to, stored);
    }
    this.targets.inner.updateStructureBuffers(dirty);
    this.targets.outer.updateStructureBuffers(dirty);
    return dirty.length;
  }

  /**
   * 内部表現の不変条件を検査する (dev / テスト用)。問題があれば説明文字列、無ければ null。
   * - blocks と blocksMap が相互に整合しているか
   * - 同一座標を 2 個持っていないか
   * - inner と outer が同一座標を重複保持していないか
   */
  verifyConsistency(): string | null {
    const [, sy, sz] = this.size;
    const flat = (pos: readonly number[]) => pos[0] * sy * sz + pos[1] * sz + pos[2];
    for (const [label, structure] of [
      ["inner", this.innerStructure],
      ["outer", this.outerStructure],
    ] as const) {
      const { blocks, blocksMap } = structureInternals(structure);
      const seen = new Set<number>();
      for (const block of blocks) {
        const index = flat(block.pos);
        // 同一オブジェクトである必要はない (Structure.addBlock は blocks と blocksMap に
        // 別オブジェクトを入れる)。座標として引けることだけを不変条件とする。
        const mapped = blocksMap[index];
        if (!mapped || flat(mapped.pos) !== index) {
          return `${label}: blocks にある ${block.pos.join(",")} が blocksMap から引けない`;
        }
        if (seen.has(index)) return `${label}: 座標 ${block.pos.join(",")} が重複している`;
        seen.add(index);
      }
      let mapped = 0;
      blocksMap.forEach(() => mapped++);
      if (mapped !== blocks.length) {
        return `${label}: blocksMap の要素数 ${mapped} が blocks 配列長 ${blocks.length} と一致しない`;
      }
    }
    const innerMap = structureInternals(this.innerStructure).blocksMap;
    const outerMap = structureInternals(this.outerStructure).blocksMap;
    let overlap: number | null = null;
    innerMap.forEach((_block, index) => {
      if (overlap === null && outerMap[index]) overlap = index;
    });
    if (overlap !== null) return `inner と outer が同一座標 (index ${overlap}) を重複保持している`;
    return null;
  }
}
