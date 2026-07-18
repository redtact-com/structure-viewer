// inner/outer 2 構造 (フォーカス表示) を「作り直さずに保守する」ビュー。
//
// 背景: ピック 1 個で splitStructure + 両レンダラ setStructure をやり直すと、
// 131k ブロック構造で約 1.8s の同期フリーズになる。ピックの実体は
// 「その座標のブロックが outer から消えて inner に現れる」だけなので、
// StoredBlock を in-place で移し、影響チャンクだけ再メッシュすれば
// 数十 ms で済む (実測 131k / chunkSize=16 で約 48ms)。
//
// 差分にしないもの: specs / crop / slice の変更は影響チャンクが広く、
// 差分にしても全再構築の 2〜3 倍程度にしかならないので resplit() に落とす。
//
// **このクラスは自分では resplit しない**。差分を適用できない状況では
// status: "needs-resplit" を返し、全再構築は必ず呼び出し側が 1 回だけ行う。
// (0.2.0 は内部で resplit してから -1 を返していたため、ドキュメントどおりに
//  書くと全再構築が 2 回走っていた。)

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
 * どちらもこの形を満たす。
 */
export interface SplitRenderTarget {
  setStructure(structure: StructureProvider): void;
  updateStructureBuffers(chunkPositions?: vec3[]): void;
  /**
   * このレンダラの ChunkBuilder のチャンクサイズ。実装していれば
   * IncrementalSplitView が構築時に自分の chunkSize と突き合わせる
   * (不一致は「特定のブロックだけ消せない」形の再現困難なバグになるため)。
   * `FadeStructureRenderer` は 0.3.0 から公開している。
   */
  readonly chunkSize?: readonly [number, number, number];
}

export interface SplitTargets {
  /** 選択範囲側 (通常描画) */
  inner: SplitRenderTarget;
  /** 範囲外側 (フェード描画)。crop モードでは faded 構造体が入る */
  outer: SplitRenderTarget;
}

/** Y スライス範囲 (inclusive)。null は全体 */
export type SliceRange = readonly [number, number] | null;

/** 分割の入力一式 */
export interface SplitInputs {
  specs: SelectionSpec[];
  /** 指定すると splitStructureCropped 経路になり、outer には faded が入る */
  crop?: CropSpec | null;
  slice?: SliceRange;
}

/** toggle が差分を適用できなかった理由 */
export type NeedsResplitReason =
  /** dirty チャンク数が fullRebuildChunkThreshold を超えた */
  | "threshold"
  /** specs/crop/slice (positions 以外) が最後の resplit から変わっている */
  | "structure"
  /** inputs の positions 集合が「現在の集合にこのトグルを適用した結果」と一致しない */
  | "positions";

/**
 * toggle の結果。
 * - `applied` — 差分を適用して `chunks` 個のチャンクを再メッシュした
 * - `noop` — 動かすブロックが 1 個も無かった (再メッシュしていない)
 * - `needs-resplit` — **ビューは一切変更していない**。呼び出し側が `resplit(inputs)` すること
 */
export type ToggleResult =
  | { status: "applied"; chunks: number; moved: number; skipped: number }
  | { status: "noop"; chunks: 0; moved: 0; skipped: number }
  | { status: "needs-resplit"; reason: NeedsResplitReason; chunks: 0; moved: 0; skipped: number };

export interface IncrementalSplitViewOptions {
  /**
   * dirty チャンク算出に使うチャンクサイズ (既定 16)。
   * **targets の ChunkBuilder と同じ値でなければならない**。
   * target が `chunkSize` を公開していれば構築時に検証し、不一致なら throw する。
   */
  chunkSize?: number | readonly [number, number, number];
  /**
   * dirty チャンク数がこれを超えたら差分をあきらめて `needs-resplit` を返す。
   *
   * 既定は**チャンクサイズ連動**で `48 * (16³ / (csx*csy*csz))`。
   * 差分側のコストは「dirty チャンク数 × チャンク内セル数」に比例するので、
   * チャンク数だけで閾値を決めると chunkSize を変えたときに意味が変わってしまう
   * (cs=16 → 48 / cs=8 → 384 / cs=32 → 6)。実測の損益分岐は cs=16 で約 73
   * チャンクなので、既定は安全側に倒してある。
   */
  fullRebuildChunkThreshold?: number;
  /**
   * 構築時と resplit 時に内部不変条件を検証する (既定 true)。
   * 検出コストは O(N) だが、走るのは全再構築のタイミングだけなので
   * メッシュ構築 (数百 ms〜秒) に対して無視できる。検出内容は `verifyConsistency()` 参照。
   */
  validate?: boolean;
  /** validate の通知先 (既定 console.error) */
  onValidationError?: (message: string) => void;
}

const DEFAULT_CHUNK_SIZE = 16;
/** chunkSize=16 での既定閾値。他のサイズにはセル数ベースで換算する */
const BASE_THRESHOLD_AT_16 = 48;

