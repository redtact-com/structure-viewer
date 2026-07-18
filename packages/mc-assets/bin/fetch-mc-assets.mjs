#!/usr/bin/env node
// Minecraft アセット (blockstates/models/テクスチャ) を取得して <out>/<version>/ に配置する CLI。
// アプリの public/ 配下にアセットを落とし、@redtact/mc-assets の既定パス
// (/mc-assets/<version>/) から同一オリジン配信できるようにする。
// 生成物はアプリのリポジトリにコミットする運用を想定 (ビルド再現性と CI 非依存のため)。
//
// 取得元 (すべて immutable ref に固定):
//   - blockstates/models: PrismarineJS/minecraft-assets (コミット SHA 固定)
//       blocks_states.json + blocks_models.json → 1 ファイルにマージして blocks.json
//       ({ states, models } — getBlockStates / getBlockModels が参照する形)
//   - テクスチャ: misode/mcmeta のバージョン固定タグ <version>-assets
//       block/ + item/ 全量と、deepslate SpecialRenderer が参照し得る entity/ サブセット
//
// 使い方 (アプリのルートで実行):
//   fetch-mc-assets                          # ./public/mc-assets/<version>/ に配置 (既存はスキップ)
//   fetch-mc-assets --out static/mc-assets   # 出力先ルートの変更 (<out>/<version>/ に配置)
//   fetch-mc-assets --force                  # 全ファイル再取得 (pin 更新時)
//   fetch-mc-assets --mc-version 1.21.5 --prismarine-commit <sha>
//
// 完了時に <out>/<version>/revision.json を書き出す。同一 MC バージョンのまま
// アセット pin (--prismarine-commit) を更新したときは、この revision を
// configureMcAssets({ revision }) に渡すことで immutable キャッシュが正しくバストされる。

import { mkdir, writeFile, access, stat, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const force = args.includes("--force");

function argValue(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) {
    console.error(`${name} には値が必要`);
    process.exit(1);
  }
  return v;
}

const MC_VERSION = argValue("--mc-version", "1.21.5");

// PrismarineJS/minecraft-assets master (2026-05-02 時点) — master は動くので SHA で固定
const PRISMARINE_COMMIT = argValue(
  "--prismarine-commit",
  "3b7b8805790b87acd7e4a50dc525a453516d3e9d",
);
const PRISMARINE_BASE = `https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/${PRISMARINE_COMMIT}/data/${MC_VERSION}`;

// misode/mcmeta のバージョン固定タグ (リリース済みバージョンのタグは不変)
const MCMETA_REF = `${MC_VERSION}-assets`;
const MCMETA_RAW = `https://raw.githubusercontent.com/misode/mcmeta/${MCMETA_REF}`;
const MCMETA_TREE_API = `https://api.github.com/repos/misode/mcmeta/git/trees/${MCMETA_REF}?recursive=1`;

// 取得するテクスチャの prefix (assets/minecraft/textures/ 以下)。
// block/ と item/ は全量 (構造体は任意なので間引かない。実測 16×16 PNG で計 ~0.5MB)。
// entity/ は deepslate/render の SpecialRenderer が参照し得るサブセットのみ。
const TEXTURE_PREFIXES = [
  "block/",
  "item/",
  "entity/signs/",
  "entity/chest/",
  "entity/bed/",
  "entity/shulker/",
  "entity/banner/",
  "entity/banner_base.png",
  "entity/bell/",
  "entity/conduit/",
  "entity/decorated_pot/",
  "entity/shield_base_nopattern.png",
];

const CONCURRENCY = 24;

const outDir = resolve(argValue("--out", join("public", "mc-assets")), MC_VERSION);

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res;
}

async function exists(path) {
  try {
    await access(path);
    // 存在だけでなく「壊れていない」ことも確認する。中断時に残った 0 バイト/書きかけ
    // ファイルを skip で確定させないため (PNG は 8 バイトシグネチャ、他はサイズ > 0)。
    const st = await stat(path);
    if (st.size === 0) return false;
    if (path.endsWith(".png") && st.size < 8) return false;
    return true;
  } catch {
    return false;
  }
}

