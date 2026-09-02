/* RowLog 設定
   ここだけ直せば繋ぎ先が変わる。ほかのファイルは触らない。 */
var ROWLOG_CONFIG = {
  /* Apps Script のウェブアプリURL。デプロイして出てきた
     https://script.google.com/macros/s/......../exec をここに貼る。 */
  API_URL: 'https://script.google.com/macros/s/AKfycbwCuGtI3XsOeeSH-TA6DZ14DEGBGIPGee_17ZZPisjOHi2KEIsz6JLSHbqWW8n3uSvkPg/exec',

  /* 収集を始める日。これより前は「未提出」に数えない。
     アプリが無かった日まで未提出扱いになるのを防ぐ。 */
  COLLECT_FROM: '2026-09-01',

  VERSION: '1.0.0'
};

/* 検証用: ?api=http://localhost:8766 を付けると繋ぎ先を差し替えられる。
   本番のURLをここに書く必要はない。 */
(function () {
  var m = String(location.search).match(/[?&]api=([^&]+)/);
  if (m) ROWLOG_CONFIG.API_URL = decodeURIComponent(m[1]);
})();
