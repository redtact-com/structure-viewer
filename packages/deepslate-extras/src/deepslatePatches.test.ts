// deepslatePatches の正確性テスト。
//
// パッチは「速くするが出力は変えない」ことが生命線なので、
// (i) パッチ前後で ChunkBuilder が生成する全 GPU バッファのビット一致
// (ii) 16385 quads (65536 頂点超) で Uint32 index が正しく出ること
// (iii) merge の結果同一性
// (iv) releaseQuadsAfterUpload が出力を変えず、再 setStructure でも壊れないこと
// を mock GL で検証する。
//
// 注意: prototype 差し替えはモジュールレジストリ単位のグローバル変更なので、
// 「パッチ前」の出力はモジュール評価時 (applyDeepslatePatches 呼び出し前) に
// 採取している。vitest はファイルごとに isolate されるため他テストへ影響しない。
import { describe, expect, it } from "vitest";
import { Structure } from "deepslate/core";
import {
  BlockDefinition,
  BlockModel,
  ChunkBuilder,
  Mesh,
  Quad,
  Renderer,
  Vector,
  Vertex,
} from "deepslate/render";
import type { Resources } from "deepslate/render";
import { applyDeepslatePatches } from "./deepslatePatches";

// ── mock GL: bufferData の内容をバッファオブジェクト単位で記録 ──────────

interface RecordedBuffer {
  target: number;
  data: Float32Array | Uint16Array | Uint32Array;
}

function createMockGl() {
  const buffers = new Map<WebGLBuffer, RecordedBuffer>();
  let id = 0;
  let boundArray: WebGLBuffer | null = null;
  let boundElement: WebGLBuffer | null = null;
  const ARRAY_BUFFER = 0x8892;
  const ELEMENT_ARRAY_BUFFER = 0x8893;
  const gl = {
    ARRAY_BUFFER,
    ELEMENT_ARRAY_BUFFER,
    DYNAMIC_DRAW: 0x88e8,
    createBuffer: () => ({ id: ++id }),
    deleteBuffer: (b: WebGLBuffer) => {
      buffers.delete(b);
    },
    bindBuffer: (target: number, b: WebGLBuffer | null) => {
      if (target === ARRAY_BUFFER) boundArray = b;
      else boundElement = b;
    },
    bufferData: (target: number, data: Float32Array | Uint16Array | Uint32Array) => {
      const b = target === ARRAY_BUFFER ? boundArray : boundElement;
      if (b) buffers.set(b, { target, data: data.slice() });
    },
  };
  return { gl: gl as unknown as WebGLRenderingContext, buffers };
}

// ── mock resources: cube (フル) + fin (回転付き部分要素) の 2 モデル ────

function createMockResources(): Resources {
  const cubeJson = {
    textures: { all: "block/stone" },
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          up: { texture: "#all", cullface: "up" },
          down: { texture: "#all", cullface: "down" },
          north: { texture: "#all", cullface: "north" },
          south: { texture: "#all", cullface: "south" },
          east: { texture: "#all", cullface: "east" },
          west: { texture: "#all", cullface: "west" },
        },
      },
    ],
  };
  // 回転付き・非整数座標の要素。法線/座標が非自明な float になり、
  // ビット一致検証として意味のある値域を作る。
  const finJson = {
    textures: { all: "block/fin" },
    elements: [
      {
        from: [0.8, 0, 7.2],
        to: [15.2, 12.8, 8.8],
        rotation: { origin: [8, 8, 8], axis: "y", angle: 22.5, rescale: true },
        faces: {
          up: { texture: "#all" },
          down: { texture: "#all" },
          north: { texture: "#all" },
          south: { texture: "#all" },
          east: { texture: "#all" },
          west: { texture: "#all" },
        },
      },
    ],
  };
  const models = new Map<string, BlockModel>([
    ["stone", BlockModel.fromJson(cubeJson)],
    ["planks", BlockModel.fromJson({ ...cubeJson, textures: { all: "block/planks" } })],
    ["glassy", BlockModel.fromJson({ ...cubeJson, textures: { all: "block/glassy" } })],
    ["fin", BlockModel.fromJson(finJson)],
  ]);
  const provider = {
    getBlockModel: (id: { path: string }) => models.get(id.path.replace("block/", "")) ?? null,
  };
  for (const m of models.values()) m.flatten(provider as never);
  const defs = new Map<string, BlockDefinition>();
  for (const name of models.keys()) {
    defs.set(name, BlockDefinition.fromJson({ variants: { "": { model: `block/${name}` } } }));
  }
  return {
    getBlockDefinition: (id: { path: string }) => defs.get(id.path) ?? null,
    getBlockModel: (id: { path: string }) => provider.getBlockModel(id),
    // テクスチャごとに異なる UV を返し、texture/textureLimit バッファに変化をつける
    getTextureUV: (id: { path: string }) => {
      let h = 0;
      for (const c of id.path) h += c.charCodeAt(0);
      const u = (h % 16) / 32;
      const v = ((h >> 2) % 16) / 32;
      return [u, v, u + 1 / 32, v + 1 / 32];
    },
    getTextureAtlas: () => null,
    getBlockFlags: (id: { path: string }) => ({
      opaque: id.path === "stone" || id.path === "planks",
      semi_transparent: id.path === "glassy",
    }),
    getBlockProperties: () => null,
    getDefaultBlockProperties: () => null,
    getPixelSize: () => 1 / 512,
  } as unknown as Resources;
}

