// deepslate 0.25.1 への性能 runtime patch (prototype 差し替えの単一集約点)。
//
// なぜ patch-package でなく runtime patch か:
// - patch-package は適用側アプリの postinstall でしか働かず、ライブラリとして
//   配布しても利用者の node_modules に伝播しない。runtime patch なら
//   applyDeepslatePatches() を呼ぶだけで済み、upstream に取り込まれた場合も
//   該当部分を消すだけで素の deepslate に戻せる。
//
// 適用内容 (実測に基づく):
//   (a) Mesh.prototype.rebuild — flatMap による巨大 JS number 中間配列を廃止し、
//       quad 数から事前確定した Float32Array へ直書き (mesh build 総時間の約 45%)。
//       index buffer は Uint16Array→Uint32Array + Renderer.prototype.drawMesh を
//       UNSIGNED_INT 化 (WebGL1 ではアプリ側の OES_element_index_uint 拡張
//       有効化と組で動作)。
//   (b) Mesh.prototype.merge — quads/lines の concat 全コピー (実測 6-23%) を push 化。
//   (c) Renderer.prototype.setVertexAttr / setUniform / prepareDraw —
//       毎フレーム・毎メッシュの gl.getAttribLocation / getUniformLocation
//       (driver 往復) をプログラム単位の WeakMap キャッシュに。
//   (d) releaseQuadsAfterUpload (オプトイン) — GPU アップロード後に CPU 側 quads
//       (Vertex オブジェクトグラフ) を解放し、大型構造での JS ヒープ数百 MB 残留を防ぐ。
//       ChunkBuilder は再 setStructure 時に必ず mesh.clear() から再構築するため保持不要。
//
// 制約 / 非対応:
// - quads 解放後の Mesh に対する merge / transform / computeNormals は no-op になる
//   (deepslate 内の利用経路では rebuild 後にこれらを呼ぶ箇所は無い。
//    解放は「全属性 rebuild」= ChunkBuilder のチャンクメッシュ経路のみで発動する)。
// - ShaderProgram の再リンクは想定しない (deepslate はリンク後に再リンクしない)。

import { Mesh, Renderer } from "deepslate/render";

/** rebuild のオプション (deepslate の型と同一) */
interface RebuildOptions {
  pos?: boolean;
  color?: boolean;
  texture?: boolean;
  normal?: boolean;
  blockPos?: boolean;
}

/** Quad / Line 共通の構造的型 (deepslate の Vertex 配列を返す) */
interface VertexLike {
  pos: { components(): number[] };
  color: number[];
  texture: number[];
  textureLimit: number[];
  normal?: { components(): number[] };
  blockPos?: { components(): number[] };
}
interface ElementLike {
  vertices(): VertexLike[];
}

type MeshInternal = Mesh & {
  /** releaseQuadsAfterUpload で quads を解放した際の元 quad 数。未解放は undefined */
  __redtactReleasedQuadCount?: number;
};

/** Renderer の protected/private メンバへの構造的アクセス用 */
interface RendererInternal {
  gl: WebGLRenderingContext;
  activeShader: WebGLProgram;
  projMatrix: Float32List;
  pixelSize: number;
  setUniform(name: string, value: Float32List): void;
  setVertexAttr(name: string, size: number, buffer: WebGLBuffer | null | undefined): void;
}

export interface DeepslatePatchOptions {
  /**
   * true にすると、全属性 rebuild (ChunkBuilder のチャンクメッシュ経路) の
   * GPU アップロード後に CPU 側 quads を解放する。描画に必要な頂点数/インデックス数は
   * 保持され、getMeshes() のフィルタ (isEmpty) も従来どおり機能する。
   */
  releaseQuadsAfterUpload?: boolean;
}

// ── モジュール状態 ────────────────────────────────────────────
let applied = false;
let releaseQuadsAfterUpload = false;

// 二重バンドル時の多重適用ガード用マーカー
const PATCH_MARKER = "__redtactDeepslatePatched";

// ── (a) rebuild: typed-array 直書き ──────────────────────────

type VertexMapper = (v: VertexLike) => number[] | undefined;

