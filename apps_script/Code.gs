/**
 * RowLog — Google Apps Script ウェブアプリ
 *
 * スプレッドシートに紐づけて使う（拡張機能 → Apps Script）。
 * デプロイ: 新しいデプロイ → 種類「ウェブアプリ」
 *   実行するユーザー : 自分
 *   アクセスできるユーザー : 全員
 *
 * CORS について:
 *   Apps Script のウェブアプリはレスポンスヘッダを自前で付けられない。
 *   そのためフロントは POST を Content-Type: text/plain で送り、
 *   プリフライト（OPTIONS）自体を起こさない。JSON は本文に文字列で入れる。
 *   ここで Access-Control 系のヘッダを書こうとしないこと。効かない。
 */

var APP = 'RowLog';
var TZ = 'Asia/Tokyo';

var SHEETS = {
  roster:   { name: '名簿',   head: ['research_id', 'name', 'grade', 'class', 'active'] },
  menu:     { name: 'メニュー', head: ['block_id', 'name', 'category', 'duration'] },
  calendar: { name: '予定表',  head: ['date', 'kind', 'title', 'block_ids', 'note'] },
  answers:  { name: '回答',    head: ['submitted_at', 'research_id', 'date', 'status', 'minutes', 'rpe', 'srpe',
                                     'block_ids', 'completion', 'erg_distance', 'erg_split', 'erg_rate',
                                     'erg_drag', 'erg_machine', 'photo_urls', 'note', 'entered_by',
                                     'client_id', 'app_version'] },
  plans:    { name: '予定',    head: ['submitted_at', 'research_id', 'date', 'block_ids', 'note', 'client_id'] },
  /* 怪しい書き込みを記録するだけのシート。弾かない。
     このウェブアプリは誰でも POST できる（text/plain は CORS の単純リクエストなので
     プリフライトが起きず、Apps Script はリクエストヘッダを読めないので送信元を確かめられない）。
     防ぐ代わりに、アプリ経由らしくない書き込みをここに残して主務が気づけるようにする。 */
  audit:    { name: '監査ログ', head: ['at', 'what', 'research_id', 'date', 'flags', 'client_id', 'app_version'] }
};

/* 数値と解釈されると壊れる列。スプレッドシートは "30001,90009" を
   桁区切りの数値 3000190009 として取り込んでしまう（実際に踏んだ）。
   ここに書いた列は書式を「書式なしテキスト」に固定する。 */
var TEXT_COLS = {
  '名簿':    ['research_id', 'name', 'class'],
  'メニュー': ['block_id', 'name', 'category'],
  '予定表':  ['date', 'kind', 'title', 'block_ids', 'note'],
  '回答':    ['research_id', 'date', 'status', 'block_ids', 'completion',
             'erg_split', 'erg_machine', 'photo_urls', 'note', 'entered_by',
             'client_id', 'app_version'],
  '予定':    ['research_id', 'date', 'block_ids', 'note', 'client_id'],
  '監査ログ': ['at', 'what', 'research_id', 'date', 'flags', 'client_id', 'app_version']
};

var STATUS = ['実施', '一部実施', '欠席', '休養'];
var COMPLETION = ['計画どおり', '短縮', '中止', '変更'];
var KINDS = ['練習', 'オフ', '大会'];

/* ============================ 入口 ============================ */

function doGet(e) {
  try {
    var a = (e && e.parameter && e.parameter.action) || 'bootstrap';
    if (a === 'bootstrap') return json(bootstrap());
    if (a === 'mine')      return json(mine(e.parameter.research_id, e.parameter.from, e.parameter.to));
    if (a === 'today')     return json(todayStatus(e.parameter.date));
    if (a === 'ping')      return json({ ok: true, app: APP, now: nowIso() });
    return json({ ok: false, error: '不明な action: ' + a });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
    var a = body.action || (e && e.parameter && e.parameter.action) || '';
    if (a === 'submit') return json(submit(body));
    if (a === 'plan')   return json(savePlan(body));
    return json({ ok: false, error: '不明な action: ' + a });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================ 読み ============================ */

function bootstrap() {
  var cal = readCalendar();   // 先に呼ぶ。中で診断用の数を立てている
  var out = {
    ok: true,
    app: APP,
    today: todayStr(),
    roster: readRoster(),
    menu: readMenu(),
    calendar: cal
  };
  /* 予定表がおかしいときだけ載せる。ふだんは付かないので通信量も増えない。
     これが付いていたら、全日が「ふつうの練習」に戻っている可能性がある。 */
  if (calendarMissing || calendarSkipped > 0) {
    out.calendarWarn = {
      missing: calendarMissing,
      skipped: calendarSkipped,
      message: calendarMissing
        ? '「予定表」シートが見つかりません。名前を変えていませんか。全日ふつうの練習として扱っています'
        : ('予定表の ' + calendarSkipped + ' 行で日付を読めませんでした。'
           + 'YYYY-MM-DD の形（書式なしテキスト）になっているか確かめてください')
    };
  }
  return out;
}

function readRoster() {
  var rows = readAll(SHEETS.roster);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r.research_id) continue;
    if (String(r.active).toUpperCase() === 'FALSE') continue;
    out.push({
      id: String(r.research_id).trim(),
      name: String(r.name || '').trim(),
      grade: Number(r.grade) || null,
      cls: String(r['class'] || '').trim()
    });
  }
  return out;
}

