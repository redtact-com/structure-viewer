// 3D ビューアーパイプラインの CPU 側マイクロベンチ (GL スタブ、GPU 転送は含まない)。
//
// 使い方 (packages/deepslate-extras/ で実行):
//   node tools/bench-viewer.mjs                 # 既定: --size 32, パッチ適用
//   node tools/bench-viewer.mjs --size 64       # 32 | 48 | 64 (一辺、fill 率 50%)
//   node tools/bench-viewer.mjs --no-patch      # 素の deepslate (runtime patch なし)
//
// before/after 比較は同条件で 2 回実行して並べる:
//   node tools/bench-viewer.mjs --size 48 --no-patch
//   node tools/bench-viewer.mjs --size 48
//
// 計測項目:
//   [1] NbtFile.read + Structure.fromNbt      — 構造体ロード
//   [2] ChunkBuilder full mesh (初回)          — 初回ロードの全メッシュ構築
//   [3] setStructure re-mesh                   — specs/crop/slice 変更時の再メッシュ
//   [4] splitStructure + inner/outer 2 レンダラ — フォーカス表示の実経路
//   [5] getMeshes() x100                       — draw loop 毎フレームコスト
//   [6] ヒープ残留 (heapUsed)                   — releaseQuadsAfterUpload の効果
//   [7] 部分更新 (ピック / ドラッグ)             — 全再構築 vs 影響チャンクだけ再メッシュ。
//                                                patch (e) の有無も同一条件で A/B する
//
// 実装メモ: パッチ実体 (src/deepslatePatches.ts) を直接 import するため、
// node の型ストリップ (--experimental-strip-types) が必要。未指定で起動された場合は
// 必要フラグ付きで自動的に再実行する。
import { fileURLToPath } from "node:url";

// ── 必要フラグ付きで自己再実行 ──────────────────────────────────────────
if (!process.execArgv.includes("--experimental-strip-types")) {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--expose-gc",
      "--no-warnings",
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  );
  process.exit(r.status ?? 1);
}

// ── 引数 ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const noPatch = args.includes("--no-patch");
const sizeArg = (() => {
  const i = args.indexOf("--size");
  if (i === -1) return 32;
  const v = Number(args[i + 1]);
  if (![32, 48, 64].includes(v)) {
    console.error("--size は 32 | 48 | 64 のいずれか");
    process.exit(1);
  }
  return v;
})();

const { Structure } = await import("deepslate/core");
const { NbtCompound, NbtFile, NbtInt, NbtList, NbtString, NbtType } = await import(
  "deepslate/nbt"
);
const { BlockDefinition, BlockModel, ChunkBuilder } = await import("deepslate/render");

const { applyDeepslatePatches } = await import("../src/deepslatePatches.ts");
if (!noPatch) {
  // ビューアーと同じ設定 (quads 解放 + 部分更新の高速化) で適用する
  applyDeepslatePatches({ releaseQuadsAfterUpload: true, fastPartialChunkUpdate: true });
}

// 部分更新ベンチ用のヘルパ (relative import を持たないので type-strip でそのまま読める)
const {
  addStoredBlock,
  dirtyChunksFor,
  removeStoredBlock,
  splitStructure: librarySplitStructure,
  structureInternals,
} = await import("../src/splitStructure.ts");

