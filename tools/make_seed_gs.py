# -*- coding: utf-8 -*-
"""スプレッドシートに貼るだけで初期データが入る Apps Script を作る。

  python tools/make_seed_gs.py

出力: box\\rowlog-Seed.gs （**氏名を含むのでリポジトリに入れない**）

CSVを3回インポートする手順は取り違えが起きやすい。
Code.gs と一緒にこれを貼って seedAll() を1回実行すれば、5シートと初期データが揃う。
"""
import sys, os, datetime

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import openpyxl

BOX = r"C:\Users\ryu10\Claude-Workspace\box"
ID_TABLE = os.path.join(BOX, "2026-08-31-研究用ID対応表.xlsx")
OUT = os.path.join(BOX, "rowlog-Seed.gs")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from seed_sheet import BLOCKS, roster_rows  # 同じ元データを使う（二重管理しない）


def js(s):
    return "'" + str(s).replace("\\", "\\\\").replace("'", "\\'") + "'"


def main():
    roster = roster_rows()
    if not roster:
        print("!! 名簿が取れなかった。研究用ID対応表.xlsx を確認すること")
        return

    cal = []
    d = datetime.date(2026, 9, 1)
    end = datetime.date(2026, 10, 31)
    while d <= end:
        cal.append(d.isoformat())
        d += datetime.timedelta(days=1)

    L = []
    L.append("/**")
    L.append(" * RowLog 初期データ投入用。**1回だけ実行して、あとは放置してよい。**")
    L.append(" *")
    L.append(" * 使い方: Code.gs と一緒にこのファイルを貼り、seedAll() を実行する。")
    L.append(" *         5つのシートが作られ、名簿・メニュー・予定表が埋まる。")
    L.append(" *         2回実行しても既にデータがあるシートは触らない。")
    L.append(" *")
    L.append(" * このファイルは氏名を含む。GitHubには置かないこと。")
    L.append(" * 自動生成: tools/make_seed_gs.py")
    L.append(" */")
    L.append("")
    L.append("var SEED_ROSTER = [")
    for r in roster:
        L.append("  [%s, %s, %d, %s, true]," % (js(r[0]), js(r[1]), r[2], js(r[3])))
    L.append("];")
    L.append("")
    L.append("var SEED_MENU = [")
    for b in BLOCKS:
        L.append("  [%s, %s, %s, %d]," % (js(b[0]), js(b[1]), js(b[2]), b[3]))
    L.append("];")
    L.append("")
    L.append("// 9/1〜10/31。全部『練習』で入れてある。オフの日と20分エルゴの日だけ後で直す。")
    L.append("var SEED_DATES = [")
    for i in range(0, len(cal), 7):
        L.append("  " + ", ".join(js(x) for x in cal[i:i + 7]) + ",")
    L.append("];")
    L.append("")
    L.append("""function seedAll() {
  var log = [];

  // 5つのシートを作る（Code.gs の setup を使う）
  setup();
  log.push('シートを用意した');

  var r = sheet(SHEETS.roster);
  if (r.getLastRow() < 2) {
    r.getRange(2, 1, SEED_ROSTER.length, 5).setValues(SEED_ROSTER);
    log.push('名簿 ' + SEED_ROSTER.length + '名を入れた');
  } else {
    log.push('名簿は既にあるので触らなかった');
  }

  var m = sheet(SHEETS.menu);
  if (m.getLastRow() < 2) {
    m.getRange(2, 1, SEED_MENU.length, 4).setValues(SEED_MENU);
    log.push('メニュー ' + SEED_MENU.length + '件を入れた');
  } else {
    log.push('メニューは既にあるので触らなかった');
  }

  var c = sheet(SHEETS.calendar);
  var existing = {};
  var lastRow = c.getLastRow();
  if (lastRow >= 2) {
    var vals = c.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) existing[dateStr(vals[i][0])] = true;
  }
  var rows = [];
  for (var j = 0; j < SEED_DATES.length; j++) {
    if (!existing[SEED_DATES[j]]) rows.push([SEED_DATES[j], '練習', '', '', '']);
  }
  if (rows.length) {
    c.getRange(c.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
    log.push('予定表 ' + rows.length + '日分を入れた（全部『練習』）');
  } else {
    log.push('予定表は既に埋まっている');
  }

  // 最初から入っている「シート1」は空なら消す
  var s1 = ss().getSheetByName('シート1') || ss().getSheetByName('Sheet1');
  if (s1 && s1.getLastRow() === 0 && ss().getSheets().length > 1) {
    ss().deleteSheet(s1);
    log.push('空の「シート1」を削除した');
  }

  log.push('');
  log.push('次にやること:');
  log.push('  1. selfTest() を実行して「テスト OK」を確認する');
  log.push('  2. 予定表シートで、オフの日の kind を『オフ』に、20分エルゴの日を『大会』に直す');
  log.push('  3. デプロイ → 新しいデプロイ → ウェブアプリ（実行:自分 / アクセス:全員）');

  var out = log.join('\\n');
  Logger.log(out);
  return out;
}""")
    L.append("")

    os.makedirs(BOX, exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(L))
    print("  " + OUT)
    print("  名簿 %d名 / メニュー %d件 / 予定表 %d日分" % (len(roster), len(BLOCKS), len(cal)))
    print("  ※ 氏名を含む。リポジトリに入れないこと。")


if __name__ == "__main__":
    main()
