# new-server-bot

TypeScript + discord.js で作った Discord Bot。

## セットアップ

```sh
npm install
cp .env.example .env   # Windows (PowerShell): Copy-Item .env.example .env
```

`.env` の `DISCORD_TOKEN` に Bot のトークンを設定する。
トークンは [Discord Developer Portal](https://discord.com/developers/applications) の
対象アプリ > **Bot** > **Reset Token** で取得できる。

## 起動

```sh
npm run dev     # 開発用（ファイル変更で自動再起動）
npm run build   # dist/ にビルド
npm start       # ビルド済みのものを起動
```

## Bot をサーバーに招待

Developer Portal > **OAuth2** > **URL Generator** で scope に `bot` と `applications.commands` を選び、
生成された URL を開いてサーバーに追加する。