function readMenu() {
  var rows = readAll(SHEETS.menu);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r.block_id) continue;
    out.push({
      id: String(r.block_id).trim(),
      name: String(r.name || '').trim(),
      category: String(r.category || '').trim(),
      duration: Number(r.duration) || null
    });
  }
  return out;
}

/** 予定表。行が無い日は「練習」として扱うので、ここには書かれた日だけ返す。 */
/* 主務がシート名を変えたり、日付セルの書式を崩したりすると、
   このアプリは黙って「全日ふつうの練習」に戻る。誰にもエラーが出ない。
   何が起きたかを数えておき、bootstrap の返り値に載せて気づけるようにする。 */
var calendarSkipped = 0;
var calendarMissing = false;

function readCalendar() {
  calendarMissing = !ss().getSheetByName(SHEETS.calendar.name);
  calendarSkipped = 0;
  var rows = readAll(SHEETS.calendar);
  var out = {};
  for (var i = 0; i < rows.length; i++) {
    var d = dateStr(rows[i].date);
    if (!d) { calendarSkipped++; continue; }
    var kind = String(rows[i].kind || '').trim();
    out[d] = {
      kind: KINDS.indexOf(kind) >= 0 ? kind : '練習',
      title: String(rows[i].title || '').trim(),
      block_ids: splitIds(rows[i].block_ids),
      note: String(rows[i].note || '').trim()
    };
  }
  return out;
}

/** カレンダーの●表示用。実績と予定を日付で引けるように返す。 */
function mine(researchId, from, to) {
  if (!researchId) return { ok: false, error: 'research_id が無い' };
  var id = String(researchId).trim();
  var lo = from || addDays(todayStr(), -45);
  var hi = to || addDays(todayStr(), 45);

  var answers = {};
  var rows = readAll(SHEETS.answers);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].research_id).trim() !== id) continue;
    var d = dateStr(rows[i].date);
    if (!d || d < lo || d > hi) continue;
    answers[d] = { status: String(rows[i].status || ''), srpe: rows[i].srpe === '' ? null : Number(rows[i].srpe) };
  }

  var plans = {};
  var prows = readAll(SHEETS.plans);
  for (var j = 0; j < prows.length; j++) {
    if (String(prows[j].research_id).trim() !== id) continue;
    var pd = dateStr(prows[j].date);
    if (!pd || pd < lo || pd > hi) continue;
    plans[pd] = { block_ids: splitIds(prows[j].block_ids), note: String(prows[j].note || '') };
  }

  return { ok: true, research_id: id, from: lo, to: hi, answers: answers, plans: plans };
}

/** 「みんな」タブ用。誰が出したかだけ。氏名は返さない（名簿と突き合わせるのはフロント側）。 */
function todayStatus(date) {
  var d = dateStr(date) || todayStr();
  var done = {};
  var rows = readAll(SHEETS.answers);
  for (var i = 0; i < rows.length; i++) {
    if (dateStr(rows[i].date) !== d) continue;
    done[String(rows[i].research_id).trim()] = String(rows[i].status || '');
  }
  var roster = readRoster();
  var submitted = 0;
  for (var j = 0; j < roster.length; j++) if (done[roster[j].id]) submitted++;
  return { ok: true, date: d, total: roster.length, submitted: submitted, done: done };
}

/* ============================ 書き ============================ */

/**
 * 実績を1行追記する。
 * - 同じ client_id が既にあれば何もしない（電波の悪い場所での再送対策）
 * - 欠席・休養では minutes / rpe / srpe を空にする。0を入れない
 */
