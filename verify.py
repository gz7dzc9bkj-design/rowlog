# -*- coding: utf-8 -*-
"""RowLog 検査。凍結事項を機械的に守らせる。

  python verify.py

[A] 構文   : tools/*.py を compile（import はしない）
[B] 不変条件: ソースを grep して CLAUDE.md の絶対ルールを検査
[C] ロジック: node tools/logic_test.js
"""
import sys, os, re, subprocess, glob

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.abspath(__file__))
results = []


def add(ok, name, detail=""):
    results.append((ok, name, detail))


def read(rel):
    p = os.path.join(ROOT, rel)
    if not os.path.isfile(p):
        return None
    with open(p, encoding="utf-8") as f:
        return f.read()


# ---------------- [A] 構文 ----------------
for p in sorted(glob.glob(os.path.join(ROOT, "tools", "*.py")) + [os.path.join(ROOT, "verify.py")]):
    rel = os.path.relpath(p, ROOT)
    try:
        with open(p, encoding="utf-8") as f:
            compile(f.read(), p, "exec")
        add(True, "[A] 構文 " + rel)
    except SyntaxError as e:
        add(False, "[A] 構文 " + rel, str(e))


# node --check で .js / .gs の構文を見る（Apps Script は本番でしか動かないので事前に潰す）
for rel in ["frontend/logic.js", "apps_script/Code.gs", "apps_script/Extract.gs", "tools/logic_test.js"]:
    p = os.path.join(ROOT, rel)
    if not os.path.isfile(p):
        continue
    # node は .gs 拡張子を解釈できないので、一時的に .js にコピーしてから見る
    target = p
    tmp = None
    if p.endswith(".gs"):
        tmp = p + ".check.js"
        with open(p, encoding="utf-8") as f:
            src = f.read()
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(src)
        target = tmp
    try:
        r = subprocess.run(["node", "--check", target], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=30)
        err = [l for l in (r.stderr or "").strip().splitlines() if "SyntaxError" in l or "^" in l]
        add(r.returncode == 0, "[A] 構文 " + rel, (err or [""])[0][:140])
    except FileNotFoundError:
        add(False, "[A] 構文 " + rel, "node が見つからない")
    finally:
        if tmp and os.path.isfile(tmp):
            os.remove(tmp)


# ---------------- [B] 不変条件 ----------------

# B1: フロントに実名を埋め込んでいないこと
# 部員の姓リストは公開リポジトリに置かない。tools/surnames.local.txt（.gitignore）から読む。
_names_path = os.path.join(ROOT, "tools", "surnames.local.txt")
SURNAMES = []
if os.path.exists(_names_path):
    with open(_names_path, encoding="utf-8") as f:
        SURNAMES = [ln.strip() for ln in f if ln.strip()]
front_files = []
for pat in ("frontend/**/*.html", "frontend/**/*.js", "frontend/**/*.json", "docs/mockups/*.html"):
    front_files += glob.glob(os.path.join(ROOT, pat), recursive=True)
hits = []
for p in front_files:
    with open(p, encoding="utf-8") as f:
        txt = f.read()
    for s in SURNAMES:
        if s in txt:
            hits.append(os.path.relpath(p, ROOT) + " に「" + s + "」")
if front_files:
    add(not hits, "[B] フロントに氏名を埋め込んでいない", " / ".join(hits[:5]))
else:
    add(True, "[B] フロントに氏名を埋め込んでいない", "(対象ファイル未作成)")

# B2: RPEの質問文が凍結されている
QUESTION = "今日の練習全体は、どのくらいきつかったですか"
logic = read("frontend/logic.js")
if logic is None:
    add(False, "[B] frontend/logic.js が存在する")
else:
    add(QUESTION in logic, "[B] RPE_QUESTION が凍結の文言")
    add("RPE_QUESTION" in logic, "[B] RPE_QUESTION が定数として定義されている")
    # rate上限は60。40で弾かない
    m = re.search(r"rate:\s*\[\s*\d+\s*,\s*(\d+)\s*\]", logic)
    add(bool(m) and int(m.group(1)) >= 60, "[B] rate の上限が60以上",
        "見つかった上限: " + (m.group(1) if m else "なし"))
    # 欠席時に0を入れない
    add("0にしない" in logic or "return null" in logic, "[B] srpe が欠席時に null を返す設計")

# B3: 画面が質問文を定数から出している（ベタ書きしていない）
#     質問文の文字列そのものは logic.js にしか無いこと。画面は定数を参照すること。
for rel in ["frontend/index.html", "frontend/app.js"]:
    txt = read(rel)
    if txt is None:
        add(True, "[B] " + rel + " が質問文をベタ書きしていない", "(未作成)")
    else:
        add(QUESTION not in txt, "[B] " + rel + " に質問文をベタ書きしていない")