// tmp に書いて rename するアトミック書き込み (中断で書きかけファイルを残さない)。
async function writeFileAtomic(dest, data) {
  const tmp = `${dest}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, dest);
}

// --- 1. blockstates + models → blocks.json (マージ・minify) ---
async function fetchBlocksJson() {
  const dest = join(outDir, "blocks.json");
  if (!force && (await exists(dest))) {
    console.log("skip blocks.json (exists; --force で再取得)");
    return;
  }
  console.log("fetch blocks_states.json + blocks_models.json ...");
  const [states, models] = await Promise.all([
    fetchOk(`${PRISMARINE_BASE}/blocks_states.json`).then((r) => r.json()),
    fetchOk(`${PRISMARINE_BASE}/blocks_models.json`).then((r) => r.json()),
  ]);
  await mkdir(outDir, { recursive: true });
  const merged = JSON.stringify({ states, models });
  await writeFileAtomic(dest, merged);
  console.log(
    `wrote blocks.json (${Object.keys(states).length} states, ` +
      `${Object.keys(models).length} models, ${(merged.length / 1e6).toFixed(2)} MB)`,
  );
}

// --- 2. テクスチャ一覧を git tree API から列挙して個別取得 ---
async function listTexturePaths() {
  console.log(`list textures from ${MCMETA_TREE_API} ...`);
  const tree = await fetchOk(MCMETA_TREE_API).then((r) => r.json());
  if (tree.truncated) throw new Error("git tree API response truncated");
  const prefix = "assets/minecraft/textures/";
  return tree.tree
    .filter((e) => e.type === "blob" && e.path.startsWith(prefix))
    .map((e) => e.path.slice(prefix.length))
    .filter(
      (p) =>
        p.endsWith(".png") && TEXTURE_PREFIXES.some((pre) => p === pre || p.startsWith(pre)),
    );
}

async function fetchTextures() {
  const paths = await listTexturePaths();
  console.log(`${paths.length} textures to sync ...`);
  let downloaded = 0;
  let skipped = 0;
  const queue = [...paths];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const path = queue.shift();
      if (!path) return;
      const dest = join(outDir, "textures", path);
      if (!force && (await exists(dest))) {
        skipped++;
        continue;
      }
      const res = await fetchOk(`${MCMETA_RAW}/assets/minecraft/textures/${path}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // PNG シグネチャ検証 (切断・エラーページ混入をコミット前に検出)
      if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
        throw new Error(`invalid PNG: ${path} (${buf.length} bytes)`);
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFileAtomic(dest, buf);
      downloaded++;
      if (downloaded % 200 === 0) console.log(`  ... ${downloaded} downloaded`);
    }
  });
  await Promise.all(workers);
  console.log(`textures: ${downloaded} downloaded, ${skipped} skipped (already exist)`);
  return paths;
}

// --- 3. サイズレポート ---
async function report(paths) {
  let total = 0;
  for (const p of paths) {
    try {
      total += (await stat(join(outDir, "textures", p))).size;
    } catch {
      /* 取得失敗分は無視 */
    }
  }
  const blocks = await stat(join(outDir, "blocks.json"));
  console.log(
    `total: blocks.json ${(blocks.size / 1e6).toFixed(2)} MB + ` +
      `textures ${(total / 1e6).toFixed(2)} MB (${paths.length} files) → ${outDir}`,
  );
}

// --- 4. リビジョンの書き出し ---
// 同一 MC バージョンのまま PRISMARINE_COMMIT だけ更新した場合でも URL を変えられるよう、
// configureMcAssets({ revision }) に渡すリビジョンを revision.json へ書き出す。
async function writeRevision() {
  const rev = PRISMARINE_COMMIT.slice(0, 7);
  await writeFileAtomic(join(outDir, "revision.json"), `${JSON.stringify({ revision: rev })}\n`);
  console.log(
    `wrote revision.json (revision=${rev}) — configureMcAssets({ revision: "${rev}" }) に渡す`,
  );
}

await fetchBlocksJson();
const paths = await fetchTextures();
await report(paths);
await writeRevision();