const mapPos: VertexMapper = (v) => v.pos.components();
const mapColor: VertexMapper = (v) => v.color;
const mapTexture: VertexMapper = (v) => v.texture;
const mapTextureLimit: VertexMapper = (v) => v.textureLimit;
const mapNormal: VertexMapper = (v) => v.normal?.components();
const mapBlockPos: VertexMapper = (v) => v.blockPos?.components();

/**
 * 原実装 (array.flatMap(e => e.vertices().flatMap(mapper))) と同一の値列を
 * 中間配列なしで Float32Array に直書きする。頂点数/成分数が想定と異なる
 * 要素が混じっていた場合は原実装と同一アルゴリズムの slow path に落ちる
 * (出力はどちらもビット一致)。
 */
function buildVertexData(
  elements: ElementLike[],
  verticesPerElement: number,
  comps: number,
  mapper: VertexMapper,
): Float32Array<ArrayBuffer> {
  const out = new Float32Array(elements.length * verticesPerElement * comps);
  let o = 0;
  for (let i = 0; i < elements.length; i++) {
    const vs = elements[i].vertices();
    if (vs.length !== verticesPerElement) return buildVertexDataSlow(elements, mapper);
    for (let j = 0; j < verticesPerElement; j++) {
      const data = mapper(vs[j]);
      if (!data) throw new Error("Missing vertex component");
      if (data.length !== comps) return buildVertexDataSlow(elements, mapper);
      for (let k = 0; k < comps; k++) out[o++] = data[k];
    }
  }
  return out;
}

/** deepslate 0.25.1 の rebuildBufferV と同一アルゴリズム (フォールバック用) */
function buildVertexDataSlow(
  elements: ElementLike[],
  mapper: VertexMapper,
): Float32Array<ArrayBuffer> {
  return new Float32Array(
    elements.flatMap((e) =>
      e.vertices().flatMap((v) => {
        const data = mapper(v);
        if (!data) throw new Error("Missing vertex component");
        return data;
      }),
    ),
  );
}

/** 原実装の [4i, 4i+1, 4i+2, 4i, 4i+2, 4i+3] パターンを Uint32Array に直書き */
function buildQuadIndices(quadCount: number): Uint32Array<ArrayBuffer> {
  const out = new Uint32Array(quadCount * 6);
  let o = 0;
  for (let i = 0, v = 0; i < quadCount; i++, v += 4) {
    out[o++] = v;
    out[o++] = v + 1;
    out[o++] = v + 2;
    out[o++] = v;
    out[o++] = v + 2;
    out[o++] = v + 3;
  }
  return out;
}