app = read("frontend/app.js")
if app is None:
    add(True, "[B] 画面が RPE_QUESTION を参照している", "(未作成)")
else:
    add("RPE_QUESTION" in app, "[B] 画面が RPE_QUESTION を参照している")
mock = read("docs/mockups/submit.html")
if mock is not None:
    add("RPE_QUESTION" in mock, "[B] モックが RPE_QUESTION を定数として持っている")

# B4: Apps Script の冪等性と CORS 方式
gs = read("apps_script/Code.gs")
if gs is None:
    add(True, "[B] Apps Script の検査", "(未作成)")
else:
    add("client_id" in gs, "[B] Code.gs が client_id を扱う")
    add(re.search(r"(duplicate|重複)", gs) is not None, "[B] Code.gs に重複チェックがある")
    add("Access-Control-Allow-Origin" not in gs,
        "[B] Code.gs に CORS ヘッダを書いていない（text/plain 方式のため不要）")

# B5: APIキーがベタ書きされていない
KEY_PAT = re.compile(r"(AIza[0-9A-Za-z_\-]{30,}|sk-ant-[0-9A-Za-z_\-]{20,}|ghp_[0-9A-Za-z]{30,})")
leak = []
for pat in ("frontend/**/*", "apps_script/**/*", "tools/**/*", "docs/**/*"):
    for p in glob.glob(os.path.join(ROOT, pat), recursive=True):
        if not os.path.isfile(p):
            continue
        if os.path.splitext(p)[1].lower() not in (".html", ".js", ".gs", ".py", ".json", ".md"):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                if KEY_PAT.search(f.read()):
                    leak.append(os.path.relpath(p, ROOT))
        except Exception:
            pass
add(not leak, "[B] APIキーがベタ書きされていない", " / ".join(leak))

# B6: 依存を増やしていない（CDN・npm を使わない）
cdn = []
for rel in ("frontend/index.html", "frontend/style.css"):
    t = read(rel)
    if t:
        cdn += re.findall(r"https?://\S+", t)
add(not cdn, "[B] CDN を使っていない", " / ".join(cdn[:3]))

# B7: PWA の部品がそろっている
for rel in ("frontend/manifest.webmanifest", "frontend/icon-180.png",
            "frontend/icon-192.png", "frontend/icon-512.png"):
    add(os.path.isfile(os.path.join(ROOT, rel)), "[B] " + rel + " がある")
idx = read("frontend/index.html")
if idx:
    add('rel="manifest"' in idx, "[B] index.html が manifest を読んでいる")
    # キャッシュ避け。付け忘れるとスマホが古いコードを掴んだままになる
    cfg = read("frontend/config.js") or ""
    mv = re.search(r"VERSION:\s*'([^']+)'", cfg)
    ver = mv.group(1) if mv else None
    tags = re.findall(r'(?:src|href)="(?:logic|app|config|style)\.(?:js|css)\?v=([^"]+)"', idx)
    add(len(tags) == 4 and ver is not None and all(t == ver for t in tags),
        "[B] js/css に ?v= が付き config.js の VERSION と一致",
        "VERSION=" + str(ver) + " tags=" + ",".join(tags))
    add("env(safe-area-inset-top" in (read("frontend/style.css") or ""),
        "[B] 上部が safe-area を考慮している")

# ---------------- [C] ロジックテスト ----------------
test_js = os.path.join(ROOT, "tools", "logic_test.js")
if not os.path.isfile(test_js):
    add(False, "[C] tools/logic_test.js が存在する")
else:
    try:
        r = subprocess.run(["node", test_js], cwd=ROOT, capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=60)
        out = (r.stdout or "") + (r.stderr or "")
        add(r.returncode == 0, "[C] logic.js の単体テスト", out.strip()[:500])
    except FileNotFoundError:
        add(False, "[C] logic.js の単体テスト", "node が見つからない")
    except subprocess.TimeoutExpired:
        add(False, "[C] logic.js の単体テスト", "タイムアウト")

# ---------------- 出力 ----------------
width = max(len(n) for _, n, _ in results) + 2
n_fail = 0
for ok, name, detail in results:
    mark = "PASS" if ok else "FAIL"
    if not ok:
        n_fail += 1
    line = "  " + mark + "  " + name.ljust(width)
    if detail:
        line += "  " + detail.replace("\n", " ")[:160]
    print(line)

print("")
if n_fail:
    print("  " + str(n_fail) + " FAILED / " + str(len(results)) + " checks")
    sys.exit(1)
print("  ALL PASS (" + str(len(results)) + " checks)")