function submit(body) {
  var v = validateAnswer(body);
  /* kind を付ける。フロントはこれを見て「捨てる」か「粘る」かを決める。
     以前は理由が分からず、一時的なサーバー側の失敗でも記録を捨てていた。 */
  if (v.length) return { ok: false, kind: 'validation', error: v.join(' / ') };

  /* 練習直後は38人がほぼ同時に送る。取れなかったら「混雑」として返し、
     フロントに再送させる。捨てさせない（kind を付けないのが肝心）。 */
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return { ok: false, kind: 'busy', error: '混み合っています。あとで自動的に送り直します' };
  }
  try {
    var sh = sheet(SHEETS.answers);
    if (hasClientId(sh, SHEETS.answers.head, body.client_id)) {
      return { ok: true, duplicate: true, message: '同じ client_id が既にあるため重複として無視した' };
    }

    var load = asksLoad(body.status);
    var minutes = load ? Number(body.minutes) : '';
    var rpe = load ? Number(body.rpe) : '';
    var srpe = load ? minutes * rpe : '';

    sh.appendRow([
      nowIso(),
      String(body.research_id).trim(),
      dateStr(body.date),
      body.status,
      minutes,
      rpe,
      srpe,
      splitIds(body.block_ids).join(', '),   // 空白必須。','だけだと数値に変換されて壊れる
      load ? (body.completion || '') : '',
      numOrBlank(body.erg_distance),
      body.erg_split ? String(body.erg_split).trim() : '',
      numOrBlank(body.erg_rate),
      numOrBlank(body.erg_drag),
      body.erg_machine ? String(body.erg_machine).trim() : '',
      (body.photo_urls || []).join(','),
      cutText(body.note, 200),
      String(body.entered_by || body.research_id).trim(),
      String(body.client_id).trim(),
      String(body.app_version || '')
    ]);
    var res = { ok: true, srpe: srpe === '' ? null : srpe };
    lock.releaseLock();
    lock = null;
    logAudit_('submit', body, auditFlags_(body, 'submit'));   // ロックの外で書く
    return res;
  } finally {
    if (lock) lock.releaseLock();
  }
}

/**
 * 予定を保存する。同じ (research_id, date) は上書きする。
 * 予定は変わるものなので履歴を持たない。実績の「回答」は追記のみで上書きしない。
 */
function savePlan(body) {
  if (!body.research_id) return { ok: false, kind: 'validation', error: 'research_id が無い' };
  var d = dateStr(body.date);
  if (!d) return { ok: false, kind: 'validation', error: '日付の形式が不正' };
  if (!body.client_id) return { ok: false, kind: 'validation', error: 'client_id が無い' };

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return { ok: false, kind: 'busy', error: '混み合っています。あとで自動的に送り直します' };
  }
  try {
    var sh = sheet(SHEETS.plans);
    var head = SHEETS.plans.head;
    var last = sh.getLastRow();
    var id = String(body.research_id).trim();
    var ids = splitIds(body.block_ids).join(', ');   // 空白必須。','だけだと数値に変換されて壊れる
    var note = cutText(body.note, 200);

    if (last >= 2) {
      var vals = sh.getRange(2, 1, last - 1, head.length).getValues();
      for (var i = 0; i < vals.length; i++) {
        if (String(vals[i][1]).trim() === id && dateStr(vals[i][2]) === d) {
          sh.getRange(i + 2, 1, 1, head.length)
            .setValues([[nowIso(), id, d, ids, note, String(body.client_id).trim()]]);
          return { ok: true, updated: true };
        }
      }
    }
    sh.appendRow([nowIso(), id, d, ids, note, String(body.client_id).trim()]);
    return { ok: true, updated: false };
  } finally {
    lock.releaseLock();
  }
}

/* ============================ 検証 ============================ */

function asksLoad(status) {
  return status === '実施' || status === '一部実施';
}

