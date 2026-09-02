# RowLog タスク

**進捗（2026-08-31）**: R0〜R6 完了。R7（実データE2E）は Apps Script の URL 待ちで止まっている。
偽サーバー（`tools/mock_api.py`）で通しの検証は済んでいる。


R0 から順にやる。1タスク完了＝`python verify.py` が ALL PASS ＋ 実挙動テストが通る。

---

## R0  verify.py を作る  ✅

- **目的**: 凍結事項を機械検査できるようにする
- **ファイル**: `verify.py`
- **完了条件**: `python verify.py` が ALL PASS
- **検査内容**:
  - [A] 構文: `verify.py` 自身と `tools/*.py` を compile
  - [B] 不変条件（grep）:
    - `frontend/index.html` に日本人の姓が含まれない（名簿をコードに埋め込んでいないこと）
    - `frontend/index.html` に `RPE_QUESTION` の固定文言がある
    - `apps_script/Code.gs` に `client_id` の重複チェックがある
    - `apps_script/Code.gs` に `Access-Control-Allow-Origin` を書いていない（text/plain 方式のため不要）
    - どのファイルにも API キーがベタ書きされていない
  - [C] ロジック: `tools/logic_test.py` の純粋関数テスト
    - `srpe(95, 6) == 570`
    - `srpe(None, None) is None`（欠席は空）
    - `parse_split("1:57.5") == 117.5`
    - `check_erg(5106, 1200, "1:57.5")` が整合と判定
    - `check_erg(5106, 1200, "2:30.0")` が不整合と判定
    - rate 54 を有効と判定（上限40で弾かない）

## R1  静的モックを見せて承認を取る  ✅

- **ファイル**: `docs/mockups/submit.html`
- **完了条件**: ユーザーが見た目にOKを出す
- **内容**: S2提出画面の実寸モック。実際にタップできるが送信はしない
- **確認**: 375px幅で横スクロールが出ないこと

## R2  Apps Script を書く  ✅

- **ファイル**: `apps_script/Code.gs`
- **完了条件**: `bootstrap` が名簿とメニューを返す。`submit` が1行書く。同じ client_id を2回送っても1行のまま
- **テスト**:
  - `bootstrap` → 名簿38件・メニュー39件が返る
  - `submit`（status=実施, minutes=95, rpe=6）→ srpe 列が 570 になる
  - `submit`（status=休養）→ minutes・rpe・srpe が空。0ではない
  - 同じ client_id で2回 → 2回目は `duplicate:true`、行は増えない

## R3  スプレッドシートを用意する  ✅

- **完了条件**: 「名簿」38行・「メニュー」39行・「回答」ヘッダが入っている
- **ファイル**: `tools/seed_sheet.py`（名簿とメニューのCSVを吐く。手で貼る）
- 名簿は `box\2026-08-31-研究用ID対応表.xlsx` から生成する。**このCSVはリポジトリに入れない**

## R4  フロントの提出機能  ✅

- **ファイル**: `frontend/index.html`
- **完了条件**: 初回設定 → 提出 → 完了 が通る。回答シートに行が増える
- **テスト**:
  - 「欠席」を選ぶと練習時間とRPEの欄が消える
  - RPEを押すと下に言葉が出る（6 → きつい）
  - 送信後に完了画面が出る

## R5  オフラインキュー  ✅

- **ファイル**: `frontend/index.html`
- **完了条件**: 機内モードで提出 → キューに残る → オンラインで自動送信 → 1行だけ増える
- **テスト**:
  - オフラインで2件出す → 復帰後に2行増える
  - 送信済みのものを再送しても行が増えない（client_id）

## R6  PWA化  ✅

- **ファイル**: `frontend/manifest.webmanifest`, `frontend/icon-{180,192,512}.png`
- **完了条件**: iPhoneのホーム画面に追加でき、アイコンが出て全画面で開く
- **確認**: manifest が 200、上部ナビが `env(safe-area-inset-top)` を考慮している

## R7  実データE2E  ⏸ URL待ち

- **完了条件**: ryu が自分の端末から実際に1件出し、スプレッドシートに正しい行が入る
- **報告**: 何を入れて何が入ったかを表で出す

## R8  配布

- **完了条件**: GitHub Pages に公開し、URLとホーム画面追加の手順を部員に配れる状態
- **ファイル**: `docs/使い方.md`（部員向け、1ページ）

---

# v1.1（収集開始後）

## R9  写真のアップロード

- **完了条件**: 写真を撮るとドライブに保存され、回答行に URL が入る
- 縮小してから送る（長辺1600px, JPEG品質80）

## R10  Gemini で読み取り

- **ファイル**: `apps_script/Extract.gs`
- **完了条件**: PM画面の写真から距離・split・rate・ドラッグが返り、画面に反映される
- **テスト**: Phase 0 の実写真（`scratchpad/norm/037.jpg` = 5106m など）で正しく返る
- **必ず守る**: 読み取り結果は編集可能。失敗しても手入力で進める。写真は必ず残す

## R11  検算と警告表示

- **完了条件**: `距離/時間` と `split` が合わないフィールドが黄色になる
- rate の上限は 60。40 で弾かない
