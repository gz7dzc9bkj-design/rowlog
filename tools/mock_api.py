# -*- coding: utf-8 -*-
"""Apps Script と同じ動きをするローカルの偽サーバー。

  python tools/mock_api.py [port]

本物のスプレッドシートが用意できる前に、フロントを通しで検証するために使う。
Code.gs と同じ action / 同じ検証ルールを実装している。**実名は使わない**（CLAUDE.md 絶対ルール1）。

データはメモリ上だけ。落とせば消える。
"""
import sys, os, json, re, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

STATUS = ["実施", "一部実施", "欠席", "休養"]
COMPLETION = ["計画どおり", "短縮", "中止", "変更"]

# テスト用のダミー名簿。実名は使わない。
ROSTER = []
for i in range(1, 15):
    ROSTER.append({"id": "B%02d" % i, "name": "テスト二年%02d" % i, "grade": 2, "cls": "ABCDEFGH"[i % 8]})
for i in range(1, 25):
    ROSTER.append({"id": "C%02d" % i, "name": "テスト一年%02d" % i, "grade": 1, "cls": "ABCDEFGH"[i % 8]})

MENU = [
    {"id": "30001", "name": "ウォーミングアップ", "category": "エルゴ", "duration": 5},
    {"id": "150002", "name": "20分（b1でMAX）", "category": "エルゴ", "duration": 20},
    {"id": "90009", "name": "25分×2（b2）", "category": "エルゴ", "duration": 57},
    {"id": "90003", "name": "30分×3（b1）", "category": "エルゴ", "duration": 90},
    {"id": "90006", "name": "500×6（高レート）", "category": "エルゴ", "duration": 30},
    {"id": "240002", "name": "たばた（20秒全力10秒レスト×8）", "category": "エルゴ", "duration": 4},
    {"id": "90014", "name": "エルゴダウンとマットダウン", "category": "クールダウン", "duration": 10},
    {"id": "120002", "name": "トレル2部", "category": "その他", "duration": 60},
    {"id": "90017", "name": "腹筋（志木高）2セット", "category": "その他", "duration": 10},
]

ANSWERS = []   # dict の並び
PLANS = []


def today_str():
    return datetime.date.today().isoformat()


def add_days(ymd, n):
    y, m, d = [int(x) for x in ymd.split("-")]
    return (datetime.date(y, m, d) + datetime.timedelta(days=n)).isoformat()


def calendar():
    """9/1〜10/31 のひな形。月曜をオフ、20分エルゴの日を大会にした例。"""
    out = {}
    d = datetime.date(2026, 9, 1)
    end = datetime.date(2026, 10, 31)
    while d <= end:
        s = d.isoformat()
        if d.weekday() == 0:
            out[s] = {"kind": "オフ", "title": "", "block_ids": [], "note": ""}
        elif s in ("2026-09-08", "2026-10-20"):
            out[s] = {"kind": "大会", "title": "20分エルゴ", "block_ids": ["30001", "150002", "90014"], "note": ""}
        else:
            out[s] = {"kind": "練習", "title": "", "block_ids": ["30001", "90009", "90014"], "note": ""}
        d += datetime.timedelta(days=1)
    # 今日も必ず入れる（検証しやすいように）
    t = today_str()
    if t not in out:
        out[t] = {"kind": "練習", "title": "", "block_ids": ["30001", "90009", "90014"], "note": ""}
    return out


def asks_load(status):
    return status in ("実施", "一部実施")


def validate(b):
    e = []
    if not b.get("research_id"):
        e.append("research_id が無い")
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(b.get("date", ""))):
        e.append("日付の形式が不正")
    if b.get("status") not in STATUS:
        e.append("参加状態が不正")
    if not b.get("client_id"):
        e.append("client_id が無い")
    if asks_load(b.get("status")):
        try:
            m = float(b.get("minutes"))
        except (TypeError, ValueError):
            m = None
        if m is None or m < 1 or m > 600:
            e.append("練習時間が不正")
        r = b.get("rpe")
        if r is None or r == "" or not (0 <= float(r) <= 10):
            e.append("RPEが未入力")
        if b.get("completion") not in COMPLETION:
            e.append("完了度が不正")
    else:
        if b.get("minutes") not in (None, ""):
            e.append("欠席・休養で練習時間が入っている")
        if b.get("rpe") not in (None, ""):
            e.append("欠席・休養でRPEが入っている")
    return e


