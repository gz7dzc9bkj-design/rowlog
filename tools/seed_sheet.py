# -*- coding: utf-8 -*-
"""スプレッドシートに貼り付ける元データ（CSV）を作る。

  python tools/seed_sheet.py

出力先は box\\（リポジトリの外）。**名簿には氏名が入るのでリポジトリに置かない。**

  box\\rowlog-seed-名簿.csv     … 研究用ID対応表.xlsx から。在籍38名のみ
  box\\rowlog-seed-メニュー.csv  … 部活マネージャーの39ブロック
  box\\rowlog-seed-予定表.csv    … 9〜10月のひな形。オフの日だけ主務が直す
"""
import sys, os, csv, datetime

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import openpyxl

BOX = r"C:\Users\ryu10\Claude-Workspace\box"
ID_TABLE = os.path.join(BOX, "2026-08-31-研究用ID対応表.xlsx")

# 部活マネージャー (clubmanag-4ysnkpfp.manus.space) の blocks.list を 2026-08-31 に取得したもの
BLOCKS = [
    (150006, "10000m（b1でMAX）", "エルゴ", 50), (240001, "10分（調整時のb1）", "エルゴ", 10),
    (90001, "12000m （b1）", "エルゴ", 50), (210001, "13分×2 レスト5分（b2max）", "エルゴ", 30),
    (90002, "15000m（b1）", "エルゴ", 70), (90008, "2000m×3（レート26、レスト8分）", "エルゴ", 30),
    (150003, "20分（b 2でMAX）", "エルゴ", 20), (150002, "20分（b1でMAX）", "エルゴ", 20),
    (90005, "250m×12（高レート）", "エルゴ", 30), (90009, "25分×2（b2）", "エルゴ", 57),
    (150004, "30分（b1でMAX）", "エルゴ", 30), (150005, "30分（b2でMAX）", "エルゴ", 30),
    (90003, "30分×3（b1）", "エルゴ", 90), (150001, "45秒MAX×4 レスト1分30", "エルゴ", 4),
    (90004, "45秒MAX×4＋30分×3（b1）", "エルゴ", 90), (150007, "500×4", "エルゴ", 20),
    (90006, "500×6（高レート）", "エルゴ", 30), (90007, "500m×8 （高レート）", "エルゴ", 40),
    (60001, "70分（b1）", "エルゴ", 70), (30001, "ウォーミングアップ", "エルゴ", 5),
    (270001, "ダウンb6（15本×2", "エルゴ", 2), (240002, "たばた（20秒全力10秒レスト×8）", "エルゴ", 4),
    (90014, "エルゴダウンとマットダウン", "クールダウン", 10),
    (90022, "3000m×2（レート24〜26、レスト9分30秒）", "その他", 30),
    (90021, "30分b1＋500×6", "その他", 45), (120001, "トレル1部", "その他", 60),
    (120002, "トレル2部", "その他", 60), (90015, "ヒート", "その他", 10),
    (180002, "プランク（1分、2セット", "その他", 1), (180001, "プランク（1分、3セット", "その他", 1),
    (90019, "プランク片足ずつ1セット", "その他", 2), (90013, "校舎走10キロ（キロ５分半）", "その他", 50),
    (150008, "校舎走5キロ（キロ5分）", "その他", 25), (90012, "校舎走7キロ（キロ5分）", "その他", 35),
    (90011, "理工階段8往復", "その他", 30), (90020, "腕立て20回×2", "その他", 5),
    (90017, "腹筋（志木高）2セット", "その他", 10), (90016, "腹筋大下さんの", "その他", 10),
    (90018, "駅伝腹筋", "その他", 10),
]


def write_csv(name, header, rows):
    path = os.path.join(BOX, name)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    print("  " + name + "  " + str(len(rows)) + " 行")
    return path


def roster_rows():
    if not os.path.isfile(ID_TABLE):
        print("!! " + ID_TABLE + " が無い。先に研究用ID対応表を作ること")
        return []
    wb = openpyxl.load_workbook(ID_TABLE, data_only=True)
    ws = wb["対応表"]
    rows = []
    for r in ws.iter_rows(min_row=5, values_only=True):
        rid, yaku, name, kana, grade, cls, status = r[0], r[1], r[2], r[3], r[4], r[5], r[6]
        if not rid:
            continue
        if status != "在籍":       # 3年6名は引退。前向き収集の対象外
            continue
        rows.append([rid, name, grade, cls, "TRUE"])
    rows.sort(key=lambda x: x[0])
    return rows


def calendar_rows():
    """9/1〜10/31 のひな形。全部『練習』で出すので、オフの日だけ主務が直す。"""
    rows = []
    d = datetime.date(2026, 9, 1)
    end = datetime.date(2026, 10, 31)
    while d <= end:
        rows.append([d.isoformat(), "練習", "", "", ""])
        d += datetime.timedelta(days=1)
    return rows


def main():
    os.makedirs(BOX, exist_ok=True)
    print("スプレッドシートに貼る元データを作ります")
    r = roster_rows()
    write_csv("rowlog-seed-名簿.csv", ["research_id", "name", "grade", "class", "active"], r)
    write_csv("rowlog-seed-メニュー.csv", ["block_id", "name", "category", "duration"],
              [[b[0], b[1], b[2], b[3]] for b in BLOCKS])
    write_csv("rowlog-seed-予定表.csv", ["date", "kind", "title", "block_ids", "note"], calendar_rows())
    print("")
    print("出力先: " + BOX)
    print("名簿には氏名が入っています。リポジトリに入れないこと。")


if __name__ == "__main__":
    main()
