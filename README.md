# RowLog

慶應義塾高校端艇部の練習記録PWA。卒業研究のデータ収集を兼ねる。

- 対象: 2年14名 + 1年24名 = **38名**（3年6名は引退のため対象外）
- 期間: 2026年9月上旬 〜 10月下旬（6〜8週間）
- アウトカム: 20分エルゴ（9月上旬・10月下旬の2回）

仕様の正本は [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) と [docs/DESIGN.md](docs/DESIGN.md)。
作業規約は [CLAUDE.md](CLAUDE.md)。部員向けの説明は [docs/使い方.md](docs/使い方.md)。

---

## 構成

```
スマホ  →  frontend/（GitHub Pages・公開。氏名を含まない）
              ↓ fetch
          Apps Script ウェブアプリ（apps_script/Code.gs）
              ↓
          Googleスプレッドシート（名簿 / メニュー / 予定表 / 回答 / 予定）
```

常駐サーバーを持たない。PCが落ちていても動く。フレームワーク・CDN・npm を使わない。

---

## 立ち上げ（3ステップ）

### 1. スプレッドシートを作る

1. Googleスプレッドシートを新規作成（名前は「RowLog」）
2. `python tools/seed_sheet.py` を実行 → `box\rowlog-seed-*.csv` が3つできる
3. `名簿` `メニュー` `予定表` の3シートを作って、それぞれCSVをインポート
4. **予定表のオフの日を「オフ」に、テストの日を「大会」に直す**（行が無い日は練習扱い）

### 2. Apps Script を入れる

1. スプレッドシートの **拡張機能 → Apps Script**
2. `apps_script/Code.gs` の中身を貼って保存
3. **`setup`** を実行 → 続けて **`selfTest`** を実行。ログが「テスト OK」で終わること
4. **デプロイ → 新しいデプロイ → ウェブアプリ**
   - 実行するユーザー: **自分**
   - アクセスできるユーザー: **全員**
5. 出てきたURLを `frontend/config.js` の `API_URL` に貼る

### 3. 配信する

1. `frontend/` を GitHub Pages で公開する
2. URLを部員に配る。[docs/使い方.md](docs/使い方.md) を一緒に渡す

---

## 開発

```bash
python verify.py                  # 検査。ALL PASS を維持する
node tools/logic_test.js          # 純粋関数の単体テスト
python tools/seed_sheet.py        # スプレッドシート用のCSVを作る
```

### ローカルで動かす

本物のスプレッドシートを用意しなくても、偽サーバーで通しの検証ができる。

```bash
python tools/mock_api.py 8766                                    # 偽 Apps Script
python -m http.server 8765 --directory .                         # 静的配信
```

ブラウザで
`http://localhost:8765/frontend/index.html?api=http://127.0.0.1:8766`

`?api=` を付けると `config.js` の設定を上書きできる。偽サーバーは実名を使わない。

**偽サーバーは 127.0.0.1 でしか待ち受けない。** `localhost` だとIPv6で解決されて繋がらないことがある。

---

## 手を入れるときの注意

`CLAUDE.md` に全部書いてあるが、特に踏みやすいもの:

- **氏名をリポジトリに入れない。** GitHub Pages は公開。名簿は Apps Script 経由で取る
- **欠席・休養で練習時間とRPEに0を入れない。** 空で送る
- **配信するとき `index.html` の `?v=` を上げる。** 上げないとスマホが古いコードを掴んだままになる
- **rate の上限は 60。** 40 で弾かない（実測54）

---

## 状態（2026-08-31）

| | |
|---|---|
| R0 verify.py | 完了。ALL PASS 28件 |
| R1 モック | 完了 |
| R2 Apps Script | 完了（`selfTest` 同梱。実スプレッドシートでの実行は未） |
| R3 元データCSV | 完了 |
| R4-R5 フロント・オフライン | 完了。偽サーバーで通し検証済み |
| R6 PWA | 完了（manifest・アイコン3種） |
| R7 実データE2E | **未。本物のURL待ち** |
| R8 配信 | 未 |
| R9-R11 写真読み取り（v1.1） | 未 |
