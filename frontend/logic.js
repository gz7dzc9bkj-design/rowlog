/* RowLog 純粋関数。DOM・fetch・localStorage に触れないこと。
   index.html からも tools/logic_test.js からも読む。 */
(function (root) {
  'use strict';

  /* RPEの質問文。変えると答えが変わり、比較できなくなる。凍結。 */
  var RPE_QUESTION = '今日の練習全体は、どのくらいきつかったですか';

  var RPE_LABELS = {
    0: '休んでいるのと同じ',
    1: 'とても楽',
    2: '楽',
    3: 'ふつう',
    4: 'ややきつい',
    5: 'きつい',
    6: 'きつい〜とてもきつい',
    7: 'とてもきつい',
    8: 'かなりきつい',
    9: '限界に近い',
    10: '限界。これ以上は無理'
  };

  var STATUS = ['実施', '一部実施', '欠席', '休養'];
  var COMPLETION = ['計画どおり', '短縮', '中止', '変更'];

  /* 練習時間とRPEを聞くのは実施・一部実施のときだけ */
  function asksLoad(status) {
    return status === '実施' || status === '一部実施';
  }

  /* sRPE負荷 = 時間(分) × RPE。欠席・休養は null（0にしない） */
  function srpe(minutes, rpe) {
    if (minutes === null || minutes === undefined || minutes === '') return null;
    if (rpe === null || rpe === undefined || rpe === '') return null;
    var m = Number(minutes), r = Number(rpe);
    if (!isFinite(m) || !isFinite(r)) return null;
    return m * r;
  }

  /* "1:57.5" -> 117.5 秒。"57.5" -> 57.5。読めなければ null */
  function parseSplit(s) {
    if (s === null || s === undefined) return null;
    var t = String(s).trim();
    if (!t) return null;
    var m = t.match(/^(?:(\d+):)?(\d{1,2}(?:\.\d+)?)$/);
    if (!m) return null;
    var min = m[1] ? Number(m[1]) : 0;
    var sec = Number(m[2]);
    if (sec >= 60) return null;
    return min * 60 + sec;
  }

  function formatSplit(sec) {
    if (sec === null || sec === undefined || !isFinite(sec)) return '';
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  /* 距離・時間・splitの整合。許容 ±0.5秒/500m */
  function checkErg(distance, seconds, split) {
    var d = Number(distance), t = Number(seconds);
    var sp = parseSplit(split);
    if (!isFinite(d) || d <= 0 || !isFinite(t) || t <= 0 || sp === null) {
      return { ok: null, expected: null, diff: null };
    }
    var expected = t / (d / 500);
    var diff = sp - expected;
    return { ok: Math.abs(diff) <= 0.5, expected: expected, diff: diff };
  }

  /* 物理レンジ。rateの上限は60。40で弾くと短距離インターバルが全滅する */
  var RANGE = {
    rate: [10, 60],
    splitSec: [70, 180],   // 1:10 〜 3:00
    rpe: [0, 10],
    minutes: [1, 600],
    drag: [50, 250]
  };

  function inRange(name, v) {
    var r = RANGE[name];
    if (!r) return null;
    var n = Number(v);
    if (!isFinite(n)) return false;
    return n >= r[0] && n <= r[1];
  }

  /* 送信前の検証。問題があれば理由の配列を返す */
  function validate(rec) {
    var e = [];
    if (!rec.research_id) e.push('研究用IDが無い');
    if (!rec.date || !/^\d{4}-\d{2}-\d{2}$/.test(rec.date)) e.push('日付の形式が不正');
    if (STATUS.indexOf(rec.status) < 0) e.push('参加状態が不正');
    if (asksLoad(rec.status)) {
      if (!inRange('minutes', rec.minutes)) e.push('練習時間が不正');
      else if (Number(rec.minutes) % 1 !== 0) e.push('練習時間は整数で入れてください');
      if (rec.rpe === null || rec.rpe === undefined || rec.rpe === '' || !inRange('rpe', rec.rpe)) e.push('RPEが未入力');
      if (COMPLETION.indexOf(rec.completion) < 0) e.push('完了度が不正');
    } else {
      /* 欠席・休養では空にする。0を入れない */
      if (rec.minutes !== null && rec.minutes !== undefined && rec.minutes !== '') e.push('欠席・休養で練習時間が入っている');
      if (rec.rpe !== null && rec.rpe !== undefined && rec.rpe !== '') e.push('欠席・休養でRPEが入っている');
    }
    if (rec.note && String(rec.note).length > 200) e.push('ひとことが200字を超えている');
    if (!rec.client_id) e.push('client_idが無い');
    /* エルゴの値も送信を止める。以前は赤字の警告を出すだけで、そのまま出せていた。 */
    e = e.concat(ergWarnings({
      distance: rec.erg_distance,
      split: rec.erg_split,
      rate: rec.erg_rate,
      drag: rec.erg_drag
    }));
    return e;
  }

  /* 距離と split から、その1本にかかった時間(秒)を逆算する。
     日々の入力では時間を聞かないので、checkErg の代わりにこれを使う。 */
  function impliedSeconds(distance, split) {
    var d = Number(distance), sp = parseSplit(split);
    if (!isFinite(d) || d <= 0 || sp === null) return null;
    return d / 500 * sp;
  }

  /* エルゴの入力値がありえない範囲でないかを見る。打ち間違いを捕まえるのが目的。
     距離とsplitの突き合わせはしない（時間を聞いていないので循環する）。 */
  function ergWarnings(rec) {
    var w = [];
    rec = rec || {};
    if (rec.distance !== '' && rec.distance !== null && rec.distance !== undefined) {
      var d = Number(rec.distance);
      if (!isFinite(d) || d < 100 || d > 40000) w.push('距離が桁違いかもしれません');
    }
    if (rec.split) {
      var sp = parseSplit(rec.split);
      if (sp === null) w.push('splitの書き方が読めません（1:57.5 のように書いてください）');
      else if (!inRange('splitSec', sp)) w.push('splitが 1:10〜3:00 の外です');
    }
    if (rec.rate !== '' && rec.rate !== null && rec.rate !== undefined) {
      if (!inRange('rate', rec.rate)) w.push('レートが 10〜60 の外です');
    }
    if (rec.drag !== '' && rec.drag !== null && rec.drag !== undefined) {
      if (!inRange('drag', rec.drag)) w.push('ドラッグファクターが 50〜250 の外です');
    }
    return w;
  }

  var api = {
    RPE_QUESTION: RPE_QUESTION,
    RPE_LABELS: RPE_LABELS,
    STATUS: STATUS,
    COMPLETION: COMPLETION,
    RANGE: RANGE,
    asksLoad: asksLoad,
    srpe: srpe,
    parseSplit: parseSplit,
    formatSplit: formatSplit,
    checkErg: checkErg,
    impliedSeconds: impliedSeconds,
    ergWarnings: ergWarnings,
    inRange: inRange,
    validate: validate
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RowLogLogic = api;
})(typeof self !== 'undefined' ? self : this);
