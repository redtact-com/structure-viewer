# Publishing（npm 公開手順）

このモノレポのリリースが npm に届くまでの流れと、npmjs.com 側で必要な
手動セットアップをまとめる。

## リリースフロー（自動）

`main` への push ごとに `.github/workflows/publish.yml` の `changesets/action`
が動く。挙動は **changeset の有無で分岐する** 点に注意:

- **changeset（`.changeset/*.md`）がある push** → publish はせず、
  **"Version Packages"** PR（version bump + CHANGELOG）を作成/更新する。
- **changeset がない push** → 即座に `pnpm changeset publish` を実行し、
  「package.json のバージョンが npm 上に存在しない」全パッケージを publish する。
  Version Packages PR のマージはこちらのケースで、publish → git タグ push →
  GitHub Release 作成まで行う。逆に言うと、docs 修正など通常の push でも
  現行バージョンが npm 未公開なら publish が試行される。

release job 全体は repository variable **`NPM_PUBLISH_ENABLED`** でゲートしており、
`true` でない間は job が skip される（publish も Version PR 作成も起きない）。
npm 側の認証準備（下記）が整うまでは無効のままにしておく — 未設定でも workflow
が失敗することはなく、単に何も起きない。

publish の認証は 2 段階で移行する:

1. **初回 publish**: `NPM_TOKEN`（granular access token）。trusted publisher は
   npm 上に存在するパッケージにしか登録できないため、初回だけトークンが必要。
2. **公開後**: 各パッケージに trusted publisher（OIDC）を登録し、
   `NPM_TOKEN` シークレットを削除する。以後は CI に長期シークレットを置かずに
   publish でき、npm が **provenance 証明** を自動付与する。

> **期限注意**: granular token による CI publish（2FA バイパス）は npm 側で
> **2027 年 1 月頃に廃止予定**とアナウンスされている。トークン方式は初回 publish
> の一時利用にとどめ、公開後すみやかに trusted publisher（OIDC）へ移行して
> トークンを削除すること。

## このリポジトリのパッケージ

| npm パッケージ | ディレクトリ |
| --- | --- |
| `@redtact/deepslate-extras` | `packages/deepslate-extras` |
| `@redtact/mc-assets` | `packages/mc-assets` |

## 初回 publish: トークン方式（`NPM_TOKEN`）

0. publish ゲートを有効化する（npm 側の準備が整うまで release job は skip される）:

   ```bash
   gh variable set NPM_PUBLISH_ENABLED --repo redtact-com/structure-viewer --body true
   ```

1. npmjs.com に npm **redtact** アカウントでログイン →
   アバター → **Access Tokens** → **Generate New Token** →
   **Granular Access Token**:
   - Expiration: 有限の期限を設定（初回 publish 後に削除する前提）。
   - Packages and scopes: **Read and write**、`@redtact` スコープ。
2. リポジトリシークレットに登録:

   ```bash
   gh secret set NPM_TOKEN --repo redtact-com/structure-viewer
   ```

3. changeset を含む PR → "Version Packages" PR マージで初回 publish が走る。

## 公開後: trusted publisher 登録（npmjs.com で手動）

上の表の **全パッケージ** について繰り返す:

1. <https://www.npmjs.com/> にパッケージオーナー（`redtact`）でログイン。
2. パッケージページ → **Settings** タブ
   （例: `https://www.npmjs.com/package/@redtact/deepslate-extras/access`）。
3. **Trusted Publisher** セクションで **GitHub Actions** を選び、次の値を
   正確に入力:

   | 項目 | 値 |
   | --- | --- |
   | Organization or user | `redtact-com` |
   | Repository | `structure-viewer` |
   | Workflow filename | `publish.yml` |
   | Environment name | （空欄のまま） |

4. 保存。全パッケージの登録が済んだらシークレットを削除して OIDC に切り替える:

   ```bash
   gh secret delete NPM_TOKEN --repo redtact-com/structure-viewer
   ```

   `NPM_TOKEN` シークレットが残っていると **OIDC より優先** される
   （changesets/action が `~/.npmrc` に書き込むため）。

補足:

- Workflow filename はファイル名のみ（`publish.yml`。フルパスではない）。
  workflow ファイルを改名したら登録も更新が必要。
- trusted publishing は GitHub ホストランナー限定（本リポジトリは
  `ubuntu-latest` なので問題なし）。
- OIDC publish の動作確認後の任意強化: 各パッケージの Settings →
  *Publishing access* で **トークンを禁止する** オプションを選ぶ。trusted
  publishing はトークンではないので CI は動き続け、漏洩トークンは無効化される。

## ローカルからの手動 publish（最終手段）

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm changeset publish   # 必要に応じて npm login / OTP を要求される
git push --follow-tags
```

## トラブルシューティング

| 症状 | 原因の見当 |
| --- | --- |
| CI で `ENEEDAUTH` | trusted publisher 未登録（または初回で `NPM_TOKEN` シークレット未設定）。 |
| OIDC トークン交換が失敗 / 404 | trusted publisher 登録の項目不一致（リポジトリ名・workflow ファイル名・environment）。 |
| `E422` / provenance エラー | package.json の `repository.url` がこの GitHub リポジトリと不一致。 |
| publish 成功だが provenance バッジなし | `publish.yml` の `NPM_CONFIG_PROVENANCE` env と `id-token: write` 権限を確認。 |
