# Telegram Rumble Battle BOT (Stripe Premium対応)

Telegramグループ向けの、ボタン参加型ランダムバトルBOTです。  
DiscordのRumble Royale風に、`/battle` で募集→参加→ランダム勝者決定を行います。

対応言語:
- 日本語
- English
- ?体中文

ユーザーのTelegram言語設定を自動判定し、メッセージを切り替えます（必要ならグループ固定も可能）。

---

## 1. 5分で導入（最短）

1. BotFatherでBOTを作成してトークンを取得
2. このプロジェクトの `.env` を作成
3. Railwayへデプロイ
4. BOTをグループに追加し、管理者権限を付与
5. グループで `/battle` 実行

---

## 2. フォルダ構成

```txt
telegram-rumble-bot/
  src/
    index.js                # BOT本体
    db.js                   # SQLite初期化
    locales/
      ja.json
      en.json
      zh.json
    services/
      i18n.js               # 言語判定/翻訳
      utils.js              # スケジュール解析など
    scripts/
      initDb.js             # DB初期化用
  data/
    schema.sql              # DB構造リファレンス
  package.json
  railway.json
  .env.example
  .gitignore
  README.md
```

---

## 3. BotFather 設定

1. Telegramで `@BotFather` を開く
2. `/newbot` でBOTを作る
3. 発行された `BOT_TOKEN` を控える
4. グループにBOTを追加
5. BOTを管理者にする（`/battle` や設定系は管理者限定）

推奨権限:
- メッセージ送信
- メッセージ編集

---

## 4. Stripe 設定（Payment Link）

このBOTは Stripe Payment Link 経由のPremium販売を想定しています。

現在の決済URL（初期値）:
- [Stripe Payment Link](https://buy.stripe.com/test_aFa7sK2BQ2PH9Gm71P14400)

ユーザー導線:
1. `/premium` で購入リンク表示
2. Stripeで決済
3. BOTへ戻って `/license XXXXX-XXXXX`
4. グループPremium有効化（1ライセンス=1グループ）

---

## 5. .env 設定

`.env.example` をコピーして `.env` を作成してください。

```bash
BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
DATABASE_PATH=./data/rumble.db
STRIPE_PAYMENT_LINK=https://buy.stripe.com/test_aFa7sK2BQ2PH9Gm71P14400
LICENSE_SECRET=CHANGE_ME_TO_LONG_RANDOM_STRING
PREMIUM_LICENSE_SEEDS=ALPHA-STARTER-2026,WEB3-RUMBLE-9999
DEFAULT_TIMEZONE=Asia/Tokyo
```

説明:
- `BOT_TOKEN`: BotFatherで取得
- `DATABASE_PATH`: SQLite DB保存先
- `STRIPE_PAYMENT_LINK`: 購入リンク
- `LICENSE_SECRET`: ライセンス生成の秘密鍵（本番では強いランダム値）
- `PREMIUM_LICENSE_SEEDS`: ライセンス元文字列。起動時にハッシュ変換されて有効コードとして登録

### ライセンスコード確認方法
このBOTは `PREMIUM_LICENSE_SEEDS` を `LICENSE_SECRET` でHMAC化し、`XXXXX-XXXXX` 形式にします。  
本番運用では、あなた専用のシードを発行して顧客へ配布してください。

---

## 6. ローカル実行

```bash
npm install
npm run init-db
npm start
```

起動後ログ:
- `Telegram Rumble Bot is running.`

---

## 7. Railway デプロイ

### A. GitHub連携でデプロイ
1. このコードをGitHubへpush
2. Railwayで `New Project` → `Deploy from GitHub`
3. 環境変数を `.env` と同じ内容で設定
4. Deploy

### B. 必須ファイル
- `package.json`（`npm start` あり）
- `railway.json`（起動コマンド指定）
- `.env` 相当の環境変数（Railway Variables）

---

## 8. コマンド一覧

### 無料版
- `/battle` 管理者限定。募集開始
- `/premium` Premium案内と購入リンク

### Premium有効化
- `/license XXXXX-XXXXX` 管理者限定。グループにライセンス適用

### 設定
- `/settings` 管理者限定。現在設定表示
- `/setduration 30|60|90` 募集秒数
- `/setlanguage auto|ja|en|zh` 言語モード

### Premium限定設定
- `/schedule 21:00` 毎日21:00に自動開催
- `/schedule weekly mon 21:00` 毎週月曜21:00
- `/schedule once 2026-05-30 21:00` 単発
- `/unschedule` 自動開催解除
- `/setgif on|off`
- `/setbutton <text>` 参加ボタン文言
- `/setwinner <template>` `{user}` を含める
- `/seteffect add <text>` `{a}` と `{b}` を含める
- `/seteffect reset` カスタム演出解除

---

## 9. バトル仕様

- 参加UI: Inline Keyboardボタン
- 重複参加防止: 同一バトル内で同一ユーザーを一意制御
- BOT参加不可
- 参加人数2人未満はキャンセル
- 演出はランダム選択（3パターン以上）
- 勝者表示: `?? Winner: USERNAME`（テンプレ変更可）

---

## 10. 多言語追加方法

1. `src/locales/xx.json` を追加
2. `src/services/i18n.js` の `supported` に言語コードを追加
3. 各キー（`battle_started`, `join_button` など）を揃える

---

## 11. セキュリティ/運用メモ

- 管理者チェック付き（重要コマンド）
- 同一ユーザー重複参加防止
- ライセンス再利用防止（`is_used`）
- 例外は `bot.catch` で吸収しBOT停止を防止

本番推奨:
- `LICENSE_SECRET` を十分長くランダム化
- ライセンス発行運用（顧客管理）を別途整備
- Stripe Webhook連携で自動ライセンス発行を将来追加

---

## 12. 将来拡張しやすいポイント

現在構成は以下を後付けしやすい設計です。

- Telegram Stars決済
- TON / USDT決済
- NFTスキン
- ランキング / XP / レベル
- ガチャ
- 広告表示

拡張位置の目安:
- 決済系: `src/index.js` の premium/license周辺を分離
- ゲームロジック: `finishBattle()` をサービス化
- 成長要素: `players` 以外に `user_stats` テーブル追加

---

## 13. トラブルシュート

- BOTが反応しない
  - `BOT_TOKEN` が正しいか
  - グループにBOTがいるか
  - プライバシーモード制約がないか
- `/battle` が失敗
  - 実行ユーザーが管理者か
- `/schedule` が失敗
  - Premium有効化済みか（`/license`）

---

必要なら次のステップとして、Stripe Webhookで「決済完了→ライセンス自動発行」まで実装できます。