function validateAnswer(b) {
  var e = [];
  if (!b || !b.research_id) e.push('research_id が無い');
  if (!dateStr(b && b.date)) e.push('日付の形式が不正');
  if (STATUS.indexOf(b && b.status) < 0) e.push('参加状態が不正');
  if (!b || !b.client_id) e.push('client_id が無い');
  /* 実績は今日以前。未来日は「予定」シートの担当。UI 側の分岐が壊れると
     未来日の「実施」が回答シートに確定保存され、消す手段がアプリに無い。 */
  var bd = dateStr(b && b.date);
  if (bd && bd > todayStr()) e.push('未来の日付は実績にできない');

  if (b && asksLoad(b.status)) {
    var m = Number(b.minutes), r = Number(b.rpe);
    if (!isFinite(m) || m < 1 || m > 600) e.push('練習時間が不正');
    if (b.rpe === null || b.rpe === undefined || b.rpe === '' || !isFinite(r) || r < 0 || r > 10) e.push('RPEが未入力');
    if (COMPLETION.indexOf(b.completion) < 0) e.push('完了度が不正');
  } else if (b) {
    // 欠席・休養では空で送ってもらう。0が来たら弾く
    if (b.minutes !== null && b.minutes !== undefined && b.minutes !== '') e.push('欠席・休養で練習時間が入っている');
    if (b.rpe !== null && b.rpe !== undefined && b.rpe !== '') e.push('欠席・休養でRPEが入っている');
  }
  return e;
}

/* ============================ 監査 ============================ */

/**
 * アプリ経由らしくない書き込みを見分ける。シートは一切読まないので速い。
 * 弾かない。記録するだけ。誤検知で本物の提出を落とすほうが害が大きい。
 */
function auditFlags_(b, what) {
  var f = [];
  b = b || {};

  var ver = String(b.app_version || '').trim();
  if (!ver) f.push('app_versionが空');
  else if (!/^\d+\.\d+\.\d+$/.test(ver)) f.push('app_versionの形が違う(' + ver + ')');

  /* アプリは 'x-' + 時刻の36進 + '-' + 乱数 という形で作る（app.js の uuid()）。
     手で作った client_id はここで形が合わない。 */
  var cid = String(b.client_id || '').trim();
  if (!/^x-[0-9a-z]+-[0-9a-z]+$/.test(cid)) f.push('client_idの形が違う');

  var rid = String(b.research_id || '').trim();
  if (!/^[A-C]\d{2}$/.test(rid)) f.push('研究IDの形が違う(' + rid + ')');

  if (what === 'submit') {
    var eb = String(b.entered_by || '').trim();
    if (eb && eb !== rid) f.push('入力者が本人と違う(' + eb + ')');
    if (STATUS.indexOf(b.status) < 0) f.push('参加状態が想定外');
  }

  /* だいぶ前の日付を今ごろ入れてくるのは、出し忘れの後追いか、偽装か。
     出し忘れの後追いは実際にあるので弾かない。目印だけ残す。 */
  var d = dateStr(b.date);
  if (d) {
    var age = daysBetween_(d, todayStr());
    if (age > 10) f.push(age + '日前の記録');
  }
  return f;
}

function daysBetween_(a, b) {
  var pa = a.split('-'), pb = b.split('-');
  var da = new Date(Number(pa[0]), Number(pa[1]) - 1, Number(pa[2]));
  var db = new Date(Number(pb[0]), Number(pb[1]) - 1, Number(pb[2]));
  return Math.round((db - da) / 86400000);
}

/** 目印が付いたときだけ1行残す。ロックの外で呼ぶこと（提出を遅くしないため）。 */
function logAudit_(what, b, flags) {
  if (!flags || !flags.length) return;
  try {
    var sh = sheet(SHEETS.audit);
    sh.appendRow([
      nowIso(),
      what,
      String((b && b.research_id) || '').trim(),
      dateStr(b && b.date),
      flags.join(' / '),
      String((b && b.client_id) || '').trim(),
      String((b && b.app_version) || '').trim()
    ]);
  } catch (e) {
    /* 記録に失敗しても提出は通す。監査は保険であって関門ではない */
    Logger.log('監査ログに書けませんでした: ' + e);
  }
}

/**
 * 主務が手で実行する。同じ(研究ID, 日付)が2行以上ある組み合わせを挙げる。
 * 出し直しは仕様なので普通に起きる。解析では最後の1件を採る。
 * 提出のたびに調べるとロックが伸びるので、ここで手動にしている。
 */
function findDuplicates() {
  var rows = readAll(SHEETS.answers);
  var seen = {}, dup = {};
  for (var i = 0; i < rows.length; i++) {
    var k = String(rows[i].research_id).trim() + ' / ' + dateStr(rows[i].date);
    seen[k] = (seen[k] || 0) + 1;
    if (seen[k] > 1) dup[k] = seen[k];
  }
  var keys = Object.keys(dup).sort();
  var out = keys.length
    ? ('同じ日に2件以上ある組み合わせ ' + keys.length + ' 件:\n'
       + keys.map(function (k) { return '  ' + k + ' → ' + dup[k] + '件'; }).join('\n'))
    : '重複はありません。';
  Logger.log(out);
  return out;
}

