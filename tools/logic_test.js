/* frontend/logic.js の単体テスト。node tools/logic_test.js で実行。 */
'use strict';
var L = require('../frontend/logic.js');

var fails = [];
function eq(name, got, want) {
  var g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) fails.push(name + ': got ' + g + ' want ' + w);
}
function ok(name, cond) {
  if (!cond) fails.push(name + ': false');
}

/* srpe */
eq('srpe(95,6)', L.srpe(95, 6), 570);
eq('srpe(0,0)', L.srpe(0, 0), 0);
eq('srpe(null,null) は null（欠席は0にしない）', L.srpe(null, null), null);
eq('srpe(95,null)', L.srpe(95, null), null);
eq('srpe("",6)', L.srpe('', 6), null);

/* parseSplit */
eq('parseSplit("1:57.5")', L.parseSplit('1:57.5'), 117.5);
eq('parseSplit("2:04.2")', L.parseSplit('2:04.2'), 124.2);
eq('parseSplit("57.5")', L.parseSplit('57.5'), 57.5);
eq('parseSplit(":49.6")', L.parseSplit(':49.6'), null);
eq('parseSplit("1:67.0") は不正', L.parseSplit('1:67.0'), null);
eq('parseSplit("") は null', L.parseSplit(''), null);
eq('parseSplit("abc") は null', L.parseSplit('abc'), null);

/* formatSplit */
eq('formatSplit(117.5)', L.formatSplit(117.5), '1:57.5');
eq('formatSplit(124.2)', L.formatSplit(124.2), '2:04.2');

/* checkErg: 実データ由来
   写真#37 = 20:00 で 5106m、平均split 1:57.5（実測1:57.5相当） */
var c1 = L.checkErg(5106, 1200, '1:57.5');
ok('checkErg 5106m/20:00/1:57.5 は整合', c1.ok === true);
var c2 = L.checkErg(5106, 1200, '2:30.0');
ok('checkErg 5106m/20:00/2:30.0 は不整合', c2.ok === false);
/* 写真#60 = 20:00 で 5150m */
var c3 = L.checkErg(5150, 1200, '1:56.5');
ok('checkErg 5150m/20:00/1:56.5 は整合', c3.ok === true);
var c4 = L.checkErg(0, 1200, '1:57.5');
ok('checkErg 距離0 は判定不能', c4.ok === null);

/* レンジ: rateの上限は60。40で弾かない（実測54） */
ok('rate 54 は有効', L.inRange('rate', 54) === true);
ok('rate 41 は有効', L.inRange('rate', 41) === true);
ok('rate 61 は無効', L.inRange('rate', 61) === false);
ok('rate 9 は無効', L.inRange('rate', 9) === false);
ok('drag 125 は有効', L.inRange('drag', 125) === true);

/* asksLoad */
ok('実施 は負荷を聞く', L.asksLoad('実施') === true);
ok('一部実施 は負荷を聞く', L.asksLoad('一部実施') === true);
ok('欠席 は聞かない', L.asksLoad('欠席') === false);
ok('休養 は聞かない', L.asksLoad('休養') === false);

/* validate */
var base = { research_id: 'C22', date: '2026-09-08', client_id: 'x-1' };
function rec(o) { var r = {}; for (var k in base) r[k] = base[k]; for (var k2 in o) r[k2] = o[k2]; return r; }

eq('正常な実施',
  L.validate(rec({ status: '実施', minutes: 95, rpe: 6, completion: '計画どおり' })), []);
eq('正常な休養',
  L.validate(rec({ status: '休養', minutes: null, rpe: null })), []);
ok('休養に0を入れたら弾く',
  L.validate(rec({ status: '休養', minutes: 0, rpe: 0 })).length === 2);
ok('実施でRPE未入力なら弾く',
  L.validate(rec({ status: '実施', minutes: 95, rpe: null, completion: '計画どおり' })).length > 0);
ok('日付の形式が不正なら弾く',
  L.validate(rec({ status: '休養', date: '2026/9/8' })).length > 0);
ok('client_idが無いと弾く',
  L.validate({ research_id: 'C22', date: '2026-09-08', status: '休養' }).length > 0);
ok('RPE 0 は有効（未入力と区別する）',
  L.validate(rec({ status: '実施', minutes: 30, rpe: 0, completion: '計画どおり' })).length === 0);

/* impliedSeconds: 距離とsplitから1本の時間を逆算 */
eq('impliedSeconds(5106,"1:57.5")≒1200', Math.round(L.impliedSeconds(5106, '1:57.5')), 1200);
eq('impliedSeconds(2000,"1:45.0")', Math.round(L.impliedSeconds(2000, '1:45.0')), 420);
eq('impliedSeconds(0,"1:57.5") は null', L.impliedSeconds(0, '1:57.5'), null);
eq('impliedSeconds(5106,"") は null', L.impliedSeconds(5106, ''), null);

/* ergWarnings: 打ち間違いを捕まえる。距離とsplitの突き合わせはしない */
eq('正常なエルゴ入力に警告は出ない',
  L.ergWarnings({ distance: 5106, split: '1:57.5', rate: 25, drag: 125 }), []);
eq('空欄に警告は出ない', L.ergWarnings({ distance: '', split: '', rate: '', drag: '' }), []);
ok('距離の桁違いを捕まえる', L.ergWarnings({ distance: 51060 }).length === 1);
ok('距離が小さすぎるのを捕まえる', L.ergWarnings({ distance: 50 }).length === 1);
ok('splitの書き方の誤りを捕まえる', L.ergWarnings({ split: '157.5' }).length === 1);
ok('速すぎるsplitを捕まえる', L.ergWarnings({ split: '1:05.0' }).length === 1);
ok('レート61を捕まえる', L.ergWarnings({ rate: 61 }).length === 1);
eq('レート54は通す（実測値）', L.ergWarnings({ rate: 54 }), []);
ok('ドラッグ300を捕まえる', L.ergWarnings({ drag: 300 }).length === 1);
eq('20分エルゴの実データ(5150m/1:56.5/rate26/DF125)に警告なし',
  L.ergWarnings({ distance: 5150, split: '1:56.5', rate: 26, drag: 125 }), []);

/* 表示用の丸め: 秒を先に丸めないと 19分60秒 になる（実際に出た） */
(function () {
  function human(sec) { var t = Math.round(sec), m = Math.floor(t / 60), s = t - m * 60; return m + '分' + (s < 10 ? '0' : '') + s + '秒'; }
  eq('5106m/1:57.5 は 20分00秒', human(L.impliedSeconds(5106, '1:57.5')), '20分00秒');
  eq('2000m/1:45.0 は 7分00秒', human(L.impliedSeconds(2000, '1:45.0')), '7分00秒');
})();

/* 質問文が凍結されていること */
eq('RPE_QUESTION', L.RPE_QUESTION, '今日の練習全体は、どのくらいきつかったですか');
eq('参加状態の4値', L.STATUS, ['実施', '一部実施', '欠席', '休養']);
eq('完了度の4値', L.COMPLETION, ['計画どおり', '短縮', '中止', '変更']);

if (fails.length) {
  console.log('FAIL ' + fails.length + '件');
  fails.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
console.log('logic.js OK');
