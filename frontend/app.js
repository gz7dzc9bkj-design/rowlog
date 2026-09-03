/* RowLog 本体。DOM と通信はここ。純粋なルールは logic.js に置く。 */
(function () {
  'use strict';

  var L = window.RowLogLogic;
  var CFG = window.ROWLOG_CONFIG;
  var K = { me: 'rowlog.me', boot: 'rowlog.boot', queue: 'rowlog.queue', mine: 'rowlog.mine',
            draft: 'rowlog.draft', failed: 'rowlog.failed' };
  var MAX_TRIES = 5;        // これを超えたら諦めて「送れなかった」箱に移す
  var MAX_QUEUE = 120;      // 送信待ちの上限。これ以上は端末の保存を圧迫する
  var flushing = false;     // flush の二重起動止め
  var sending = false;      // 「出す」の二重押し止め

  var state = {
    boot: null,        // {roster, menu, calendar, today}
    me: null,          // {id, name, grade, cls}
    date: null,        // 編集中の日付
    planMode: false,   // 未来の日 = 予定の入力
    mine: { answers: {}, plans: {} },
    todayStatus: null,
    form: null,
    calYm: null
  };

  /* ---------------- 保存 ---------------- */
  function load(k, d) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }
    catch (e) { return d; }
  }
  /* 保存の成否を必ず返す。以前は例外を握りつぶしていたので、
     Cookieを全部ブロックしたiPhoneでは何も保存されないのに
     「出しました」とだけ出て、記録が丸ごと消えていた。 */
  function save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { console.warn('保存できません', k, e); return false; }
  }
  function storageWorks() {
    try {
      localStorage.setItem('rowlog.probe', '1');
      localStorage.removeItem('rowlog.probe');
      return true;
    } catch (e) { return false; }
  }
  function uuid() {
    return 'x-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* ---------------- 通信 ----------------

     必ず制限時間を付ける。電波の弱い艇庫や、Wi-Fiに繋がっているのに
     外に出られない状態（学校のネット、コンビニのWi-Fiなど）では、
     fetch はいつまでも返らない。制限時間が無いと画面が
     「読み込んでいます…」のまま永久に止まる。

     Apps Script は38人が一斉に叩くと遅い。実測で最後の1人は19秒かかった。
     読み込みは25秒、送信は30秒まで待つ。 */
  var TIMEOUT_GET = 25000;
  var TIMEOUT_POST = 30000;

  function fetchTimeout(url, opts, ms) {
    opts = opts || {};
    if (typeof AbortController === 'undefined') {
      /* AbortController が無い古い端末。せめて時間で打ち切る */
      return new Promise(function (resolve, reject) {
        var done = false;
        var t = setTimeout(function () {
          if (!done) { done = true; reject(new Error('timeout')); }
        }, ms);
        fetch(url, opts).then(function (r) {
          if (done) return;
          done = true; clearTimeout(t); resolve(r);
        }, function (e) {
          if (done) return;
          done = true; clearTimeout(t); reject(e);
        });
      });
    }
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, ms);
    opts.signal = ac.signal;
    return fetch(url, opts).then(function (r) {
      clearTimeout(timer); return r;
    }, function (e) {
      clearTimeout(timer); throw e;
    });
  }

  /* Apps Script が混雑や認証で HTML を返すことがある。
     そのまま r.json() すると読めない例外になり、原因が分からなくなる。
     JSON でなければ「一時的な失敗」として扱えるよう印を付けて投げる。 */
  function readJson(r) {
    return r.text().then(function (t) {
      try {
        return JSON.parse(t);
      } catch (e) {
        var err = new Error('サーバーがJSONを返しませんでした');
        err.notJson = true;
        err.head = String(t).slice(0, 120);
        throw err;
      }
    });
  }

  function api(action, params) {
    var url = CFG.API_URL + (CFG.API_URL.indexOf('?') < 0 ? '?' : '&') + 'action=' + encodeURIComponent(action);
    for (var k in (params || {})) {
      if (params[k] !== null && params[k] !== undefined) {
        url += '&' + k + '=' + encodeURIComponent(params[k]);
      }
    }
    return fetchTimeout(url, { method: 'GET' }, TIMEOUT_GET).then(readJson);
  }

  /* Apps Script はレスポンスヘッダを付けられない。
     text/plain で送ってプリフライト(OPTIONS)自体を起こさないのが定石。 */
  function post(payload) {
    return fetchTimeout(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }, TIMEOUT_POST).then(readJson);
  }

  /* ---------------- 送信キュー（オフライン対応） ---------------- */
  function queue() { return load(K.queue, []); }
  function enqueue(payload) {
    var q = queue();
    /* 上限を超えたら古いものから諦める。放っておくと localStorage の
       容量を使い切り、以後どの保存も失敗するようになる。 */
    if (q.length >= MAX_QUEUE) {
      var dropped = q.splice(0, q.length - MAX_QUEUE + 1);
      var fl = failed();
      dropped.forEach(function (d) {
        fl.push({ payload: d, error: '送信待ちが溜まりすぎたため保留', at: new Date().toISOString() });
      });
      save(K.failed, fl);
    }
    q.push(payload);
    var ok = save(K.queue, q);
    paintQueue();
    return ok;
  }
  function failed() { return load(K.failed, []); }
  /* flush は「出す」ボタン・online イベント・画面復帰の3か所から呼ばれる。
     同時に走ると同じ1件を2回送ってしまう（client_id で弾かれるので
     データは壊れないが、混雑時に無駄な往復が増える）。 */
  function flush() {
    var q = queue();
    if (!q.length || !CFG.API_URL) return Promise.resolve(0);
    if (flushing) return Promise.resolve(0);
    flushing = true;
    var sent = 0;
    function step() {
      var cur = queue();
      if (!cur.length) return Promise.resolve(sent);
      return post(cur[0]).then(function (res) {
        if (res && res.ok) {
          var rest = queue();
          rest.shift();
          save(K.queue, rest);
          sent++;
          paintQueue();
          return step();
        }
        /* 以前はここで ok:false を理由を問わず捨てていた。ロック取得の
           タイムアウトのような一時的なサーバー側の失敗でも記録が消え、
           画面は「送信待ち0件」になって本人は気づけなかった。
           検証エラー(kind:'validation')だけ捨て、それ以外は回数を数えて粘る。 */
        if (res && res.ok === false) {
          var r2 = queue();
          var bad = r2[0];
          var giveUp = (res.kind === 'validation');
          if (!giveUp) {
            bad._tries = (bad._tries || 0) + 1;
            if (bad._tries < MAX_TRIES) { save(K.queue, r2); paintQueue(); return sent; }
            giveUp = true;
          }
          r2.shift();
          save(K.queue, r2);
          var fl = failed();
          fl.push({ payload: bad, error: res.error || '', at: new Date().toISOString() });
          save(K.failed, fl);
          console.warn('送れないため保留にしました:', res.error, bad);
          paintQueue();
          return step();
        }
        return sent;
      }).catch(function (e) {
        /* 通信の失敗・制限時間切れ・JSONでない返事。どれも一時的なものとして
           キューに残す。ここで消すと記録が黙って消える。 */
        if (e && e.notJson) console.warn('JSONでない返事:', e.head);
        return sent;
      });
    }
    return step().then(function (n) {
      flushing = false;
      return n;
    }, function (e) {
      flushing = false;
      throw e;
    });
  }
  function paintQueue() {
    var n = queue().length;
    var e = document.getElementById('queueCount');
    if (e) e.textContent = n + ' 件';
    var b = document.getElementById('queueBadge');
    if (b) b.classList.toggle('hidden', n === 0);
    var f = failed().length;
    var fe = document.getElementById('failedRow');
    if (fe) {
      fe.classList.toggle('hidden', f === 0);
      var fc = document.getElementById('failedCount');
      if (fc) fc.textContent = f + ' 件';
    }
  }

  /* ---------------- 下書き ----------------
     RPEは「練習が終わって15〜30分後に答える」運用なので、入力の途中で
     一度アプリを離れるのが普通。iPhone Safari は裏に回ったタブを勝手に
     読み込み直すため、下書きが無いと毎回ゼロからやり直しになっていた。 */
  function drafts() { return load(K.draft, {}); }
  function saveDraft() {
    if (!state.form || !state.date) return;
    var d = drafts();
    d[state.date] = {
      form: state.form,
      minutes: valOf('minutes'),
      note: valOf('note'),
      erg: {
        dist: valOf('dist'), split: valOf('split'), rate: valOf('rate'),
        drag: valOf('drag'), machine: valOf('machine')
      },
      at: Date.now()
    };
    // 古い下書きを溜めない。30日より前は捨てる
    var limit = Date.now() - 30 * 24 * 3600 * 1000;
    Object.keys(d).forEach(function (k) { if (!d[k].at || d[k].at < limit) delete d[k]; });
    save(K.draft, d);
    paintDraftNote();
  }
  function clearDraft(date) {
    var d = drafts();
    if (d[date]) { delete d[date]; save(K.draft, d); }
    paintDraftNote();
  }
  function applyDraft(date) {
    var d = drafts()[date];
    if (!d || !d.form) return false;
    state.form = d.form;
    setVal('minutes', d.minutes);
    setVal('note', d.note);
    var e = d.erg || {};
    setVal('dist', e.dist); setVal('split', e.split); setVal('rate', e.rate);
    setVal('drag', e.drag); setVal('machine', e.machine);
    return true;
  }
  function valOf(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  function setVal(id, v) { var e = document.getElementById(id); if (e) e.value = (v == null ? '' : v); }
  function paintDraftNote() {
    var n = document.getElementById('draftNote');
    if (!n) return;
    var has = !!drafts()[state.date];
    n.classList.toggle('hidden', !has);
  }

  /* ---------------- 日付 ---------------- */
  var WD = ['日', '月', '火', '水', '木', '金', '土'];
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function toDate(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function fmt(s) {
    var d = toDate(s);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WD[d.getDay()] + '）';
  }
  function planOf(dateStr) {
    var c = (state.boot && state.boot.calendar) || {};
    return c[dateStr] || { kind: '練習', title: '', block_ids: [], note: '' };
  }

  /* 保存されている「自分」がまともな形か確かめる。

     このアプリは gz7dzc9bkj-design.github.io の /rowlog/ にあり、
     同じドメインの /heisou-plan/ /chronoboard/ /drive-cost/ とは
     localStorage を共有している（オリジンはパスを見ないため）。
     どれかに script を走らせられる穴があれば rowlog.me を書き換えられ、
     以後の提出が別人として送られる。形の検査だけでも、壊れた値のまま
     黙って他人になりすまして出し続ける事故は防げる。 */
  function sane(me) {
    if (!me || typeof me !== 'object') return false;
    if (!/^[A-C]\d{2}$/.test(String(me.id || ''))) return false;
    if (!me.name) return false;
    // 名簿を読めているなら、そこに実在するかまで見る
    var r = state.boot && state.boot.roster;
    if (r && r.length) {
      for (var i = 0; i < r.length; i++) {
        if (r[i].id === me.id) return r[i].name === me.name;
      }
      return false;
    }
    return true;
  }

  /* ---------------- 起動 ---------------- */
  function boot() {
    state.boot = load(K.boot, null);
    state.me = load(K.me, null);
    if (state.me && !sane(state.me)) {
      console.warn('保存されていた本人情報がおかしいので選び直します', state.me);
      localStorage.removeItem(K.me);
      state.me = null;
    }
    state.mine = load(K.mine, { answers: {}, plans: {} });
    state.date = todayStr();
    state.calYm = { y: toDate(state.date).getFullYear(), m: toDate(state.date).getMonth() + 1 };

    paintQueue();
    if (!storageWorks()) {
      var w = document.getElementById('storageWarn');
      if (w) w.classList.remove('hidden');
    }
    if (!CFG.API_URL) {
      showError('繋ぎ先が設定されていません。frontend/config.js の API_URL に Apps Script の URL を入れてください。');
      return;
    }

    if (state.boot && state.me) { start(); }
    else { document.getElementById('loading').classList.remove('hidden'); }

    /* 38人が一斉に開くと最後の人は20秒近く待たされる（実測）。
       黙って待たせると壊れたと思われるので、途中で状況を出す。 */
    var slow = setTimeout(function () {
      var e = document.getElementById('slowNote');
      if (e) e.classList.remove('hidden');
    }, 8000);

    api('bootstrap').then(function (r) {
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : '読み込みに失敗');
      clearTimeout(slow);
      state.boot = r;
      save(K.boot, r);
      document.getElementById('loading').classList.add('hidden');
      var sn = document.getElementById('slowNote');
      if (sn) sn.classList.add('hidden');
      checkClock(r.today);
      if (state.me && !sane(state.me)) {     // 名簿が来たので改めて確かめる
        localStorage.removeItem(K.me);
        state.me = null;
      }
      if (!state.me) { showSetup(); } else { start(); }
      return flush();
    }).then(function () {
      if (state.me) refreshMine();
    }).catch(function (e) {
      clearTimeout(slow);
      document.getElementById('loading').classList.add('hidden');
      var sn2 = document.getElementById('slowNote');
      if (sn2) sn2.classList.add('hidden');
      if (state.boot && state.me) {
        start();                      // 圏外でもキャッシュで動かす
        /* 圏外でも、前回読み込んだサーバー日付と比べれば時計ずれは分かる。
           起動の成功パスでしか見ていないと、時計ずれ×圏外が重なったときに
           警告が一度も出ないまま違う日付の記録が積まれる。 */
        checkClock(state.boot.today, true);
        toast('つながらないので、前に読み込んだ内容で動いています');
      } else {
        showError('つながりませんでした。電波のあるところでもう一度開いてください。');
      }
      console.warn(e);
    });

    window.addEventListener('online', function () {
      flush();
      // 電波が戻ったら時計も見直す。起動時1回きりだと直しても警告が消えない
      api('bootstrap').then(function (r) {
        if (r && r.ok) { state.boot = r; save(K.boot, r); checkClock(r.today); }
      }).catch(function () {});
    });
    /* iOS はホーム画面から戻したとき load が起きない。
       画面が表に出たタイミングでも送信待ちを片づける。 */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') flush();
    });
    window.addEventListener('pageshow', function () { flush(); });
  }

  /* 端末の日付がずれていると、違う日の記録として保存される。
     サーバーが返す今日と突き合わせて、ずれていたら知らせる。
     時差ではなく端末の時計そのものが狂っている場合を捕まえる。 */
  function checkClock(serverToday, stale) {
    var e = document.getElementById('clockWarn');
    if (!e || !serverToday) return;
    var mine = todayStr();
    if (mine === serverToday) { e.classList.add('hidden'); return; }
    /* 圏外のときは前回読み込んだ日付と比べる。日付が進んでいるのは当たり前なので、
       「進んでいる」だけでは警告しない。戻っている場合だけ確実におかしい。 */
    if (stale && mine > serverToday) { e.classList.add('hidden'); return; }
    e.textContent = 'この端末の日付は ' + mine + ' ですが、'
      + (stale ? '前に読み込んだときは ' : '実際は ') + serverToday
      + ' でした。日付がずれたまま出すと違う日の記録になります。'
      + '端末の日付設定を確かめてください。';
    e.classList.remove('hidden');
  }

  function showError(msg) {
    var e = document.getElementById('fatal');
    e.textContent = msg;
    e.classList.remove('hidden');
  }

  /* ---------------- 初回設定 ---------------- */
  function showSetup() {
    document.getElementById('setup').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
    var grades = {};
    state.boot.roster.forEach(function (p) { grades[p.grade] = 1; });
    var g = document.getElementById('setupGrade');
    g.innerHTML = '';
    Object.keys(grades).sort().forEach(function (gr) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = gr + '年';
      b.onclick = function () { pickGrade(Number(gr)); };
      g.appendChild(b);
    });
  }
  function pickGrade(gr) {
    var people = state.boot.roster.filter(function (p) { return p.grade === gr; });
    var wrap = document.getElementById('setupPeople');
    wrap.innerHTML = '';
    people.sort(function (a, b) { return (a.cls + a.id) < (b.cls + b.id) ? -1 : 1; });
    people.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<b>' + esc(p.name) + '</b><span>' + p.grade + '年' + esc(p.cls) + '組</span>';
      b.onclick = function () {
        state.me = p; save(K.me, p);
        document.getElementById('setup').classList.add('hidden');
        start(); refreshMine();
      };
      wrap.appendChild(b);
    });
    document.getElementById('setupStep2').classList.remove('hidden');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- 本体 ---------------- */
  function start() {
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('meId').textContent = state.me.id;
    document.getElementById('setMe').textContent = state.me.name + ' ／ ' + state.me.grade + '年' + state.me.cls + '組';
    document.getElementById('appVer').textContent = 'RowLog v' + CFG.VERSION;
    buildRpe();
    openDate(todayStr());
    buildCalendar();
  }

  /* サーバーの既定は「今日の前後45日」。収集期間は9/1〜10月下旬の約61日あるので、
     10月17日を過ぎると9月上旬が窓から外れる。そのまま state.mine を置き換えると
     端末に残っていた9月分まで消え、カレンダーで提出済みの日が赤（未提出）に変わる。
     部員はそれを見て出し直し、同じ日に2行できる。範囲を明示し、混ぜて持つ。 */
  function refreshMine() {
    var from = CFG.COLLECT_FROM || '2026-01-01';
    var to = addDaysStr(todayStr(), 60);
    return api('mine', { research_id: state.me.id, from: from, to: to }).then(function (r) {
      if (r && r.ok) {
        var merged = { answers: {}, plans: {} };
        var old = state.mine || { answers: {}, plans: {} };
        // 先に手元の分、次にサーバーの分。サーバーを正とする
        Object.keys(old.answers || {}).forEach(function (k) { merged.answers[k] = old.answers[k]; });
        Object.keys(old.plans || {}).forEach(function (k) { merged.plans[k] = old.plans[k]; });
        Object.keys(r.answers || {}).forEach(function (k) { merged.answers[k] = r.answers[k]; });
        Object.keys(r.plans || {}).forEach(function (k) { merged.plans[k] = r.plans[k]; });
        state.mine = merged;
        save(K.mine, state.mine);
        buildCalendar();
      }
    }).catch(function () {});
  }

  function addDaysStr(ymd, n) {
    var d = toDate(ymd);
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /* --- 日付を開く --- */
  function openDate(d) {
    state.date = d;
    state.planMode = d > todayStr();
    var p = planOf(d);

    document.getElementById('hdDate').textContent = fmt(d);
    document.getElementById('modeNote').textContent = state.planMode ? '予定を出す' : '';
    document.getElementById('modeNote').classList.toggle('hidden', !state.planMode);

    var kind = document.getElementById('planKind');
    kind.textContent = p.kind;
    kind.className = 'kind' + (p.kind === 'オフ' ? ' off' : p.kind === '大会' ? ' race' : '');
    /* 種別のチップに既に「練習」と出ているので、同じ語を並べない */
    document.getElementById('planTitle').textContent = p.title
      || (p.kind === 'オフ' ? '練習はありません'
        : p.kind === '大会' ? '大会'
        : '種目は決まっていません');
    document.getElementById('planMenus').textContent = p.block_ids.length
      ? '予定：' + p.block_ids.map(menuName).join(' ／ ') : '';

    // 既に出しているか
    var done = state.mine.answers[d];
    var already = document.getElementById('already');
    already.classList.toggle('hidden', !done || state.planMode);
    if (done) already.textContent = 'この日は「' + done.status + '」で提出済みです。出し直すと新しい行が増えます。';

    // フォームの初期値
    var planned = (state.mine.plans[d] && state.mine.plans[d].block_ids.length)
      ? state.mine.plans[d].block_ids : p.block_ids;
    state.form = {
      status: p.kind === 'オフ' ? '休養' : '実施',
      minutes: '', rpe: null, completion: '計画どおり',
      blocks: planned.slice(), didErg: false,
      erg: { distance: '', split: '', rate: '', drag: '', machine: '' },
      note: ''
    };
    document.getElementById('minutes').value = '';
    ['dist', 'split', 'rate', 'drag', 'machine'].forEach(function (id) {
      document.getElementById(id).value = '';
    });
    document.getElementById('note').value = state.planMode && state.mine.plans[d] ? state.mine.plans[d].note : '';
    applyDraft(d);          // 途中まで入れて離れた分を戻す
    clearErrors();
    paintDraftNote();
    paintNoteCount();
    paintAll();
    document.getElementById('planOnly').classList.toggle('hidden', !state.planMode);
    document.getElementById('actualOnly').classList.toggle('hidden', state.planMode);
    document.getElementById('submit').textContent = state.planMode ? '予定を出す' : '出す';
    showTab('today');
  }

  function menuName(id) {
    var m = (state.boot.menu || []).filter(function (x) { return String(x.id) === String(id); })[0];
    return m ? m.name : id;
  }

  /* --- 描画 --- */
  function paintAll() { paintSeg(); paintRpeSel(); paintBlocks(); paintErg(); }

  function paintSeg() {
    segSet('status', state.form.status);
    segSet('completion', state.form.completion);
    segSet('didErg', state.form.didErg ? 'はい' : 'いいえ');
    var load = L.asksLoad(state.form.status);
    document.getElementById('loadBlock').classList.toggle('hidden', !load || state.planMode);
  }
  function segSet(id, val) {
    var bs = document.querySelectorAll('#' + id + ' button');
    for (var i = 0; i < bs.length; i++) {
      bs[i].setAttribute('aria-pressed', String(bs[i].textContent.trim() === val));
    }
  }
  function buildRpe() {
    var w = document.getElementById('rpe');
    if (w.childElementCount) return;
    document.getElementById('rpeQuestion').textContent = L.RPE_QUESTION;
    for (var i = 0; i <= 10; i++) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = String(i); b.dataset.v = String(i);
      b.setAttribute('aria-pressed', 'false');
      w.appendChild(b);
    }
    w.addEventListener('click', function (e) {
      var t = e.target.closest('button'); if (!t) return;
      state.form.rpe = Number(t.dataset.v); paintRpeSel(); clearErrors(); saveDraft();
    });
  }
  function paintRpeSel() {
    var bs = document.querySelectorAll('#rpe button');
    for (var i = 0; i < bs.length; i++) {
      bs[i].setAttribute('aria-pressed', String(state.form.rpe !== null && Number(bs[i].dataset.v) === state.form.rpe));
    }
    document.getElementById('rpeLabel').textContent =
      state.form.rpe === null ? 'まだ選んでいません' : state.form.rpe + '　' + L.RPE_LABELS[state.form.rpe];
  }
  function paintBlocks() {
    var w = document.getElementById('blocks');
    w.innerHTML = '';
    state.form.blocks.forEach(function (id) {
      var t = document.createElement('span');
      t.className = 'tag';
      t.innerHTML = esc(menuName(id)) + '<span class="x">×</span>';
      t.onclick = function () {
        state.form.blocks = state.form.blocks.filter(function (x) { return x !== id; });
        paintBlocks();
      };
      w.appendChild(t);
    });
  }
  function paintErg() {
    document.getElementById('ergBlock').classList.toggle('hidden', !state.form.didErg);
    recheckErg();
  }
  /* 距離と split の突き合わせはしない。エルゴ1本の時間を聞いていないので、
     練習時間全体で割ると必ずずれる（実際にそれで誤警告が出た）。
     ここでは打ち間違いを捕まえるレンジ検査と、逆算した所要時間の表示だけをする。 */
  function recheckErg() {
    var out = document.getElementById('ergCheck');
    var rec = {
      distance: document.getElementById('dist').value,
      split: document.getElementById('split').value,
      rate: document.getElementById('rate').value,
      drag: document.getElementById('drag').value
    };
    var w = L.ergWarnings(rec);
    if (w.length) {
      out.textContent = w.join(' / ');
      out.style.color = 'var(--warn)';
      return;
    }
    var sec = L.impliedSeconds(rec.distance, rec.split);
    if (sec === null) { out.textContent = ''; return; }
    var t = Math.round(sec);                 // 先に秒を丸める。後だと 19分60秒 になる
    var m = Math.floor(t / 60), s2 = t - m * 60;
    out.textContent = 'この距離とペースなら ' + m + '分' + (s2 < 10 ? '0' : '') + s2 + '秒 くらいの1本です';
    out.style.color = 'var(--sub)';
  }

  /* --- メニュー選択 --- */
  function openPicker() {
    if (!state.boot || !(state.boot.menu || []).length) {
      toast('メニューをまだ読み込めていません。電波のあるところで開いてください');
      return;
    }
    var sheet = document.getElementById('picker');
    var body = document.getElementById('pickerBody');
    body.innerHTML = '';
    var cats = {};
    (state.boot.menu || []).forEach(function (m) { (cats[m.category] = cats[m.category] || []).push(m); });
    Object.keys(cats).forEach(function (c) {
      var h = document.createElement('p'); h.className = 'lbl'; h.textContent = c; body.appendChild(h);
      var wrap = document.createElement('div'); wrap.className = 'tags';
      cats[c].forEach(function (m) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'tag pick';
        b.textContent = m.name + (m.duration ? '（' + m.duration + '分）' : '');
        b.setAttribute('aria-pressed', String(state.form.blocks.indexOf(String(m.id)) >= 0));
        b.onclick = function () {
          var id = String(m.id);
          var i = state.form.blocks.indexOf(id);
          if (i >= 0) state.form.blocks.splice(i, 1); else state.form.blocks.push(id);
          b.setAttribute('aria-pressed', String(i < 0));
          paintBlocks();
        };
        wrap.appendChild(b);
      });
      body.appendChild(wrap);
    });
    sheet.classList.remove('hidden');
  }

  /* --- カレンダー --- */
  function buildCalendar() {
    if (!state.boot) return;
    var y = state.calYm.y, m = state.calYm.m;
    document.getElementById('calMonth').textContent = y + '年' + m + '月';
    var grid = document.getElementById('cal');
    grid.innerHTML = '';
    ['日', '月', '火', '水', '木', '金', '土'].forEach(function (w, i) {
      var e = document.createElement('div');
      e.className = 'wd' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '');
      e.textContent = w; grid.appendChild(e);
    });
    var first = new Date(y, m - 1, 1);
    for (var b = 0; b < first.getDay(); b++) {
      var bl = document.createElement('div'); bl.className = 'day blank'; grid.appendChild(bl);
    }
    var last = new Date(y, m, 0).getDate();
    var t = todayStr();
    var stat = { practice: 0, done: 0, miss: 0 };
    for (var d = 1; d <= last; d++) {
      var ds = y + '-' + pad(m) + '-' + pad(d);
      var p = planOf(ds);
      var ans = state.mine.answers[ds];
      var el = document.createElement('button');
      el.type = 'button';
      el.className = 'day' + (p.kind === 'オフ' ? ' off' : '') + (p.kind === '大会' ? ' race' : '') + (ds === t ? ' today' : '');
      var mark = '', cls = '';
      var inRange = ds >= (CFG.COLLECT_FROM || '0000-01-01');
      if (ans) { mark = '●'; cls = 'done'; }
      else if (p.kind === 'オフ') { mark = '−'; cls = 'rest'; }
      else if (ds < t && inRange) { mark = '●'; cls = 'miss'; }
      else if (state.mine.plans[ds]) { mark = '◇'; cls = 'rest'; }
      // 収集開始日より前は数えない（アプリが無かった日を未提出にしないため）
      var counted = p.kind !== 'オフ' && ds <= t && ds >= (CFG.COLLECT_FROM || '0000-01-01');
      if (counted) {
        stat.practice++;
        if (ans) stat.done++; else stat.miss++;
      }
      el.innerHTML = '<span class="n">' + d + '</span><span class="mk ' + cls + '">' + mark + '</span>';
      (function (dd) { el.onclick = function () { openDate(dd); }; })(ds);
      grid.appendChild(el);
    }
    document.getElementById('stPractice').textContent = stat.practice;
    document.getElementById('stDone').textContent = stat.done;
    document.getElementById('stMiss').textContent = stat.miss;
  }

  /* --- みんな --- */
  function loadToday() {
    var box = document.getElementById('people');
    box.innerHTML = '<p class="hint">読み込み中…</p>';
    api('today', { date: todayStr() }).then(function (r) {
      if (!r || !r.ok) throw new Error('取得できません');
      state.todayStatus = r;
      document.getElementById('allDate').textContent = fmt(r.date) + 'の提出';
      document.getElementById('allDone').textContent = r.submitted;
      document.getElementById('allMiss').textContent = r.total - r.submitted;
      document.getElementById('allPct').textContent = r.total ? Math.round(r.submitted / r.total * 100) : 0;
      box.innerHTML = '';
      state.boot.roster.slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; }).forEach(function (p) {
        var ok = !!r.done[p.id];
        var e = document.createElement('div');
        e.className = 'p ' + (ok ? 'done' : 'miss');
        e.innerHTML = '<span>' + esc(p.name) + '</span><span class="s">' + (ok ? '●' : '—') + '</span>';
        box.appendChild(e);
      });
    }).catch(function () {
      box.innerHTML = '<p class="hint">つながりませんでした。電波のあるところで開いてください。</p>';
    });
  }

  /* --- タブ --- */
  function showTab(name) {
    ['today', 'cal', 'all', 'set'].forEach(function (k) {
      document.getElementById('pane-' + k).classList.toggle('hidden', k !== name);
    });
    var bs = document.querySelectorAll('#tabs button');
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-selected', String(bs[i].dataset.p === name));
    document.getElementById('submitWrap').classList.toggle('hidden', name !== 'today');
    if (name === 'all') loadToday();
    if (name === 'cal') buildCalendar();
    window.scrollTo(0, 0);
  }

  /* --- 送信 --- */
  function doSubmit() {
    /* 連打止め。ボタンはタブバーのすぐ上にあり、片手だと二度押ししやすい。
       client_id は毎回新しく振るので、押した回数だけ別の行が増えていた。 */
    if (sending) return;
    var f = state.form;
    var payload;

    if (state.planMode) {
      payload = {
        action: 'plan', research_id: state.me.id, date: state.date,
        block_ids: f.blocks, note: L.cutText(document.getElementById('note').value, 200),
        client_id: uuid(), app_version: CFG.VERSION
      };
    } else {
      var load = L.asksLoad(f.status);
      payload = {
        action: 'submit', research_id: state.me.id, date: state.date, status: f.status,
        minutes: load ? Number(document.getElementById('minutes').value) : '',
        rpe: load ? f.rpe : '',
        block_ids: f.blocks,
        completion: load ? f.completion : '',
        erg_distance: f.didErg ? document.getElementById('dist').value : '',
        erg_split: f.didErg ? document.getElementById('split').value : '',
        erg_rate: f.didErg ? document.getElementById('rate').value : '',
        erg_drag: f.didErg ? document.getElementById('drag').value : '',
        erg_machine: f.didErg ? document.getElementById('machine').value : '',
        note: L.cutText(document.getElementById('note').value, 200),
        entered_by: state.me.id,
        client_id: uuid(), app_version: CFG.VERSION
      };
      var errs = L.validate(payload);
      if (errs.length) { showErrors(errs); return; }
    }

    /* キューに入らなければ何も起きていない。以前はここを確認せず
       必ず成功トーストを出していたので、保存できない端末では
       「出したつもり」のまま記録が存在しない状態になっていた。 */
    if (!enqueue(payload)) {
      alert('この端末に保存できないため、出せませんでした。\n\n'
          + 'Safari の 設定 →「サイト越えトラッキングを防ぐ」や\n'
          + '「すべてのCookieをブロック」がオンだと保存できません。\n'
          + 'オフにしてから、もう一度出してください。\n\n'
          + '入力した内容はこの画面に残してあります。');
      return;
    }

    lockSubmit();
    // 送信の成否を待たせない。キューに入れた時点で完了扱いにする。
    if (state.planMode) {
      state.mine.plans[state.date] = { block_ids: payload.block_ids, note: payload.note };
    } else {
      state.mine.answers[state.date] = { status: payload.status, srpe: L.srpe(payload.minutes, payload.rpe) };
    }
    save(K.mine, state.mine);
    clearDraft(state.date);
    buildCalendar();

    /* オフラインのときに成功と同じ文言を出すと、艇庫で送れていないことに
       気づけない。溜まっただけなのか送れたのかを分けて伝える。 */
    var offline = (navigator.onLine === false);
    if (offline) {
      toast('電波が無いので送信待ちに入れました。つながると自動で送られます');
    } else {
      toast(state.planMode ? '予定を出しました' : '出しました。おつかれさま');
    }
    flush().then(function () {
      if (!offline && queue().length) {
        toast('まだ送れていません。送信待ちに入れました');
      }
    });
  }

  /* 押した直後の数秒だけ止める。出し直し自体は仕様なので禁止しない。 */
  function lockSubmit() {
    sending = true;
    var b = document.getElementById('submit');
    if (b) b.disabled = true;
    setTimeout(function () {
      sending = false;
      if (b) b.disabled = false;
    }, 2500);
  }

  /* どの欄が悪いのかを画面で示す。alert だけだと直す場所が分からない。 */
  function showErrors(errs) {
    var box = document.getElementById('formErr');
    if (box) {
      box.innerHTML = '<b>出せません</b><ul><li>' + errs.map(esc).join('</li><li>') + '</li></ul>';
      box.classList.remove('hidden');
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    var bad = {
      minutes: /練習時間/.test(errs.join('')),
      rpe: /RPE/.test(errs.join(''))
    };
    var mi = document.getElementById('minutes');
    if (mi) mi.classList.toggle('bad', bad.minutes);
    var rp = document.getElementById('rpe');
    if (rp) rp.classList.toggle('bad', bad.rpe);
  }
  function clearErrors() {
    var box = document.getElementById('formErr');
    if (box) box.classList.add('hidden');
    var mi = document.getElementById('minutes');
    if (mi) mi.classList.remove('bad');
    var rp = document.getElementById('rpe');
    if (rp) rp.classList.remove('bad');
  }

  /* 200字で無言に切られていたので、残り字数を見せて切る前に気づけるようにする */
  function paintNoteCount() {
    var t = document.getElementById('note');
    var c = document.getElementById('noteCount');
    if (!t || !c) return;
    var n = t.value.length;
    c.textContent = n + ' / 200';
    c.classList.toggle('over', n > 200);
  }

  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    setTimeout(function () { t.classList.add('hidden'); }, 2200);
  }

  /* ---------------- イベント ---------------- */
  function wire() {
    document.getElementById('tabs').addEventListener('click', function (e) {
      var t = e.target.closest('button'); if (t) showTab(t.dataset.p);
    });
    ['status', 'completion', 'didErg'].forEach(function (id) {
      document.getElementById(id).addEventListener('click', function (e) {
        var t = e.target.closest('button'); if (!t) return;
        var v = t.textContent.trim();
        if (id === 'status') state.form.status = v;
        if (id === 'completion') state.form.completion = v;
        if (id === 'didErg') state.form.didErg = (v === 'はい');
        clearErrors();
        paintAll();
        saveDraft();
      });
    });
    document.getElementById('addBlock').onclick = openPicker;
    document.getElementById('pickerClose').onclick = function () {
      document.getElementById('picker').classList.add('hidden');
    };
    document.getElementById('submit').onclick = doSubmit;
    document.getElementById('changeMe').onclick = function () {
      localStorage.removeItem(K.me);
      state.me = null;
      document.getElementById('app').classList.add('hidden');
      showSetup();
    };
    document.getElementById('prevMonth').onclick = function () { shiftMonth(-1); };
    document.getElementById('nextMonth').onclick = function () { shiftMonth(1); };
    document.getElementById('goToday').onclick = function () { openDate(todayStr()); };
    ['dist', 'split', 'rate', 'drag'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', recheckErg);
    });
    // 入力のたびに下書きを残す
    ['minutes', 'note', 'dist', 'split', 'rate', 'drag', 'machine'].forEach(function (id) {
      var e = document.getElementById(id);
      if (e) e.addEventListener('input', function () {
        if (id === 'note') paintNoteCount();
        if (id === 'minutes') clearErrors();
        saveDraft();
      });
    });
    document.getElementById('discardDraft').onclick = function () {
      clearDraft(state.date);
      openDate(state.date);
    };
    /* ホーム画面から開いたPWAにはアドレスバーも更新ボタンも無い。
       画面が壊れたときに部員が自力で直せる逃げ道を用意する。 */
    document.getElementById('reloadApp').onclick = function () {
      if (queue().length && !confirm('送信待ちが ' + queue().length
          + ' 件あります。読み込み直しても消えませんが、先に「今すぐ送る」を試しますか？\n\n'
          + 'OK を押すと読み込み直します。')) return;
      location.reload();
    };
    document.getElementById('flushNow').onclick = function () {
      var n = queue().length;
      if (!n) { toast('送信待ちはありません'); return; }
      toast('送っています…');
      flush().then(function () {
        var left = queue().length;
        toast(left ? ('まだ ' + left + ' 件残っています') : 'ぜんぶ送れました');
      });
    };
    // 画面を離れるときにも念のため残す
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') saveDraft();
    });
    window.addEventListener('pagehide', saveDraft);
  }
  function shiftMonth(n) {
    var m = state.calYm.m + n, y = state.calYm.y;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    state.calYm = { y: y, m: m };
    buildCalendar();
  }

  /* 電波の無い艇庫でもアプリが開けるようにする。
     network-first なので、通信できるときは必ず新しいコードを取りに行く。 */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) {
        console.warn('Service Worker を登録できません', e);
      });
    });
  }

  wire();
  boot();
  window.RowLogApp = { state: state, flush: flush, openDate: openDate, showTab: showTab };
})();