// ── 決定的な合成構造体 (12x8x12, 複数チャンク・透過/不透過混在) ────────

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  };
}

const FIXTURE_NAMES = [
  "minecraft:stone",
  "minecraft:planks",
  "minecraft:glassy",
  "minecraft:fin",
] as const;

function buildFixtureStructure(): Structure {
  const rand = rng(42);
  const s = new Structure([12, 8, 12]);
  for (let x = 0; x < 12; x++) {
    for (let y = 0; y < 8; y++) {
      for (let z = 0; z < 12; z++) {
        // air 判定と材質選択は別の乱数にする。r を再利用すると r < 0.6 の値域から
        // Math.floor(r*4) ≤ 2 となり、index 3 の fin (回転付き・非整数座標要素) が
        // 一度も配置されず、丸め/精度系リグレッションを検出できなくなる。
        if (rand() >= 0.6) continue; // air
        s.addBlock([x, y, z], FIXTURE_NAMES[Math.floor(rand() * FIXTURE_NAMES.length)]);
      }
    }
  }
  return s;
}

// ── スナップショット採取 ────────────────────────────────────────────────

interface MeshSnapshot {
  quadIndices: number;
  pos?: RecordedBuffer;
  color?: RecordedBuffer;
  texture?: RecordedBuffer;
  textureLimit?: RecordedBuffer;
  normal?: RecordedBuffer;
  blockPos?: RecordedBuffer;
  index?: RecordedBuffer;
}

function snapshotChunkBuilder(cb: ChunkBuilder, buffers: Map<WebGLBuffer, RecordedBuffer>) {
  return cb.getMeshes().map((m): MeshSnapshot => {
    const get = (b: WebGLBuffer | undefined) => (b ? buffers.get(b) : undefined);
    return {
      quadIndices: m.quadIndices(),
      pos: get(m.posBuffer),
      color: get(m.colorBuffer),
      texture: get(m.textureBuffer),
      textureLimit: get(m.textureLimitBuffer),
      normal: get(m.normalBuffer),
      blockPos: get(m.blockPosBuffer),
      index: get(m.indexBuffer),
    };
  });
}

function buildAndSnapshot() {
  const { gl, buffers } = createMockGl();
  const cb = new ChunkBuilder(gl, buildFixtureStructure(), createMockResources(), 8);
  return { cb, buffers, snap: snapshotChunkBuilder(cb, buffers) };
}

function toBytes(a: RecordedBuffer["data"]): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

/** Float32 バッファのビット一致 (NaN 含め byte 単位) */
function expectSameBits(actual: RecordedBuffer | undefined, expected: RecordedBuffer | undefined) {
  expect(actual === undefined).toBe(expected === undefined);
  if (!actual || !expected) return;
  expect(actual.data.constructor.name).toBe(expected.data.constructor.name);
  expect(actual.data.length).toBe(expected.data.length);
  const a = toBytes(actual.data);
  const b = toBytes(expected.data);
  let mismatch = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      mismatch = i;
      break;
    }
  }
  expect(mismatch).toBe(-1);
}