function patchedRebuild(
  this: MeshInternal,
  gl: WebGLRenderingContext,
  options: RebuildOptions,
): Mesh {
  const rebuildBuffer = (
    buffer: WebGLBuffer | undefined,
    type: number,
    data: BufferSource,
  ): WebGLBuffer => {
    if (!buffer) {
      buffer = gl.createBuffer() ?? undefined;
    }
    if (!buffer) {
      throw new Error("Cannot create new buffer");
    }
    gl.bindBuffer(type, buffer);
    gl.bufferData(type, data, gl.DYNAMIC_DRAW);
    return buffer;
  };
  const rebuildBufferV = (
    array: ElementLike[],
    buffer: WebGLBuffer | undefined,
    verticesPerElement: number,
    comps: number,
    mapper: VertexMapper,
  ): WebGLBuffer | undefined => {
    if (array.length === 0) {
      if (buffer) gl.deleteBuffer(buffer);
      return undefined;
    }
    return rebuildBuffer(
      buffer,
      gl.ARRAY_BUFFER,
      buildVertexData(array, verticesPerElement, comps, mapper),
    );
  };

  // quads 解放済みメッシュの再 rebuild: 保持していれば同一データを再アップロード
  // するだけなので、既存の GL バッファをそのまま維持する (意味論は同一)。
  // lines は解放対象外なので通常どおり再構築する。
  const released = this.__redtactReleasedQuadCount !== undefined;
  const quads = this.quads as unknown as ElementLike[];
  const lines = this.lines as unknown as ElementLike[];

  if (options.pos) {
    if (!released) this.posBuffer = rebuildBufferV(quads, this.posBuffer, 4, 3, mapPos);
    this.linePosBuffer = rebuildBufferV(lines, this.linePosBuffer, 2, 3, mapPos);
  }
  if (options.color) {
    if (!released) this.colorBuffer = rebuildBufferV(quads, this.colorBuffer, 4, 3, mapColor);
    this.lineColorBuffer = rebuildBufferV(lines, this.lineColorBuffer, 2, 3, mapColor);
  }
  if (options.texture && !released) {
    this.textureBuffer = rebuildBufferV(quads, this.textureBuffer, 4, 2, mapTexture);
    this.textureLimitBuffer = rebuildBufferV(quads, this.textureLimitBuffer, 4, 4, mapTextureLimit);
  }
  if (options.normal && !released) {
    this.normalBuffer = rebuildBufferV(quads, this.normalBuffer, 4, 3, mapNormal);
  }
  if (options.blockPos && !released) {
    this.blockPosBuffer = rebuildBufferV(quads, this.blockPosBuffer, 4, 3, mapBlockPos);
  }
  if (!released) {
    if (this.quads.length === 0) {
      if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
      this.indexBuffer = undefined;
    } else {
      this.indexBuffer = rebuildBuffer(
        this.indexBuffer,
        gl.ELEMENT_ARRAY_BUFFER,
        buildQuadIndices(this.quads.length),
      );
    }
  }

  // (d) 全属性 rebuild = ChunkBuilder のチャンクメッシュ経路のときだけ quads を解放する。
  // 部分 rebuild ({pos, color} のみ等) で解放すると、後から別属性の rebuild が
  // 走ったときに再構築できなくなるため対象外。
  if (
    releaseQuadsAfterUpload &&
    !released &&
    this.quads.length > 0 &&
    options.pos &&
    options.color &&
    options.texture &&
    options.normal &&
    options.blockPos
  ) {
    this.__redtactReleasedQuadCount = this.quads.length;
    this.quads = [];
  }
  return this;
}

// ── (b) merge: push 化 ───────────────────────────────────────

function patchedMerge(this: MeshInternal, other: Mesh): Mesh {
  // concat は蓄積側の全コピーを毎回作る (チャンクあたり quad 数の 2 乗オーダーの
  // コピー量)。push は追記のみ。spread push は引数上限があるためループで積む。
  const quads = this.quads;
  const otherQuads = other.quads;
  for (let i = 0; i < otherQuads.length; i++) quads.push(otherQuads[i]);
  const lines = this.lines;
  const otherLines = other.lines;
  for (let i = 0; i < otherLines.length; i++) lines.push(otherLines[i]);
  return this;
}

// ── (d) quads 解放と整合させる派生メソッド ───────────────────

function patchedClear(this: MeshInternal): Mesh {
  this.quads = [];
  this.lines = [];
  this.__redtactReleasedQuadCount = undefined;
  return this;
}

function patchedIsEmpty(this: MeshInternal): boolean {
  return (this.__redtactReleasedQuadCount ?? this.quads.length) === 0 && this.lines.length === 0;
}

function patchedQuadVertices(this: MeshInternal): number {
  return (this.__redtactReleasedQuadCount ?? this.quads.length) * 4;
}

function patchedQuadIndices(this: MeshInternal): number {
  return (this.__redtactReleasedQuadCount ?? this.quads.length) * 6;
}

// ── (c) attrib / uniform location キャッシュ ─────────────────

const attrLocationCache = new WeakMap<WebGLProgram, Map<string, number>>();
const uniformLocationCache = new WeakMap<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

function cachedAttrLocation(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string,
): number {
  let perProgram = attrLocationCache.get(program);
  if (!perProgram) {
    perProgram = new Map();
    attrLocationCache.set(program, perProgram);
  }
  let location = perProgram.get(name);
  if (location === undefined) {
    location = gl.getAttribLocation(program, name);
    perProgram.set(name, location);
  }
  return location;
}

