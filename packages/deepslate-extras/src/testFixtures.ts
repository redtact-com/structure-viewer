// テスト用の共有フィクスチャ (mock GL / mock resources / 合成構造体 /
// GPU バッファからの quad 集合抽出)。
//
// 公開 API ではない (index.ts から export しておらず、files に src を含めていないので
// パッケージには入らない)。テスト間で mock がずれると比較の意味が失われるため集約している。

import { Structure } from "deepslate/core";
import { BlockDefinition, BlockModel, ChunkBuilder } from "deepslate/render";
import type { Mesh, Resources } from "deepslate/render";

// ── mock GL: bufferData の内容をバッファオブジェクト単位で記録 ──────────

export interface RecordedBuffer {
  target: number;
  data: Float32Array | Uint16Array | Uint32Array;
}

export interface MockGl {
  gl: WebGLRenderingContext;
  buffers: Map<WebGLBuffer, RecordedBuffer>;
}

export function createMockGl(): MockGl {
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

// ── mock resources ─────────────────────────────────────────────────────
// cube (フル) と fin (回転付き・非整数座標) の 2 形状。
// opaque を多めにしてカリング差分が出やすい条件にする。

const CUBE_JSON = {
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

const FIN_JSON = {
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

/** 不透明ブロック (隣接面が静的カリングされる) */
const OPAQUE = new Set(["stone", "planks", "lamp"]);
/** 半透明ブロック (transparentMesh へ入る) */
const SEMI_TRANSPARENT = new Set(["glassy"]);

export const FIXTURE_NAMES = [
  "minecraft:stone",
  "minecraft:planks",
  "minecraft:glassy",
  "minecraft:fin",
  "minecraft:lamp",
] as const;

export function createMockResources(): Resources {
  const models = new Map<string, BlockModel>([
    ["stone", BlockModel.fromJson(CUBE_JSON)],
    ["planks", BlockModel.fromJson({ ...CUBE_JSON, textures: { all: "block/planks" } })],
    ["glassy", BlockModel.fromJson({ ...CUBE_JSON, textures: { all: "block/glassy" } })],
    ["lamp", BlockModel.fromJson({ ...CUBE_JSON, textures: { all: "block/lamp" } })],
    ["fin", BlockModel.fromJson(FIN_JSON)],
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
    getTextureUV: (id: { path: string }) => {
      let h = 0;
      for (const c of id.path) h += c.charCodeAt(0);
      const u = (h % 16) / 32;
      const v = ((h >> 2) % 16) / 32;
      return [u, v, u + 1 / 32, v + 1 / 32];
    },
    getTextureAtlas: () => null,
    getBlockFlags: (id: { path: string }) => ({
      opaque: OPAQUE.has(id.path),
      semi_transparent: SEMI_TRANSPARENT.has(id.path),
    }),
    getBlockProperties: () => null,
    getDefaultBlockProperties: () => null,
    getPixelSize: () => 1 / 512,
  } as unknown as Resources;
}

// ── 決定的な合成構造体 ─────────────────────────────────────────────────

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  };
}

/**
 * ブロックを blocks 配列へ積む順序。
 * - `ascending`  — x→y→z 昇順 (= 平坦化 index 昇順。MC 純正セーブ相当)
 * - `zyx`        — z→y→x 順 (litematica 由来の変換物のように昇順でないもの)
 * - `reversed`   — 完全な逆順
 */
export type FixtureOrder = "ascending" | "zyx" | "reversed";

/**
 * 一辺 `size` の立方体に密度 `density` でブロックを敷き詰めた構造体。
 * air 判定と材質選択で乱数を分けている (同じ値を使い回すと値域が偏り、
 * 最後の材質 = fin が一度も置かれなくなる)。
 *
 * `order` で blocks 配列の並びを変えられる。`ascending` 以外は
 * 「正規化されていない構造体」の再現に使う。
 */
export function buildFixtureStructure(
  size = 16,
  density = 0.5,
  seed = 42,
  order: FixtureOrder = "ascending",
  names: readonly string[] = FIXTURE_NAMES,
): Structure {
  const rand = rng(seed);
  const picked: [number, number, number, string][] = [];
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        if (rand() >= density) continue;
        picked.push([x, y, z, names[Math.floor(rand() * names.length)]]);
      }
    }
  }
  if (order === "reversed") picked.reverse();
  else if (order === "zyx") {
    picked.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
  }
  const s = new Structure([size, size, size]);
  for (const [x, y, z, name] of picked) s.addBlock([x, y, z], name);
  return s;
}

