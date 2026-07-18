import type { mat4, vec3 } from "gl-matrix";
import { ChunkBuilder, Mesh, Renderer, ShaderProgram } from "deepslate/render";
import type { Resources } from "deepslate/render";
import type { StructureProvider } from "deepslate/core";

// deepslate Renderer の標準ブロックシェーダと同一の頂点シェーダ
const vsFade = `
  attribute vec4 vertPos;
  attribute vec2 texCoord;
  attribute vec4 texLimit;
  attribute vec3 vertColor;
  attribute vec3 normal;

  uniform mat4 mView;
  uniform mat4 mProj;

  varying highp vec2 vTexCoord;
  varying highp vec4 vTexLimit;
  varying highp vec3 vTintColor;
  varying highp float vLighting;

  void main(void) {
    gl_Position = mProj * mView * vertPos;
    vTexCoord = texCoord;
    vTexLimit = texLimit;
    vTintColor = vertColor;
    vLighting = normal.y * 0.2 + abs(normal.z) * 0.1 + 0.8;
  }
`;

// 標準フラグメントシェーダに fadeAlpha（透明度）と fadeDesat（彩度低下）を追加したもの
const fsFade = `
  precision highp float;
  varying highp vec2 vTexCoord;
  varying highp vec4 vTexLimit;
  varying highp vec3 vTintColor;
  varying highp float vLighting;

  uniform sampler2D sampler;
  uniform highp float pixelSize;
  uniform highp float fadeAlpha;
  uniform highp float fadeDesat;

  void main(void) {
    vec4 texColor = texture2D(sampler, clamp(vTexCoord,
      vTexLimit.xy + vec2(0.5, 0.5) * pixelSize,
      vTexLimit.zw - vec2(0.5, 0.5) * pixelSize
    ));
    if(texColor.a < 0.01) discard;
    vec3 base = texColor.xyz * vTintColor * vLighting;
    float gray = dot(base, vec3(0.299, 0.587, 0.114));
    vec3 c = mix(base, vec3(gray), fadeDesat);
    gl_FragColor = vec4(c, texColor.a * fadeAlpha);
  }
`;

const vsLine = `
  attribute vec4 vertPos;
  attribute vec3 vertColor;

  uniform mat4 mView;
  uniform mat4 mProj;

  varying highp vec3 vColor;

  void main(void) {
    gl_Position = mProj * mView * vertPos;
    vColor = vertColor;
  }
`;

