import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // ワークスペース依存をビルド成果物 (dist) ではなくソースに解決する。
      // package.json の main/module は dist を指すため、素の解決では
      // `pnpm run test` が `pnpm run build` の後でしか通らない。CI は
      // typecheck → test → build の順に走るので、ビルド前でもテストできる
      // ようにここで src に向ける。
      "@redtact/deepslate-extras": fileURLToPath(
        new URL("../deepslate-extras/src/index.ts", import.meta.url),
      ),
    },
  },
});