const now = () => performance.now();
const fmt = (ms) => `${ms.toFixed(1)}ms`;
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)}MB`;

// ── 合成構造体: 8 種 Java state・fill 率 50% の決定的乱数 ──────────────
const MATERIALS = [
  ["minecraft:stone", {}],
  ["minecraft:redstone_wire", { power: "0", north: "none", south: "none", east: "none", west: "none" }],
  ["minecraft:repeater", { delay: "1", facing: "north", locked: "false", powered: "false" }],
  ["minecraft:redstone_lamp", { lit: "false" }],
  ["minecraft:oak_planks", {}],
  ["minecraft:piston", { extended: "false", facing: "up" }],
  ["minecraft:observer", { facing: "north", powered: "false" }],
  ["minecraft:comparator", { facing: "north", mode: "compare", powered: "false" }],
];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  };
}

function makeStructureNbtBytes(S, dens) {
  const rand = rng(42);
  const palette = new NbtList(
    MATERIALS.map(([name, props]) => {
      const p = new NbtCompound();
      for (const [k, v] of Object.entries(props)) p.set(k, new NbtString(v));
      return new NbtCompound().set("Name", new NbtString(name)).set("Properties", p);
    }),
    NbtType.Compound,
  );
  const blocks = [];
  for (let x = 0; x < S; x++)
    for (let y = 0; y < S; y++)
      for (let z = 0; z < S; z++) {
        if (rand() >= dens) continue;
        blocks.push(
          new NbtCompound()
            .set("pos", NbtList.make(NbtInt, [x, y, z]))
            .set("state", new NbtInt(Math.floor(rand() * MATERIALS.length))),
        );
      }
  const root = new NbtCompound()
    .set("size", NbtList.make(NbtInt, [S, S, S]))
    .set("palette", palette)
    .set("blocks", new NbtList(blocks, NbtType.Compound))
    .set("DataVersion", new NbtInt(3953));
  const file = NbtFile.create({ compression: "gzip" });
  file.root = root;
  return { bytes: file.write(), count: blocks.length };
}

// ── GL スタブ + 最小 resources (cube モデル) ───────────────────────────
function makeStubGl() {
  let n = 0;
  let bytes = 0;
  return {
    stats: () => ({ buffers: n, bytes }),
    createBuffer: () => ({ id: ++n }),
    bindBuffer: () => {},
    bufferData: (_t, data) => {
      bytes += data.byteLength ?? 0;
    },
    deleteBuffer: () => {},
    ARRAY_BUFFER: 1,
    ELEMENT_ARRAY_BUFFER: 2,
    DYNAMIC_DRAW: 3,
  };
}

function makeResources() {
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
  const cube = BlockModel.fromJson(cubeJson);
  const provider = { getBlockModel: () => cube };
  cube.flatten(provider);
  const def = BlockDefinition.fromJson({ variants: { "": { model: "minecraft:block/cube" } } });
  return {
    getBlockDefinition: () => def,
    getBlockModel: () => cube,
    getTextureUV: () => [0, 0, 1 / 32, 1 / 32],
    getTextureAtlas: () => null,
    getBlockFlags: (id) => (id.path === "stone" || id.path === "oak_planks" ? { opaque: true } : { opaque: false }),
    getPixelSize: () => 1 / 512,
    getBlockProperties: () => null,
    getDefaultBlockProperties: () => null,
  };
}

// ── splitStructure.ts の忠実コピー (アプリの実経路) ────────────────────
function normalizeRegion(region, size) {
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const a = Math.min(region.start[i], region.end[i]);
    const b = Math.max(region.start[i], region.end[i]);
    min[i] = Math.max(0, Math.min(a, size[i] - 1));
    max[i] = Math.max(0, Math.min(b, size[i] - 1));
  }
  return { min, max };
}
function contains(min, max, pos) {
  return (
    pos[0] >= min[0] && pos[0] <= max[0] &&
    pos[1] >= min[1] && pos[1] <= max[1] &&
    pos[2] >= min[2] && pos[2] <= max[2]
  );
}
function splitStructure(full, specs) {
  const size = full.getSize();
  const matchers = specs.map((spec) => ({
    bounds: spec.region ? normalizeRegion(spec.region, size) : null,
    materialSet: spec.materials ? new Set(spec.materials) : null,
    positionSet: spec.positions?.length ? new Set(spec.positions) : null,
  }));
  const inner = new Structure(size);
  const outer = new Structure(size);
  for (const block of full.getBlocks()) {
    const key = `${block.pos[0]},${block.pos[1]},${block.pos[2]}`;
    const isInner = matchers.some(({ bounds, materialSet, positionSet }) => {
      if (positionSet) return positionSet.has(key);
      const inRegion = !bounds || contains(bounds.min, bounds.max, block.pos);
      const inMaterial = !materialSet || materialSet.has(block.state.getName().toString());
      return inRegion && inMaterial;
    });
    const target = isInner ? inner : outer;
    target.addBlock([...block.pos], block.state.getName(), block.state.getProperties(), block.nbt);
  }
  return { inner, outer };
}

function countQuads(cb) {
  // quads 解放パッチ有効時も数えられるよう quadIndices()/6 を使う
  let quads = 0;
  for (const m of cb.getMeshes()) quads += m.quadIndices() / 6;
  return quads;
}

function heapUsed() {
  globalThis.gc?.();
  return process.memoryUsage().heapUsed;
}

// ═══ 実行 ═══════════════════════════════════════════════════════════════
const S = sizeArg;
console.log(`━━━ ${S}^3 fill50% / patch: ${noPatch ? "OFF (素の deepslate)" : "ON (runtime patch + quads 解放)"} ━━━`);
const { bytes, count } = makeStructureNbtBytes(S, 0.5);
console.log(`  nbt.gz ${(bytes.length / 1024).toFixed(0)}KB, blocks=${count}`);

// [1] NBT parse
let t = now();
const file = NbtFile.read(bytes);
const structure = Structure.fromNbt(file.root);
console.log(`  [1] NbtFile.read + fromNbt        : ${fmt(now() - t)}`);

// [2] ChunkBuilder 初回 full mesh
const res = makeResources();
const gl = makeStubGl();
const heapBefore = heapUsed();
t = now();
const cb = new ChunkBuilder(gl, structure, res, 16);
const initMs = now() - t;
const heapAfterBuild = heapUsed();
console.log(
  `  [2] ChunkBuilder full mesh (初回) : ${fmt(initMs)} (quads=${countQuads(cb)}, bufferData=${mb(gl.stats().bytes)})`,
);

// [3] setStructure re-mesh
t = now();
cb.setStructure(structure);
console.log(`  [3] setStructure re-mesh          : ${fmt(now() - t)}`);

// [4] splitStructure + inner/outer 2 レンダラ (フォーカス表示の実経路)
const spec = {
  region: { start: [0, 0, 0], end: [Math.floor(S / 2), S - 1, S - 1] },
  materials: ["minecraft:redstone_wire", "minecraft:repeater"],
};
t = now();
const { inner, outer } = splitStructure(structure, [spec]);
const splitMs = now() - t;
t = now();
const cbInner = new ChunkBuilder(makeStubGl(), inner, res, 16);
const innerMs = now() - t;
t = now();
const cbOuter = new ChunkBuilder(makeStubGl(), outer, res, 16);
const outerMs = now() - t;
console.log(
  `  [4] split+inner/outer 2 レンダラ  : ${fmt(splitMs + innerMs + outerMs)} (split=${fmt(splitMs)}, inner=${fmt(innerMs)}/${countQuads(cbInner)}q, outer=${fmt(outerMs)}/${countQuads(cbOuter)}q)`,
);

// [5] getMeshes() 毎フレームコスト
t = now();
for (let i = 0; i < 100; i++) cb.getMeshes();
console.log(`  [5] getMeshes() x100 (draw loop)  : ${fmt(now() - t)}`);

// [6] mesh 保持によるヒープ残留 (メッシュ構築後 - 構築前)。
// quads 解放パッチの効果はここに出る (GL スタブなので GPU 側は常に 0)。
console.log(
  `  [6] mesh ヒープ残留 (cb1 個分)     : ${mb(heapAfterBuild - heapBefore)}${globalThis.gc ? "" : " (--expose-gc なしのため参考値)"}`,
);
// [7] 部分更新 (ピック / ドラッグ) — 「全再構築 vs 影響チャンクだけ再メッシュ」
//
// ここが本題: ピック 1 個で inner/outer を作り直すと全 re-mesh になるため
// 131k ブロックで数秒のフリーズになる。IncrementalSplitView.toggle と同じ手順
// (StoredBlock を in-place で移す → 6 近傍込みの dirty チャンクだけ再メッシュ) を
// インラインで再現して比較する (IncrementalSplitView 自体は relative import を
// 持つため node の type-strip から直接 import できない)。
//
// patch (e) の有無は同一のピック座標・同一の初期状態で A/B する。
{
  const mid = Math.floor(S / 2);
  const CS = 16;
  const chunkSize = [CS, CS, CS];
  const size = [S, S, S];
  const pickSpec = {
    region: { start: [0, 0, 0], end: [mid - 1, S - 1, S - 1] },
    materials: null,
  };

  // 両方の計測で使う共通のピック座標 (outer 側の実在ブロックを決定的に 21 個)
  const reference = librarySplitStructure(structure, [pickSpec]);
  const candidates = structureInternals(reference.outer)
    .blocks.filter((b) => b.pos[0] > mid + 1)
    .map((b) => b.pos);
  const step = Math.max(1, Math.floor(candidates.length / 22));
  const pickPositions = [];
  for (let i = 0; i < candidates.length && pickPositions.length < 21; i += step) {
    pickPositions.push(candidates[i]);
  }
  // ドラッグ確定相当: チャンク境界をまたぐ 12^3 の直方体
  const dragPositions = [];
  for (let x = mid + 8; x < Math.min(mid + 20, S); x++) {
    for (let y = 10; y < Math.min(22, S); y++) {
      for (let z = 10; z < Math.min(22, S); z++) {
        if (reference.outer.getBlock([x, y, z])) dragPositions.push([x, y, z]);
      }
    }
  }

  function measurePartial(fastPartial) {
    if (!noPatch) applyDeepslatePatches({ fastPartialChunkUpdate: fastPartial });
    const split = librarySplitStructure(structure, [pickSpec]);
    const cbI = new ChunkBuilder(makeStubGl(), split.inner, res, CS);
    const cbO = new ChunkBuilder(makeStubGl(), split.outer, res, CS);
    const toggle = (positions) => {
      for (const pos of positions) {
        const stored = removeStoredBlock(split.outer, pos);
        if (stored) addStoredBlock(split.inner, stored);
      }
      const dirty = dirtyChunksFor(positions, chunkSize, size);
      cbI.updateStructureBuffers(dirty);
      cbO.updateStructureBuffers(dirty);
      return dirty.length;
    };

    // ベースライン: 現行フロー (両レンダラ setStructure = 全チャンク再構築)
    let t0 = now();
    cbI.setStructure(split.inner);
    cbO.setStructure(split.outer);
    const fullRemeshMs = now() - t0;

    const times = [];
    let chunks = 0;
    for (const pos of pickPositions) {
      t0 = now();
      chunks += toggle([pos]);
      times.push(now() - t0);
    }
    t0 = now();
    const dragChunks = toggle(dragPositions);
    const dragMs = now() - t0;

    // 1 回目は blocks 配列の位置キャッシュ構築 (O(N) 1 回だけ) を含むので分けて出す
    const warm = times.slice(1);
    return {
      fullRemeshMs,
      coldMs: times[0],
      pickMs: warm.reduce((a, b) => a + b, 0) / warm.length,
      picks: warm.length,
      chunksPerPick: chunks / times.length,
      dragMs,
      dragChunks,
    };
  }

  const fast = measurePartial(true);
  console.log(
    `  [7] ピック 1 個: 全再構築 ${fmt(fast.fullRemeshMs)} → 部分更新 ${fmt(fast.pickMs)}` +
      ` (${(fast.fullRemeshMs / fast.pickMs).toFixed(0)}x, 影響チャンク平均 ${fast.chunksPerPick.toFixed(1)}, ${fast.picks} 回平均)`,
  );
  console.log(`      うち 1 回目 (位置キャッシュ構築込み) : ${fmt(fast.coldMs)}`);
  console.log(
    `      ドラッグ ${String(dragPositions.length).padStart(4)} ブロック    : ${fmt(fast.dragMs)} (影響チャンク ${fast.dragChunks})`,
  );
  if (!noPatch) {
    // patch (e) 単体の効果: 素の updateStructureBuffers(chunkPositions) は
    // 全ブロック走査 + per-block フィルタなので構造体のブロック数に比例する
    const slow = measurePartial(false);
    applyDeepslatePatches({ fastPartialChunkUpdate: true });
    console.log(
      `      patch (e) OFF (素の全ブロック走査)   : ピック ${fmt(slow.pickMs)} / ドラッグ ${fmt(slow.dragMs)}` +
        ` → (e) で ${((slow.pickMs / fast.pickMs - 1) * 100).toFixed(0)}% 短縮`,
    );
  }
}

console.log("done");