function cachedUniformLocation(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation | null {
  let perProgram = uniformLocationCache.get(program);
  if (!perProgram) {
    perProgram = new Map();
    uniformLocationCache.set(program, perProgram);
  }
  let location = perProgram.get(name);
  if (location === undefined) {
    location = gl.getUniformLocation(program, name);
    perProgram.set(name, location);
  }
  return location;
}

function patchedSetVertexAttr(
  this: RendererInternal,
  name: string,
  size: number,
  buffer: WebGLBuffer | null | undefined,
): void {
  if (buffer === undefined) throw new Error(`Expected buffer for ${name}`);
  const gl = this.gl;
  const location = cachedAttrLocation(gl, this.activeShader, name);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(location);
}

function patchedSetUniform(this: RendererInternal, name: string, value: Float32List): void {
  const location = cachedUniformLocation(this.gl, this.activeShader, name);
  this.gl.uniformMatrix4fv(location, false, value);
}

function patchedPrepareDraw(this: RendererInternal, viewMatrix: Float32List): void {
  this.setUniform("mView", viewMatrix);
  this.setUniform("mProj", this.projMatrix);
  const location = cachedUniformLocation(this.gl, this.activeShader, "pixelSize");
  this.gl.uniform1f(location, this.pixelSize);
}

// ── (a) drawMesh: Uint32 index buffer を UNSIGNED_INT で描画 ─
// (旧 patch-package の Renderer.js 側 1 行変更を統合。それ以外は原実装と同一)

function patchedDrawMesh(this: RendererInternal, mesh: Mesh, options: RebuildOptions): void {
  const gl = this.gl;
  if (mesh.quadVertices() > 0) {
    if (options.pos) this.setVertexAttr("vertPos", 3, mesh.posBuffer);
    if (options.color) this.setVertexAttr("vertColor", 3, mesh.colorBuffer);
    if (options.texture) {
      this.setVertexAttr("texCoord", 2, mesh.textureBuffer);
      this.setVertexAttr("texLimit", 4, mesh.textureLimitBuffer);
    }
    if (options.normal) this.setVertexAttr("normal", 3, mesh.normalBuffer);
    if (options.blockPos) this.setVertexAttr("blockPos", 3, mesh.blockPosBuffer);
    if (!mesh.indexBuffer) throw new Error("Expected index buffer");
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
    gl.drawElements(gl.TRIANGLES, mesh.quadIndices(), gl.UNSIGNED_INT, 0);
  }
  if (mesh.lineVertices() > 0) {
    if (options.pos) this.setVertexAttr("vertPos", 3, mesh.linePosBuffer);
    if (options.color) this.setVertexAttr("vertColor", 3, mesh.lineColorBuffer);
    gl.drawArrays(gl.LINES, 0, mesh.lineVertices());
  }
}

// ── 適用 ─────────────────────────────────────────────────────

/**
 * deepslate の prototype patch を適用する。冪等 (何度呼んでも 1 回だけ適用)。
 * releaseQuadsAfterUpload フラグは呼び出しごとに最新値へ更新される。
 * GL コンテキスト生成・レンダラ生成より前に呼ぶこと。
 */
export function applyDeepslatePatches(options?: DeepslatePatchOptions): void {
  if (options?.releaseQuadsAfterUpload !== undefined) {
    releaseQuadsAfterUpload = options.releaseQuadsAfterUpload;
  }
  // Mesh の this 型 (clear(): this 等) と衝突しないよう構造的 Record 経由で差し替える
  const meshProto = Mesh.prototype as unknown as Record<string, unknown>;
  if (applied || meshProto[PATCH_MARKER]) {
    applied = true;
    return;
  }

  meshProto.rebuild = patchedRebuild;
  meshProto.merge = patchedMerge;
  meshProto.clear = patchedClear;
  meshProto.isEmpty = patchedIsEmpty;
  meshProto.quadVertices = patchedQuadVertices;
  meshProto.quadIndices = patchedQuadIndices;

  const rendererProto = Renderer.prototype as unknown as RendererInternal & {
    prepareDraw(viewMatrix: Float32List): void;
    drawMesh(mesh: Mesh, options: RebuildOptions): void;
  };
  rendererProto.setVertexAttr = patchedSetVertexAttr;
  rendererProto.setUniform = patchedSetUniform;
  rendererProto.prepareDraw = patchedPrepareDraw;
  rendererProto.drawMesh = patchedDrawMesh;

  meshProto[PATCH_MARKER] = true;
  applied = true;
}
