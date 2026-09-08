/* RowLog 設定
   ここだけ直せば繋ぎ先が変わる。ほかのファイルは触らない。 */
var ROWLOG_CONFIG = {
  /* Apps Script のウェブアプリURL。デプロイして出てきた
     https://script.google.com/macros/s/......../exec をここに貼る。 */
  API_URL: 'https://script.google.com/macros/s/AKfycbwCuGtI3XsOeeSH-TA6DZ14DEGBGIPGee_17ZZPisjOHi2KEIsz6JLSHbqWW8n3uSvkPg/exec',

  /* 収集を始める日。これより前は「未提出」に数えない。
     アプリが無かった日まで未提出扱いになるのを防ぐ。 */
  COLLECT_FROM: '2026-09-01',

  /* 身体測定と20分エルゴを出す月。ここに無い月は測定の案内を出さない。
     予定は9・10・11月の3回。11月分がそのまま高体連の提出になる。

     **いまは空にしてある。** Apps Script 側がまだ measure に対応していないため。
     このまま案内を出すと、部員の入力が失敗して「送れなかった記録」に溜まる。
     スプレッドシートの Code.gs を更新してデプロイしたら、
     ['2026-09', '2026-10', '2026-11'] に戻して ?v= を上げる。 */
  MEASURE_MONTHS: [],

  VERSION: '1.4.1'
};

/* 検証用: ?api=http://localhost:8766 を付けると繋ぎ先を差し替えられる。

   差し替えを開発機からのアクセスに限る。以前は誰でも
   ?api=https://攻撃者/collect を付けたリンクを配れば、踏んだ端末の
   通信を丸ごと外に流せた。見た目は本物と区別がつかない。 */
(function () {
  var devHost = location.hostname === 'localhost'
    || location.hostname === '127.0.0.1'
    || location.hostname === '';
  if (!devHost) return;
  var m = String(location.search).match(/[?&]api=([^&]+)/);
  if (!m) return;
  var v = decodeURIComponent(m[1]);
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(v)) return;
  ROWLOG_CONFIG.API_URL = v;
})();