/* ============================ 小道具 ============================ */

function ss() { return SpreadsheetApp.getActive(); }

function sheet(def) {
  if (!def || !def.name) throw new Error('sheet(): シート定義が壊れている: ' + JSON.stringify(def));
  var s = ss().getSheetByName(def.name);
  if (!s) {
    s = ss().insertSheet(def.name);
    s.appendRow(def.head);
    s.setFrozenRows(1);
    applyTextFormat_(s, def);
  }
  return s;
}

/** 数値と誤解釈される列を「書式なしテキスト」に固定する。 */
function applyTextFormat_(s, def) {
  var cols = TEXT_COLS[def.name] || [];
  for (var i = 0; i < cols.length; i++) {
    var c = def.head.indexOf(cols[i]) + 1;
    if (c > 0) s.getRange(1, c, s.getMaxRows(), 1).setNumberFormat('@');
  }
}

/** 既に作ってしまったシートの書式を直す。1回実行すればよい。 */
function fixFormats() {
  var done = [];
  for (var k in SHEETS) {
    var def = SHEETS[k];
    var s = ss().getSheetByName(def.name);
    if (!s) continue;
    applyTextFormat_(s, def);
    done.push(def.name);
  }
  var out = '書式を直しました: ' + done.join(' / ');
  Logger.log(out);
  return out;
}

/** ヘッダ行をキーにして [{col: value}] を返す */
function readAll(def) {
  var s = ss().getSheetByName(def.name);
  if (!s) return [];
  var last = s.getLastRow();
  if (last < 2) return [];
  var width = Math.max(def.head.length, s.getLastColumn());
  var vals = s.getRange(1, 1, last, width).getValues();
  var head = vals[0];
  var out = [];
  for (var i = 1; i < vals.length; i++) {
    var o = {};
    for (var c = 0; c < head.length; c++) {
      var k = String(head[c]).trim();
      if (k) o[k] = vals[i][c];
    }
    out.push(o);
  }
  return out;
}

function hasClientId(sh, head, clientId) {
  var col = head.indexOf('client_id') + 1;
  var last = sh.getLastRow();
  if (col < 1 || last < 2) return false;
  var target = String(clientId).trim();
  if (!target) return false;

  /* TextFinder はシート側で探すので、列を全部 JavaScript に読み込まない。
     10月には回答が1,700行を超える。全件読みをロックの中でやると、
     練習直後に38人が一斉に送ったとき後ろの人がロック待ちで弾かれる。 */
  try {
    var found = sh.getRange(2, col, last - 1, 1)
      .createTextFinder(target)
      .matchEntireCell(true)
      .matchCase(true)
      .findNext();
    return found !== null;
  } catch (e) {
    /* TextFinder が使えない環境向けの保険。遅いが正しい。 */
    var vals = sh.getRange(2, col, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).trim() === target) return true;
    }
    return false;
  }
}

/* "30001, 90009" / "30001,90009" / 数値 のどれでも配列にする。
   書き出すときは必ず ', '（空白つき）で繋ぐこと。','だけだとスプレッドシートが
   桁区切りの数値 3000190009 と解釈して、IDが復元できなくなる（実運用で踏んだ）。 */
function splitIds(v) {
  if (!v) return [];
  if (Object.prototype.toString.call(v) === '[object Array]') {
    return v.map(function (x) { return String(x).trim(); }).filter(String);
  }
  return String(v).split(',').map(function (x) { return x.trim(); }).filter(String);
}

/* 文字数で切る。'a'.repeat(199) + 絵文字 に slice(0,200) をかけると
   絵文字の上半分だけが残り、壊れた文字がシートに入る。コードポイントで数える。 */
function cutText(s, n) {
  if (s === null || s === undefined) return '';
  var a = String(s).split(/(?:)/u);
  return a.length <= n ? String(s) : a.slice(0, n).join('');
}

function numOrBlank(v) {
  if (v === null || v === undefined || v === '') return '';
  var n = Number(v);
  return isFinite(n) ? n : '';
}

function nowIso() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss");
}

function todayStr() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