// ── GPU バッファからの quad 抽出 ───────────────────────────────────────
//
// pos / normal / texture を連結したものを quad のキーにする。
//
// **並び順は描画結果に効く** (半透明の over 合成 / FadeRenderer の depthMask(false))。
// そのため比較モードを 2 つ持つ:
//   ordered: false — キーをソートして集合として比較 (「同じ quad が揃っているか」)
//   ordered: true  — バッファ内の並びのまま比較 (「描画順まで一致しているか」)
// 順序一致は blocks が平坦化 index 昇順に正規化されている前提で成り立つ。

interface MeshBuffers {
  posBuffer?: WebGLBuffer;
  normalBuffer?: WebGLBuffer;
  textureBuffer?: WebGLBuffer;
}

function quadKeys(
  mesh: MeshBuffers,
  buffers: Map<WebGLBuffer, RecordedBuffer>,
  ordered: boolean,
): string[] {
  const pos = mesh.posBuffer ? buffers.get(mesh.posBuffer)?.data : undefined;
  if (!pos) return [];
  const normal = mesh.normalBuffer ? buffers.get(mesh.normalBuffer)?.data : undefined;
  const texture = mesh.textureBuffer ? buffers.get(mesh.textureBuffer)?.data : undefined;
  const count = pos.length / 12;
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = Array.from(pos.slice(i * 12, i * 12 + 12));
    const n = normal ? Array.from(normal.slice(i * 12, i * 12 + 12)) : [];
    const t = texture ? Array.from(texture.slice(i * 8, i * 8 + 8)) : [];
    keys.push(`${p.join(",")}|${n.join(",")}|${t.join(",")}`);
  }
  if (!ordered) keys.sort();
  return keys;
}

interface ChunkMeshes {
  mesh: Mesh;
  transparentMesh: Mesh;
}

/**
 * ChunkBuilder が保持する全チャンクの quad を「チャンク座標 → キー列」で返す。
 * quad をチャンクごとに分けて比較するので、「別チャンクに紛れ込んだ」も検出できる。
 *
 * @param ordered true なら並び順も含めて比較する (描画順の一致検証用)
 */
export function chunkQuadSets(
  cb: ChunkBuilder,
  buffers: Map<WebGLBuffer, RecordedBuffer>,
  ordered = false,
): Map<string, string> {
  const chunks = (cb as unknown as { chunks: (ChunkMeshes | undefined)[][][] }).chunks;
  const out = new Map<string, string>();
  chunks.forEach((xa, xi) =>
    xa?.forEach((ya, yi) =>
      ya?.forEach((chunk, zi) => {
        if (!chunk) return;
        for (const [tag, mesh] of [
          ["opaque", chunk.mesh],
          ["transparent", chunk.transparentMesh],
        ] as const) {
          const keys = quadKeys(mesh as unknown as MeshBuffers, buffers, ordered);
          if (keys.length === 0) continue;
          out.set(`${xi},${yi},${zi},${tag}`, `${keys.length}\n${keys.join("\n")}`);
        }
      }),
    ),
  );
  return out;
}

/** チャンク数と各チャンクの quad 集合が一致するか (差分は最初の不一致チャンクで報告) */
export function diffChunkQuadSets(
  actual: Map<string, string>,
  expected: Map<string, string>,
): string | null {
  const keys = new Set([...actual.keys(), ...expected.keys()]);
  for (const key of [...keys].sort()) {
    const a = actual.get(key);
    const b = expected.get(key);
    if (a === b) continue;
    if (a === undefined) return `チャンク ${key}: 期待側にのみ存在 (${b?.split("\n")[0]} quads)`;
    if (b === undefined) return `チャンク ${key}: 実際側にのみ存在 (${a.split("\n")[0]} quads)`;
    const an = a.split("\n");
    const bn = b.split("\n");
    if (an[0] !== bn[0]) return `チャンク ${key}: quad 数 ${an[0]} != ${bn[0]}`;
    return `チャンク ${key}: quad 集合が異なる`;
  }
  return null;
}
