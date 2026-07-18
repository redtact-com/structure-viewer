import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 正確性テストの多くは「差分適用の結果」と「full 再構築の結果」を比較するため、
    // 1 テストの中で ChunkBuilder のフルビルドを何度も回す。vitest 既定の 5s は
    // CI ランナーだと足りないことがあるので余裕を持たせる (遅い = 失敗、ではない)。
    testTimeout: 30_000,
  },
});