/** index バッファは型が Uint16→Uint32 に変わるので数値列として比較 */
function expectSameIndexValues(
  actual: RecordedBuffer | undefined,
  expected: RecordedBuffer | undefined,
) {
  expect(actual === undefined).toBe(expected === undefined);
  if (!actual || !expected) return;
  expect(actual.data.length).toBe(expected.data.length);
  let mismatch = -1;
  for (let i = 0; i < actual.data.length; i++) {
    if (actual.data[i] !== expected.data[i]) {
      mismatch = i;
      break;
    }
  }
  expect(mismatch).toBe(-1);
}

function expectSnapshotsEqual(actual: MeshSnapshot[], expected: MeshSnapshot[]) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    expect(actual[i].quadIndices).toBe(expected[i].quadIndices);
    expectSameBits(actual[i].pos, expected[i].pos);
    expectSameBits(actual[i].color, expected[i].color);
    expectSameBits(actual[i].texture, expected[i].texture);
    expectSameBits(actual[i].textureLimit, expected[i].textureLimit);
    expectSameBits(actual[i].normal, expected[i].normal);
    expectSameBits(actual[i].blockPos, expected[i].blockPos);
    expectSameIndexValues(actual[i].index, expected[i].index);
  }
}

// ── パッチ前の基準出力をモジュール評価時に採取 (applyDeepslatePatches 前) ──

const originalRebuild = Mesh.prototype.rebuild;
const originalMerge = Mesh.prototype.merge;
const pristine = buildAndSnapshot();

// line-only メッシュ (FadeRenderer の枠線経路) の基準
function buildLineMesh(): Mesh {
  const m = new Mesh();
  m.addLineCube(0.5, 1.25, -0.75, 3.5, 4.25, 2.25, [1, 0.25, 0.25]);
  m.addLineCube(-2, 0, 0, 6, 3, 9, [0.2, 0.9, 0.4]);
  return m;
}
const pristineLines = (() => {
  const { gl, buffers } = createMockGl();
  const m = buildLineMesh();
  originalRebuild.call(m, gl, { pos: true, color: true });
  return {
    pos: m.linePosBuffer ? buffers.get(m.linePosBuffer) : undefined,
    color: m.lineColorBuffer ? buffers.get(m.lineColorBuffer) : undefined,
  };
})();

// ここでパッチ適用。以降の Mesh/Renderer はパッチ済み prototype で動く。
applyDeepslatePatches({ releaseQuadsAfterUpload: false });

