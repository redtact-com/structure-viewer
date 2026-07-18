// mcAssets の取得元パラメータ化のユニットテスト。
// 既定 = 自己ホスト /mc-assets/<version>/ で、外部 (raw.githubusercontent 等) へは
// 一切 fetch しないこと、configureMcAssets / baseUrl 引数で切替できることを固定する。
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MC_VERSION,
  configureMcAssets,
  fetchTexture,
  getBlockModels,
  getBlockStates,
  mcAssetsBase,
  textureUrl,
} from "./mcAssets";

// fetch-mc-assets が revision.json に書き出す形式のリビジョン (PRISMARINE_COMMIT 短縮 SHA)
const REV = "3b7b880";

afterEach(() => {
  vi.unstubAllGlobals();
  configureMcAssets(); // 全フィールドを既定値に戻す
});

describe("configureMcAssets / mcAssetsBase", () => {
  it("既定は自己ホスト /mc-assets/<version>", () => {
    expect(mcAssetsBase()).toBe(`/mc-assets/${MC_VERSION}`);
    expect(mcAssetsBase()).toBe("/mc-assets/1.21.5");
  });

  it("configureMcAssets({ baseUrl }) で外部 URL に切替できる (末尾スラッシュは正規化)", () => {
    configureMcAssets({ baseUrl: "https://cdn.example.com/mc-assets/" });
    expect(mcAssetsBase()).toBe(`https://cdn.example.com/mc-assets/${MC_VERSION}`);
  });

  it("空文字の baseUrl は未設定として扱う", () => {
    configureMcAssets({ baseUrl: "  " });
    expect(mcAssetsBase()).toBe(`/mc-assets/${MC_VERSION}`);
  });

  it("configureMcAssets() は設定全体を既定値に戻す", () => {
    configureMcAssets({ baseUrl: "https://cdn.example.com/mc", revision: REV });
    configureMcAssets();
    expect(mcAssetsBase()).toBe(`/mc-assets/${MC_VERSION}`);
    expect(textureUrl("block/stone")).toBe(`/mc-assets/${MC_VERSION}/textures/block/stone.png`);
  });

  it("バージョン引数で別バージョンのパスを組める", () => {
    expect(mcAssetsBase("1.22.0")).toBe("/mc-assets/1.22.0");
  });
});

describe("textureUrl", () => {
  it("自己ホストのテクスチャ URL を組み立てる (revision 未設定なら ?v= なし)", () => {
    expect(textureUrl("block/stone")).toBe(`/mc-assets/${MC_VERSION}/textures/block/stone.png`);
    expect(textureUrl("entity/signs/oak")).toBe(`/mc-assets/${MC_VERSION}/textures/entity/signs/oak.png`);
  });

  it("configureMcAssets({ revision }) で ?v= キャッシュバストが付く", () => {
    configureMcAssets({ revision: REV });
    expect(textureUrl("block/stone")).toBe(`/mc-assets/${MC_VERSION}/textures/block/stone.png?v=${REV}`);
    expect(textureUrl("entity/signs/oak")).toBe(`/mc-assets/${MC_VERSION}/textures/entity/signs/oak.png?v=${REV}`);
  });

  it("baseUrl 引数で取得元を上書きできる", () => {
    configureMcAssets({ revision: REV });
    expect(textureUrl("block/stone", "https://cdn.example.com/mc/1.21.5")).toBe(
      `https://cdn.example.com/mc/1.21.5/textures/block/stone.png?v=${REV}`,
    );
  });
});

describe("getBlockStates / getBlockModels", () => {
  const blocksJson = { states: { stone: { s: 1 } }, models: { stone: { m: 1 } } };
  const okResponse = () => ({ ok: true, json: () => Promise.resolve(blocksJson) });

  it("blocks.json を 1 回だけ fetch して states/models に分けて返す", async () => {
    configureMcAssets({ revision: REV });
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    // 並行呼び出しでも Promise キャッシュで 1 fetch に重複排除される
    const base = `/mc-assets/${MC_VERSION}-test-dedupe`;
    const [states, models] = await Promise.all([getBlockStates(base), getBlockModels(base)]);

    expect(states).toEqual(blocksJson.states);
    expect(models).toEqual(blocksJson.models);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${base}/blocks.json?v=${REV}`);
  });

  it("失敗した fetch はキャッシュされず再試行できる", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const base = `/mc-assets/${MC_VERSION}-test-retry`;
    await expect(getBlockStates(base)).rejects.toThrow("Failed to fetch blocks.json: 500");
    await expect(getBlockStates(base)).resolves.toEqual(blocksJson.states);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("既定 baseUrl は自己ホストで、外部ホストへ fetch しない", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await getBlockStates();
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe(`/mc-assets/${MC_VERSION}/blocks.json`);
    expect(url).not.toContain("githubusercontent");
  });
});

describe("fetchTexture", () => {
  it("自己ホストのテクスチャ URL に fetch し、404 は null を返す", async () => {
    configureMcAssets({ revision: REV });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTexture("block/nonexistent")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(`/mc-assets/${MC_VERSION}/textures/block/nonexistent.png?v=${REV}`);
  });

  it("baseUrl 引数で取得元を上書きできる", async () => {
    configureMcAssets({ revision: REV });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);

    await fetchTexture("block/stone", "https://cdn.example.com/mc/1.21.5");
    expect(fetchMock).toHaveBeenCalledWith(`https://cdn.example.com/mc/1.21.5/textures/block/stone.png?v=${REV}`);
  });
});