function toChunkSize(value: IncrementalSplitViewOptions["chunkSize"]): [number, number, number] {
  if (value === undefined) return [DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_SIZE];
  if (typeof value === "number") return [value, value, value];
  return [value[0], value[1], value[2]];
}

function defaultThreshold(chunkSize: readonly [number, number, number]): number {
  const cells = chunkSize[0] * chunkSize[1] * chunkSize[2];
  return Math.max(1, Math.round((BASE_THRESHOLD_AT_16 * DEFAULT_CHUNK_SIZE ** 3) / cells));
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
 * positions の**中身**は別途 pickedKeys と突き合わせる (これが無いと
 * ["1,1,1"] → ["2,1,1"] の総入れ替えを「追加」として受け取ってしまい、
 * 解除したはずのブロックが inner に残り続ける)。
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

/** specs / crop に現れる positions を 1 つの集合にまとめる */
function collectPositions(inputs: SplitInputs): Set<string> {
  const out = new Set<string>();
  for (const spec of inputs.specs) {
    for (const key of spec.positions ?? []) out.add(key);
  }
  for (const key of inputs.crop?.positions ?? []) out.add(key);
  return out;
}

function sameKeySet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

/**
 * inner / outer を差分で保守するビュー。
 *
 * ```ts
 * const view = new IncrementalSplitView(structure, inputs, { inner, outer }, { chunkSize: 16 });
 *
 * // ピック 1 個。inputs には「このトグルを適用したあと」の状態を渡す
 * const next = { specs: specsWith(nextPositions), crop, slice };
 * const result = view.toggle(addedKeys, true, next);
 * if (result.status === "needs-resplit") view.resplit(next);
 * loop.invalidate(); // dirty-flag ループを使っている場合は必須
 * ```
 *
 * 運用上の約束:
 * 1. `toggle` の `inputs` は**トグル適用後**の入力。ビューはこれと自分の状態を
 *    突き合わせ、食い違えば差分を捨てて `needs-resplit` を返す。
 * 2. `needs-resplit` のときビューは**一切変更されていない**。必ず `resplit(inputs)` すること。
 * 3. `chunkSize` は view / StructureRenderer / FadeStructureRenderer の 3 箇所で揃える。
 * 4. `toggle` は GPU バッファを更新するだけで再描画要求は出さない (`invalidate()` は呼び出し側)。
 * 5. 複数ブロックは**必ず 1 回の toggle にまとめて渡す**。1 個ずつ呼ぶと閾値が効かず、
 *    毎回 7 チャンク前後の再メッシュが確定で走るので全再構築より遅くなる。
 *
 * `inner` / `outer` が返す `Structure` に `addBlock` してはならない。
 * palette が分割時に切り離されているため index が乖離し、全再構築時に throw する。
 */
export class IncrementalSplitView {
  private readonly full: Structure;
  private readonly targets: SplitTargets;
  private readonly size: [number, number, number];
  private readonly chunkSizeVec: [number, number, number];
  private readonly threshold: number;
  private readonly validate: boolean;
  private readonly onValidationError: (message: string) => void;
  private innerStructure: Structure;
  private outerStructure: Structure;
  private signature: string;
  /** 最後に resplit / toggle した時点の positions 集合 */
  private pickedKeys: Set<string>;

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
    this.threshold = options?.fullRebuildChunkThreshold ?? defaultThreshold(this.chunkSizeVec);
    this.validate = options?.validate ?? true;
    this.onValidationError =
      options?.onValidationError ??
      ((message) => {
        console.error(`[IncrementalSplitView] ${message}`);
      });
    this.assertChunkSizeMatches("inner", targets.inner);
    this.assertChunkSizeMatches("outer", targets.outer);
    // resplit が確実に埋めるが、TS の definite assignment のため空で初期化しておく
    this.innerStructure = Structure.EMPTY;
    this.outerStructure = Structure.EMPTY;
    this.signature = "";
    this.pickedKeys = new Set();
    this.resplit(inputs);
  }

  private assertChunkSizeMatches(label: string, target: SplitRenderTarget): void {
    const theirs = target.chunkSize;
    if (!theirs) return;
    const mine = this.chunkSizeVec;
    if (theirs[0] === mine[0] && theirs[1] === mine[1] && theirs[2] === mine[2]) return;
    throw new Error(
      `IncrementalSplitView chunkSize [${mine.join(",")}] does not match the ${label} renderer's ` +
        `[${[...theirs].join(",")}]; dirty chunk coordinates would address the wrong chunks.`,
    );
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

  /** 差分をあきらめて needs-resplit を返す dirty チャンク数の閾値 */
  get fullRebuildChunkThreshold(): number {
    return this.threshold;
  }

  /**
   * specs / crop / slice の変更。splitStructure + スライス + 両レンダラ
   * setStructure の全再構築を行い、内部状態を inputs に合わせ直す。
   *
   * crop / slice は `inputs` に含めて渡すこと (0.2.0 の位置引数版は
   * 渡し忘れると黙って crop/slice が解除される事故があったため廃止した)。
   */
  resplit(inputs: SplitInputs): void {
    const crop = inputs.crop ?? null;
    const slice = inputs.slice ?? null;
    let inner: Structure;
    let outer: Structure;
    if (crop) {
      const result = splitStructureCropped(this.full, crop);
      inner = result.inner;
      outer = result.faded;
    } else {
      const result = splitStructure(this.full, inputs.specs);
      inner = result.inner;
      outer = result.outer;
    }
    if (slice) {
      inner = filterStructureByY(inner, slice[0], slice[1]);
      outer = filterStructureByY(outer, slice[0], slice[1]);
    }
    this.innerStructure = inner;
    this.outerStructure = outer;
    this.signature = structuralSignature(inputs);
    this.pickedKeys = collectPositions(inputs);
    this.targets.inner.setStructure(inner);
    this.targets.outer.setStructure(outer);
    this.runValidation();
  }

  /**
   * ピック差分。`keys` ("x,y,z") のブロックを inner(add=true) / outer(add=false) へ移し、
   * 影響チャンク (6 近傍込み) だけを両レンダラで再メッシュする。
   *
   * @param inputs **このトグルを適用したあと**の入力一式。ビューは
   *   (a) positions 以外の構造シグネチャ、(b) positions 集合が
   *   「現在の集合にこのトグルを適用した結果」と一致するか、の 2 点を検証し、
   *   どちらかが食い違えば差分を捨てて `needs-resplit` を返す。
   *   これにより、呼び出し側が「選択の置換」を「追加」として渡しても
   *   解除したはずのブロックが残り続けることがない。
   * @returns `applied` / `noop` / `needs-resplit`。`needs-resplit` のときビューは無変更。
   */
  toggle(keys: readonly string[], add: boolean, inputs: SplitInputs): ToggleResult {
    if (structuralSignature(inputs) !== this.signature) {
      return { status: "needs-resplit", reason: "structure", chunks: 0, moved: 0, skipped: 0 };
    }
    // このトグルを適用したときの positions 集合を作り、呼び出し側の申告と突き合わせる。
    const nextKeys = new Set(this.pickedKeys);
    for (const key of keys) {
      if (add) nextKeys.add(key);
      else nextKeys.delete(key);
    }
    if (!sameKeySet(nextKeys, collectPositions(inputs))) {
      return { status: "needs-resplit", reason: "positions", chunks: 0, moved: 0, skipped: 0 };
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
    const skipped = keys.length - moving.length;
    if (moving.length === 0) {
      this.pickedKeys = nextKeys;
      return { status: "noop", chunks: 0, moved: 0, skipped };
    }

    // 閾値判定は構造を触る前に行う。needs-resplit を返した時点でビューは完全に無変更。
    const dirty = dirtyChunksFor(moving, this.chunkSizeVec, this.size);
    if (dirty.length > this.threshold) {
      return { status: "needs-resplit", reason: "threshold", chunks: 0, moved: 0, skipped };
    }

    for (const pos of moving) {
      const stored = removeStoredBlock(from, pos);
      if (!stored) continue;
      addStoredBlock(to, stored);
    }
    this.pickedKeys = nextKeys;
    this.targets.inner.updateStructureBuffers(dirty);
    this.targets.outer.updateStructureBuffers(dirty);
    return { status: "applied", chunks: dirty.length, moved: moving.length, skipped };
  }

  private runValidation(): void {
    if (!this.validate) return;
    const problem = this.verifyConsistency();
    if (problem) this.onValidationError(problem);
  }

  /**
   * 内部表現の不変条件を検査する。問題があれば説明文字列、無ければ null。
   * `validate` が有効なら構築時と `resplit` 時に自動で呼ばれ、
   * 検出内容は `onValidationError` (既定 console.error) に流れる。
   *
   * - blocks と blocksMap が相互に整合しているか (座標 / palette index / nbt)
   * - palette index が palette の範囲に収まっているか
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
      const { blocks, blocksMap, palette } = structureInternals(structure);
      const seen = new Set<number>();
      for (const block of blocks) {
        const index = flat(block.pos);
        // 同一オブジェクトである必要はない (Structure.addBlock は blocks と blocksMap に
        // 別オブジェクトを入れる)。座標・palette index・nbt の一致を要求する。
        const mapped = blocksMap[index];
        if (!mapped || flat(mapped.pos) !== index) {
          return `${label}: blocks にある ${block.pos.join(",")} が blocksMap から引けない`;
        }
        if (mapped.state !== block.state || mapped.nbt !== block.nbt) {
          return `${label}: ${block.pos.join(",")} の blocks と blocksMap で state/nbt が食い違う`;
        }
        if (block.state < 0 || block.state >= palette.length) {
          return `${label}: ${block.pos.join(",")} の palette index ${block.state} が palette (${palette.length} 件) の範囲外`;
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