const fsLine = `
  precision highp float;
  varying highp vec3 vColor;

  void main(void) {
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

export interface SelectionBox {
  /** inclusive なブロック座標 */
  min: [number, number, number];
  max: [number, number, number];
  color: [number, number, number];
}

export interface FadeStructureRendererOptions {
  /**
   * ChunkBuilder のチャンクサイズ (既定 16 — 従来の挙動)。
   * 小さくすると部分更新 (updateStructureBuffers) 1 回あたりが軽くなる代わりに
   * draw call が増える。`deepslate` の StructureRenderer 側の `options.chunkSize`
   * および IncrementalSplitView の `chunkSize` と揃えること。
   */
  chunkSize?: number | vec3;
}

/**
 * 選択範囲外のブロックを「薄く」描画するレンダラ。
 *
 * deepslate の StructureRenderer 相当を、グローバル透明度 (fadeAlpha) と
 * 彩度低下 (fadeDesat) の uniform を持つ専用シェーダで描画する。
 * 深度バッファへの書き込みを止めて描くため、手前の薄いブロック越しに
 * 選択範囲（通常描画側）が透けて見える。
 */
export class FadeStructureRenderer extends Renderer {
  private readonly chunkBuilder: ChunkBuilder;
  /**
   * この ChunkBuilder のチャンクサイズ。`IncrementalSplitView` が構築時に
   * 自分の設定と突き合わせるために読む (不一致だと部分更新が別のチャンクを
   * 再構築してしまい、「特定のブロックだけ消せない」形のバグになる)。
   */
  readonly chunkSize: readonly [number, number, number];
  private readonly fadeProgram: WebGLProgram;
  private readonly lineProgram: WebGLProgram;
  private readonly atlasTexture: WebGLTexture;
  private readonly resources: Resources;
  // 毎フレームの gl.getUniformLocation (driver 往復) を避けるため生成時に 1 回だけ引く
  private readonly fadeAlphaLoc: WebGLUniformLocation | null;
  private readonly fadeDesatLoc: WebGLUniformLocation | null;
  // 枠線/ホバー/ドラッグは更新のたびに new Mesh すると旧 GL バッファが
  // 解放されないため、単一 Mesh を使い回す (clear → addLineCube → rebuild)。
  private readonly boxMesh = new Mesh();
  private boxActive = false;
  private readonly hoverMesh = new Mesh();
  private hoverActive = false;
  private readonly dragMesh = new Mesh();
  private dragActive = false;

  constructor(
    gl: WebGLRenderingContext,
    structure: StructureProvider,
    resources: Resources,
    // StructureRenderer 側と同じ atlas を使う場合に注入する (二重 GPU アップロード回避)。
    // 注入側でミップマップ/フィルタ設定済みであること。
    sharedAtlasTexture?: WebGLTexture,
    options?: FadeStructureRendererOptions,
  ) {
    super(gl);
    this.resources = resources;
    const chunkSize = options?.chunkSize ?? 16;
    this.chunkSize =
      typeof chunkSize === "number"
        ? [chunkSize, chunkSize, chunkSize]
        : [chunkSize[0], chunkSize[1], chunkSize[2]];
    this.chunkBuilder = new ChunkBuilder(gl, structure, resources, chunkSize);
    this.fadeProgram = new ShaderProgram(gl, vsFade, fsFade).getProgram();
    this.lineProgram = new ShaderProgram(gl, vsLine, fsLine).getProgram();
    this.fadeAlphaLoc = gl.getUniformLocation(this.fadeProgram, "fadeAlpha");
    this.fadeDesatLoc = gl.getUniformLocation(this.fadeProgram, "fadeDesat");
    if (sharedAtlasTexture) {
      this.atlasTexture = sharedAtlasTexture;
    } else {
      this.atlasTexture = this.createAtlasTexture(resources.getTextureAtlas());
      // 通常描画側と同様、ミップマップによる UV ブリードを防ぐ
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  setStructure(structure: StructureProvider) {
    this.chunkBuilder.setStructure(structure);
  }

  /**
   * チャンクメッシュの再構築。`deepslate` の `StructureRenderer` と同じシグネチャ。
   *
   * `chunkPositions` を渡すとそのチャンクだけを再構築する (構造体を in-place で
   * 書き換えた後のピック差分用)。`applyDeepslatePatches({ fastPartialChunkUpdate: true })`
   * を併用すると走査が構造体のブロック数に依存しなくなる。
   */
  updateStructureBuffers(chunkPositions?: vec3[]) {
    this.chunkBuilder.updateStructureBuffers(chunkPositions);
  }

  drawFadedStructure(viewMatrix: mat4, fadeAlpha: number, fadeDesat: number) {
    if (fadeAlpha <= 0) return;
    const gl = this.gl;
    this.setShader(this.fadeProgram);
    const getPixelSize = (this.resources as { getPixelSize?: () => number }).getPixelSize;
    this.setTexture(this.atlasTexture, getPixelSize?.call(this.resources));
    this.prepareDraw(viewMatrix);
    gl.uniform1f(this.fadeAlphaLoc, fadeAlpha);
    gl.uniform1f(this.fadeDesatLoc, fadeDesat);
    // 薄いブロック同士・選択範囲との前後関係で消えないよう深度書き込みを止める
    gl.depthMask(false);
    this.chunkBuilder.getMeshes().forEach((mesh) => {
      this.drawMesh(mesh, { pos: true, color: true, texture: true, normal: true });
    });
    gl.depthMask(true);
  }

  /** 選択範囲の枠線。複数範囲を 1 つのラインメッシュにまとめる */
  setSelectionBoxes(boxes: SelectionBox[]) {
    if (!boxes.length) {
      this.boxActive = false;
      return;
    }
    this.boxMesh.clear();
    for (const box of boxes) {
      this.boxMesh.addLineCube(
        box.min[0],
        box.min[1],
        box.min[2],
        box.max[0] + 1,
        box.max[1] + 1,
        box.max[2] + 1,
        box.color,
      );
    }
    this.boxMesh.rebuild(this.gl, { pos: true, color: true });
    this.boxActive = true;
  }

  drawSelectionBoxes(viewMatrix: mat4) {
    if (!this.boxActive) return;
    this.setShader(this.lineProgram);
    this.prepareDraw(viewMatrix);
    this.drawMesh(this.boxMesh, { pos: true, color: true });
  }

  /** ピックモードのホバー中ブロックのアウトライン。null でクリア */
  setHoverBlock(
    pos: [number, number, number] | null,
    color: [number, number, number] = [1, 1, 1],
  ) {
    if (!pos) {
      this.hoverActive = false;
      return;
    }
    const E = 0.02;
    this.hoverMesh.clear();
    this.hoverMesh.addLineCube(
      pos[0] - E,
      pos[1] - E,
      pos[2] - E,
      pos[0] + 1 + E,
      pos[1] + 1 + E,
      pos[2] + 1 + E,
      color,
    );
    this.hoverMesh.rebuild(this.gl, { pos: true, color: true });
    this.hoverActive = true;
  }

  drawHoverBlock(viewMatrix: mat4) {
    if (!this.hoverActive) return;
    this.setShader(this.lineProgram);
    this.prepareDraw(viewMatrix);
    this.drawMesh(this.hoverMesh, { pos: true, color: true });
  }

  /** ピックモードのドラッグ範囲プレビューボックス。null でクリア */
  setDragPreview(box: SelectionBox | null) {
    if (!box) {
      this.dragActive = false;
      return;
    }
    this.dragMesh.clear();
    this.dragMesh.addLineCube(
      box.min[0],
      box.min[1],
      box.min[2],
      box.max[0] + 1,
      box.max[1] + 1,
      box.max[2] + 1,
      box.color,
    );
    this.dragMesh.rebuild(this.gl, { pos: true, color: true });
    this.dragActive = true;
  }

  drawDragPreview(viewMatrix: mat4) {
    if (!this.dragActive) return;
    this.setShader(this.lineProgram);
    this.prepareDraw(viewMatrix);
    this.drawMesh(this.dragMesh, { pos: true, color: true });
  }
}