/** Date でも "2026-09-08" でも受けて "YYYY-MM-DD" にそろえる */
function dateStr(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  /* 桁数だけ見ていると 2026-02-30 や 2026-13-45 が素通りし、
     文字列のまま確定保存されて解析時に1行分が欠ける。実在するか確かめる。 */
  var y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  var t = new Date(y, m - 1, d);
  if (t.getFullYear() !== y || t.getMonth() !== m - 1 || t.getDate() !== d) return '';
  return s;
}

function addDays(ymd, n) {
  var p = ymd.split('-');
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  d.setDate(d.getDate() + n);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

/* ============================ 初期化 ============================ */

/** 最初に1回だけ手で実行する。5つのシートとヘッダを作る。 */
function setup() {
  for (var k in SHEETS) sheet(SHEETS[k]);
  var cal = sheet(SHEETS.calendar);
  if (cal.getLastRow() < 2) {
    cal.appendRow([todayStr(), '練習', '（例）ここに予定を書く', '', '行が無い日は練習として扱われます']);
  }
  return '5つのシートを用意しました';
}

/* ============================ 自己テスト ============================ */

/**
 * Apps Script のエディタから実行して、ログが「テスト OK」で終わることを確認する。
 * 実データを汚さないよう、テスト用の research_id (ZZ_TEST) で書いて最後に消す。
 */
function selfTest() {
  var log = [];
  function chk(name, cond) { log.push((cond ? 'OK   ' : 'FAIL ') + name); if (!cond) throw new Error('FAIL: ' + name); }

  setup();

  var cid = 'test-' + new Date().getTime();
  var d = todayStr();

  // 実施 → srpe が計算される
  var r1 = submit({ research_id: 'ZZ_TEST', date: d, status: '実施', minutes: 95, rpe: 6,
                    completion: '計画どおり', client_id: cid, app_version: 'test' });
  chk('実施が書ける', r1.ok === true);
  chk('srpe = 570', r1.srpe === 570);

  // 同じ client_id は重複として無視される
  var r2 = submit({ research_id: 'ZZ_TEST', date: d, status: '実施', minutes: 95, rpe: 6,
                    completion: '計画どおり', client_id: cid });
  chk('重複が弾かれる', r2.duplicate === true);

  // 休養は minutes/rpe を空で送る
  var r3 = submit({ research_id: 'ZZ_TEST', date: addDays(d, -1), status: '休養', client_id: cid + '-b' });
  chk('休養が書ける', r3.ok === true);
  chk('休養の srpe は null', r3.srpe === null);

  // 休養に0を入れたら弾く
  var r4 = submit({ research_id: 'ZZ_TEST', date: addDays(d, -2), status: '休養', minutes: 0, rpe: 0, client_id: cid + '-c' });
  chk('休養に0を入れると弾かれる', r4.ok === false);

  // RPE 0 は有効（未入力と区別する）
  var r5 = submit({ research_id: 'ZZ_TEST', date: addDays(d, -3), status: '実施', minutes: 30, rpe: 0,
                    completion: '計画どおり', client_id: cid + '-d' });
  chk('RPE 0 は有効', r5.ok === true && r5.srpe === 0);

  // 予定は同じ日なら上書き
  var p1 = savePlan({ research_id: 'ZZ_TEST', date: addDays(d, 1), block_ids: ['90009'], client_id: cid + '-p1' });
  var p2 = savePlan({ research_id: 'ZZ_TEST', date: addDays(d, 1), block_ids: ['90009', '90014'], client_id: cid + '-p2' });
  chk('予定が書ける', p1.ok === true && p1.updated === false);
  chk('同じ日の予定は上書きされる', p2.updated === true);

  var m = mine('ZZ_TEST');
  chk('mine が実績を返す', !!m.answers[d]);
  chk('mine が予定を返す', !!m.plans[addDays(d, 1)]);

  cleanupTestRows_();
  log.push('テスト OK');
  Logger.log(log.join('\n'));
  return log.join('\n');
}

function cleanupTestRows_() {
  [SHEETS.answers, SHEETS.plans].forEach(function (def) {
    var sh = ss().getSheetByName(def.name);
    if (!sh) return;
    var last = sh.getLastRow();
    if (last < 2) return;
    var vals = sh.getRange(2, 2, last - 1, 1).getValues();   // research_id は2列目
    for (var i = vals.length - 1; i >= 0; i--) {
      if (String(vals[i][0]).trim() === 'ZZ_TEST') sh.deleteRow(i + 2);
    }
  });
}
