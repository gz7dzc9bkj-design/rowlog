# -*- coding: utf-8 -*-
"""Code.gs と Seed.gs を1つに束ねた、貼り付け1回で済むファイルを作る。

  python tools/make_all_gs.py

出力: box\\rowlog-ALL.gs （**氏名を含むのでリポジトリに入れない**）

手作業を減らすのが目的。
  貼り付け1回 → setupAll() を実行1回 → デプロイ
先頭に setupAll を置いてあるので、Apps Script の関数選択が最初からそれになる。
"""
import sys, os, subprocess

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOX = r"C:\Users\ryu10\Claude-Workspace\box"
OUT = os.path.join(BOX, "rowlog-ALL.gs")

HEAD = '''/**
 * RowLog — これ1枚で全部入り。
 *
 * 使い方:
 *   1. このファイルの中身を全部コピーして、Apps Script の Code.gs に貼る
 *      （元から入っている function myFunction() {} は消してから貼る）
 *   2. 上の関数選択が「setupAll」になっているのを確認して「実行」
 *   3. 権限の確認が出たら 詳細 → 安全ではないページに移動 → 許可
 *   4. ログが「ぜんぶ終わりました」で終われば成功
 *   5. デプロイ → 新しいデプロイ → ウェブアプリ
 *        実行するユーザー: 自分 / アクセスできるユーザー: 全員
 *
 * このファイルは部員の氏名を含む。GitHubには置かないこと。
 * 自動生成: tools/make_all_gs.py
 */

/** ここから実行する。シート作成・初期データ投入・自己テストを続けてやる。 */
function setupAll() {
  var log = [];
  log.push('=== 1. シートを作る ===');
  log.push(setup());

  log.push('');
  log.push('=== 2. 初期データを入れる ===');
  log.push(seedAll());

  log.push('');
  log.push('=== 3. 自己テスト ===');
  try {
    log.push(selfTest());
  } catch (e) {
    log.push('!! テストが失敗した: ' + e);
    log.push('   この内容をそのまま伝えること。');
    Logger.log(log.join('\\n'));
    throw e;
  }

  log.push('');
  log.push('ぜんぶ終わりました。');
  log.push('次は デプロイ → 新しいデプロイ → ウェブアプリ');
  log.push('  実行するユーザー: 自分');
  log.push('  アクセスできるユーザー: 全員   ← ここを変えないと部員が開けません');

  var out = log.join('\\n');
  Logger.log(out);
  return out;
}

'''


def main():
    # Seed.gs を最新にしてから束ねる
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "make_seed_gs.py")],
                   check=True, cwd=ROOT)

    code = open(os.path.join(ROOT, "apps_script", "Code.gs"), encoding="utf-8").read()
    seed = open(os.path.join(BOX, "rowlog-Seed.gs"), encoding="utf-8").read()

    # seedAll の末尾にある「次にやること」案内は setupAll と重複するので落とす
    seed = seed.replace("""  log.push('');
  log.push('次にやること:');
  log.push('  1. selfTest() を実行して「テスト OK」を確認する');
  log.push('  2. 予定表シートで、オフの日の kind を『オフ』に、20分エルゴの日を『大会』に直す');
  log.push('  3. デプロイ → 新しいデプロイ → ウェブアプリ（実行:自分 / アクセス:全員）');

""", """  log.push('  ※ このあと予定表シートで、オフの日の kind を『オフ』に、');
  log.push('     20分エルゴの日を『大会』に直してください。');

""")

    body = HEAD + "\n\n" + code + "\n\n" + seed + "\n"
    os.makedirs(BOX, exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)

    lines = body.count("\n") + 1
    print("  " + OUT)
    print("  %d 行 / %.1f KB" % (lines, len(body.encode("utf-8")) / 1024))
    print("  ※ 氏名を含む。リポジトリに入れないこと。")


if __name__ == "__main__":
    main()
