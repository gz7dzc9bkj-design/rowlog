/* RowLog 設定
   ここだけ直せば繋ぎ先が変わる。ほかのファイルは触らない。 */
var ROWLOG_CONFIG = {
  /* Apps Script のウェブアプリURL。デプロイして出てきた
     https://script.google.com/macros/s/......../exec をここに貼る。 */
  API_URL: 'https://script.google.com/macros/s/AKfycbwCuGtI3XsOeeSH-TA6DZ14DEGBGIPGee_17ZZPisjOHi2KEIsz6JLSHbqWW8n3uSvkPg/exec',

  /* 収集を始める日。これより前は「未提出」に数えない。
     アプリが無かった日まで未提出扱いになるのを防ぐ。 */
  COLLECT_FROM: '2026-09-01',

  VERSION: '1.1.2'
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