describe("applyDeepslatePatches", () => {
  it("冪等: 2 回目以降の呼び出しで再差し替えしない", () => {
    const patched = Mesh.prototype.rebuild;
    expect(patched).not.toBe(originalRebuild);
    applyDeepslatePatches();
    expect(Mesh.prototype.rebuild).toBe(patched);
  });

  it("fixture: 全材質が配置される (特に fin — 回転付き・非整数座標要素の検証値域)", () => {
    const counts = new Map<string, number>();
    for (const b of buildFixtureStructure().getBlocks()) {
      const name = b.state.getName().toString();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const name of FIXTURE_NAMES) {
      expect(counts.get(name) ?? 0, name).toBeGreaterThan(0);
    }
  });

  it("(i) rebuild: パッチ前後で全チャンクメッシュの GPU バッファがビット一致する", () => {
    const { snap } = buildAndSnapshot();
    // fixture が空でないこと (テスト自体の健全性)
    expect(snap.length).toBeGreaterThan(1);
    expect(snap.some((s) => s.quadIndices > 0)).toBe(true);
    expectSnapshotsEqual(snap, pristine.snap);
  });

  it("(i) rebuild: パッチ後の index buffer は Uint32Array", () => {
    const { snap } = buildAndSnapshot();
    for (const s of snap) {
      if (s.index) expect(s.index.data).toBeInstanceOf(Uint32Array);
    }
  });

  it("(i) rebuild: line-only メッシュ ({pos, color} 部分 rebuild) もビット一致する", () => {
    const { gl, buffers } = createMockGl();
    const m = buildLineMesh();
    m.rebuild(gl, { pos: true, color: true });
    expectSameBits(
      m.linePosBuffer ? buffers.get(m.linePosBuffer) : undefined,
      pristineLines.pos,
    );
    expectSameBits(
      m.lineColorBuffer ? buffers.get(m.lineColorBuffer) : undefined,
      pristineLines.color,
    );
  });

  it("(ii) rebuild: 16385 quads で 65536 以上の index を正しく出す (Uint16 なら wrap する値)", () => {
    const quadCount = 16385;
    const dummyQuad = () =>
      new Quad(
        Vertex.fromPos(new Vector(0, 0, 0)),
        Vertex.fromPos(new Vector(1, 0, 0)),
        Vertex.fromPos(new Vector(1, 1, 0)),
        Vertex.fromPos(new Vector(0, 1, 0)),
      );
    const { gl, buffers } = createMockGl();
    const mesh = new Mesh(Array.from({ length: quadCount }, dummyQuad));
    mesh.rebuild(gl, {});
    const rec = mesh.indexBuffer ? buffers.get(mesh.indexBuffer) : undefined;
    expect(rec).toBeDefined();
    const data = rec!.data;
    expect(data).toBeInstanceOf(Uint32Array);
    expect(data.length).toBe(quadCount * 6);
    expect([...data.slice(0, 12)]).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    // 最終 quad は頂点 65536..65539 を参照する。Uint16 だと 0..3 に wrap していた
    expect([...data.slice(-6)]).toEqual([65536, 65537, 65538, 65536, 65538, 65539]);
  });

  it("(iii) merge: 原実装 (concat) と同一の並び・同一要素になり this を返す", () => {
    const quad = (x: number) =>
      new Quad(
        Vertex.fromPos(new Vector(x, 0, 0)),
        Vertex.fromPos(new Vector(x + 1, 0, 0)),
        Vertex.fromPos(new Vector(x + 1, 1, 0)),
        Vertex.fromPos(new Vector(x, 1, 0)),
      );
    const q1 = [quad(0), quad(1)];
    const q2 = [quad(10), quad(11), quad(12)];
    const other = new Mesh([...q2]);
    other.addLine(0, 0, 0, 1, 1, 1, [1, 1, 1]);

    const reference = new Mesh([...q1]);
    originalMerge.call(reference, other);
    const patched = new Mesh([...q1]);
    const returned = patched.merge(other);

    expect(returned).toBe(patched);
    expect(patched.quads.length).toBe(reference.quads.length);
    for (let i = 0; i < reference.quads.length; i++) {
      expect(patched.quads[i]).toBe(reference.quads[i]);
    }
    expect(patched.lines.length).toBe(reference.lines.length);
    for (let i = 0; i < reference.lines.length; i++) {
      expect(patched.lines[i]).toBe(reference.lines[i]);
    }
    // other 側は無変更
    expect(other.quads.length).toBe(3);
    expect(other.lines.length).toBe(1);
  });

  describe("(iv) releaseQuadsAfterUpload", () => {
    it("出力バッファはビット一致のまま quads が解放され、描画用カウントは保持される", () => {
      applyDeepslatePatches({ releaseQuadsAfterUpload: true });
      try {
        const { gl, buffers } = createMockGl();
        const cb = new ChunkBuilder(gl, buildFixtureStructure(), createMockResources(), 8);
        const snap = snapshotChunkBuilder(cb, buffers);
        expectSnapshotsEqual(snap, pristine.snap);

        const meshes = cb.getMeshes();
        expect(meshes.length).toBe(pristine.snap.length);
        for (let i = 0; i < meshes.length; i++) {
          const m = meshes[i];
          // CPU 側 quads は解放済み
          expect(m.quads.length).toBe(0);
          // 描画に使うカウントと isEmpty は解放前の値を維持
          expect(m.quadIndices()).toBe(pristine.snap[i].quadIndices);
          expect(m.quadVertices()).toBe((pristine.snap[i].quadIndices / 6) * 4);
          expect(m.isEmpty()).toBe(false);
        }
      } finally {
        applyDeepslatePatches({ releaseQuadsAfterUpload: false });
      }
    });

    it("解放後の再 rebuild は GL バッファを破棄せずに維持する", () => {
      applyDeepslatePatches({ releaseQuadsAfterUpload: true });
      try {
        const { gl, buffers } = createMockGl();
        const cb = new ChunkBuilder(gl, buildFixtureStructure(), createMockResources(), 8);
        const mesh = cb.getMeshes().find((m) => m.quadIndices() > 0)!;
        const indexBuffer = mesh.indexBuffer!;
        const before = buffers.get(indexBuffer)!.data;
        mesh.rebuild(gl, { pos: true, color: true, texture: true, normal: true, blockPos: true });
        expect(mesh.indexBuffer).toBe(indexBuffer);
        expect(buffers.get(indexBuffer)!.data).toEqual(before);
      } finally {
        applyDeepslatePatches({ releaseQuadsAfterUpload: false });
      }
    });

    it("再 setStructure (clear() から再構築) しても出力がビット一致する", () => {
      applyDeepslatePatches({ releaseQuadsAfterUpload: true });
      try {
        const { gl, buffers } = createMockGl();
        const cb = new ChunkBuilder(gl, buildFixtureStructure(), createMockResources(), 8);
        cb.setStructure(buildFixtureStructure());
        const snap = snapshotChunkBuilder(cb, buffers);
        expectSnapshotsEqual(snap, pristine.snap);
      } finally {
        applyDeepslatePatches({ releaseQuadsAfterUpload: false });
      }
    });
  });

  describe("(c) attrib/uniform location キャッシュ", () => {
    function createRendererMockGl() {
      const counts = { attr: 0, uniform: 0 };
      const attrNames = new Map<string, number>();
      const gl = {
        VERTEX_SHADER: 1,
        FRAGMENT_SHADER: 2,
        LINK_STATUS: 3,
        COMPILE_STATUS: 4,
        DEPTH_TEST: 5,
        LEQUAL: 6,
        BLEND: 7,
        SRC_ALPHA: 8,
        ONE_MINUS_SRC_ALPHA: 9,
        CULL_FACE: 10,
        BACK: 11,
        ARRAY_BUFFER: 0x8892,
        ELEMENT_ARRAY_BUFFER: 0x8893,
        DYNAMIC_DRAW: 0x88e8,
        TRIANGLES: 12,
        LINES: 13,
        FLOAT: 14,
        UNSIGNED_INT: 15,
        canvas: { clientWidth: 320, clientHeight: 240 },
        createProgram: () => ({}),
        createShader: () => ({}),
        shaderSource: () => {},
        compileShader: () => {},
        getShaderParameter: () => true,
        attachShader: () => {},
        linkProgram: () => {},
        getProgramParameter: () => true,
        enable: () => {},
        depthFunc: () => {},
        blendFunc: () => {},
        cullFace: () => {},
        useProgram: () => {},
        createBuffer: () => ({}),
        bindBuffer: () => {},
        bufferData: () => {},
        deleteBuffer: () => {},
        vertexAttribPointer: () => {},
        enableVertexAttribArray: () => {},
        drawElements: () => {},
        drawArrays: () => {},
        uniformMatrix4fv: () => {},
        uniform1f: () => {},
        getAttribLocation: (_p: unknown, name: string) => {
          counts.attr++;
          if (!attrNames.has(name)) attrNames.set(name, attrNames.size);
          return attrNames.get(name)!;
        },
        getUniformLocation: () => {
          counts.uniform++;
          return {};
        },
      };
      return { gl: gl as unknown as WebGLRenderingContext, counts };
    }

    class ExposedRenderer extends Renderer {
      drawFrame(mesh: Mesh) {
        this.prepareDraw(new Float32Array(16) as unknown as Parameters<Renderer["prepareDraw"]>[0]);
        this.drawMesh(mesh, { pos: true, color: true, texture: true, normal: true });
      }
    }

    it("2 フレーム目以降は getAttribLocation / getUniformLocation を呼ばない", () => {
      const { gl, counts } = createRendererMockGl();
      const renderer = new ExposedRenderer(gl);
      const mesh = new Mesh([
        new Quad(
          Vertex.fromPos(new Vector(0, 0, 0)),
          Vertex.fromPos(new Vector(1, 0, 0)),
          Vertex.fromPos(new Vector(1, 1, 0)),
          Vertex.fromPos(new Vector(0, 1, 0)),
        ),
      ]);
      mesh.computeNormals();
      mesh.rebuild(gl, { pos: true, color: true, texture: true, normal: true });

      renderer.drawFrame(mesh);
      const attrAfterFirst = counts.attr;
      const uniformAfterFirst = counts.uniform;
      // 1 フレーム目はユニーク名ぶんだけ lookup が走る
      expect(attrAfterFirst).toBe(5); // vertPos, vertColor, texCoord, texLimit, normal
      expect(uniformAfterFirst).toBe(3); // mView, mProj, pixelSize

      for (let i = 0; i < 10; i++) renderer.drawFrame(mesh);
      expect(counts.attr).toBe(attrAfterFirst);
      expect(counts.uniform).toBe(uniformAfterFirst);
    });
  });
});