def submit(b):
    err = validate(b)
    if err:
        return {"ok": False, "error": " / ".join(err)}
    for a in ANSWERS:
        if a["client_id"] == b["client_id"]:
            return {"ok": True, "duplicate": True}
    load = asks_load(b["status"])
    minutes = float(b["minutes"]) if load else None
    rpe = float(b["rpe"]) if load else None
    srpe = minutes * rpe if load else None
    ANSWERS.append({
        "submitted_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "research_id": b["research_id"], "date": b["date"], "status": b["status"],
        "minutes": minutes, "rpe": rpe, "srpe": srpe,
        "block_ids": b.get("block_ids") or [], "completion": b.get("completion") if load else "",
        "erg_distance": b.get("erg_distance"), "erg_split": b.get("erg_split"),
        "erg_rate": b.get("erg_rate"), "erg_drag": b.get("erg_drag"),
        "erg_machine": b.get("erg_machine"), "note": (b.get("note") or "")[:200],
        "entered_by": b.get("entered_by") or b["research_id"],
        "client_id": b["client_id"], "app_version": b.get("app_version", ""),
    })
    return {"ok": True, "srpe": srpe}


def save_plan(b):
    if not b.get("research_id"):
        return {"ok": False, "error": "research_id が無い"}
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(b.get("date", ""))):
        return {"ok": False, "error": "日付の形式が不正"}
    if not b.get("client_id"):
        return {"ok": False, "error": "client_id が無い"}
    for p in PLANS:
        if p["research_id"] == b["research_id"] and p["date"] == b["date"]:
            p["block_ids"] = b.get("block_ids") or []
            p["note"] = (b.get("note") or "")[:200]
            return {"ok": True, "updated": True}
    PLANS.append({"research_id": b["research_id"], "date": b["date"],
                  "block_ids": b.get("block_ids") or [], "note": (b.get("note") or "")[:200],
                  "client_id": b["client_id"]})
    return {"ok": True, "updated": False}


def mine(rid, lo=None, hi=None):
    if not rid:
        return {"ok": False, "error": "research_id が無い"}
    lo = lo or add_days(today_str(), -45)
    hi = hi or add_days(today_str(), 45)
    ans = {a["date"]: {"status": a["status"], "srpe": a["srpe"]}
           for a in ANSWERS if a["research_id"] == rid and lo <= a["date"] <= hi}
    pl = {p["date"]: {"block_ids": p["block_ids"], "note": p["note"]}
          for p in PLANS if p["research_id"] == rid and lo <= p["date"] <= hi}
    return {"ok": True, "research_id": rid, "from": lo, "to": hi, "answers": ans, "plans": pl}


def today_status(d):
    d = d or today_str()
    done = {a["research_id"]: a["status"] for a in ANSWERS if a["date"] == d}
    return {"ok": True, "date": d, "total": len(ROSTER),
            "submitted": sum(1 for r in ROSTER if r["id"] in done), "done": done}


class H(BaseHTTPRequestHandler):
    # ブラウザは並列に接続してくるので必ずスレッド化する。
    # 単一スレッドだと1本掴まれた時点で他が全部待たされる。
    protocol_version = 'HTTP/1.1'

    def _send(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Content-Length", "0")   # HTTP/1.1 では必須。無いと接続が閉じない
        self.end_headers()

    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        a = (q.get("action") or ["bootstrap"])[0]
        if a == "bootstrap":
            self._send({"ok": True, "app": "RowLog", "today": today_str(),
                        "roster": ROSTER, "menu": MENU, "calendar": calendar()})
        elif a == "mine":
            self._send(mine((q.get("research_id") or [""])[0],
                            (q.get("from") or [None])[0], (q.get("to") or [None])[0]))
        elif a == "today":
            self._send(today_status((q.get("date") or [None])[0]))
        elif a == "ping":
            self._send({"ok": True, "app": "RowLog(mock)", "now": datetime.datetime.now().isoformat()})
        elif a == "_dump":
            self._send({"ok": True, "answers": ANSWERS, "plans": PLANS})
        else:
            self._send({"ok": False, "error": "不明な action: " + a})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            b = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except Exception as ex:
            self._send({"ok": False, "error": "JSONが壊れている: " + str(ex)})
            return
        a = b.get("action", "")
        if a == "submit":
            self._send(submit(b))
        elif a == "plan":
            self._send(save_plan(b))
        else:
            self._send({"ok": False, "error": "不明な action: " + a})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    print("偽 Apps Script を http://localhost:%d で起動しました（Ctrl+C で終了）" % port)
    print("  ?action=bootstrap / mine / today / ping / _dump")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
