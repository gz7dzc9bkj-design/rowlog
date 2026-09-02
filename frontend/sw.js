/* RowLog Service Worker

   目的は「電波が無いところでもアプリが開けること」だけ。
   艇庫は電波が悪く、開けないと記録を書き留める場所そのものが無くなる。

   キャッシュ優先にはしない。スマホが古い js を掴んだまま動き続ける事故を
   実際に踏んでいるので、通信できるときは必ず新しいものを取りに行き、
   落ちたときだけ最後に取れたものを返す（network-first）。 */

var VERSION = 'rowlog-1.1.2';
var SHELL = [
  './',
  './index.html',
  './style.css?v=1.1.2',
  './config.js?v=1.1.2',
  './logic.js?v=1.1.2',
  './app.js?v=1.1.2',
  './manifest.webmanifest?v=1.1.2',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION)
      .then(function (c) { return c.addAll(SHELL); })
      .catch(function () { /* 1つでも取れなければ諦める。起動は妨げない */ })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === VERSION ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                       // 送信は素通し
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // Apps Script は触らない

  /* HTML はブラウザのHTTPキャッシュを必ず飛ばして取りに行く。
     GitHub Pages は HTML に短い max-age を付けるので、ふつうに fetch すると
     配信し直した直後でも古い index.html が返り、それを Service Worker が
     さらに保存してしまう。結果、直したのに古い js/css を読み続ける
     （検証中に実際に踏んだ）。 */
  var isShell = (req.mode === 'navigate')
    || url.pathname === '/' || /\/$|\.html$/.test(url.pathname);
  var go = isShell
    ? fetch(req.url, { cache: 'no-store' })
    : fetch(req);

  e.respondWith(
    go.then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match('./index.html');
      });
    })
  );
});
