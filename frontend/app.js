/* RowLog 本体。DOM と通信はここ。純粋なルールは logic.js に置く。 */
(function () {
  'use strict';

  var L = window.RowLogLogic;
  var CFG = window.ROWLOG_CONFIG;
  var K = { me: 'rowlog.me', boot: 'rowlog.boot', queue: 'rowlog.queue', mine: 'rowlog.mine' };

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
  function save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  function uuid() {
    return 'x-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* ---------------- 通信 ---------------- */
  function api(action, params) {
    var url = CFG.API_URL + (CFG.API_URL.indexOf('?') < 0 ? '?' : '&') + 'action=' + encodeURIComponent(action);
    for (var k in (params || {})) {
      if (params[k] !== null && params[k] !== undefined) {
        url += '&' + k + '=' + encodeURIComponent(params[k]);
      }
    }
    return fetch(url, { method: 'GET' }).then(function (r) { return r.json(); });
  }

  /* Apps Script はレスポンスヘッダを付けられない。
     text/plain で送ってプリフライト(OPTIONS)自体を起こさないのが定石。 */
  function post(payload) {
    return fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }

  /* ---------------- 送信キュー（オフライン対応） ---------------- */
  function queue() { return load(K.queue, []); }
  function enqueue(payload) {
    var q = queue();
    q.push(payload);
    save(K.queue, q);
    paintQueue();
  }
  function flush() {
    var q = queue();
    if (!q.length || !CFG.API_URL) return Promise.resolve(0);
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
        // 検証で弾かれた分は再送しても通らないので捨てる（無限リトライを防ぐ）
        if (res && res.ok === false) {
          var r2 = queue();
          var bad = r2.shift();
          save(K.queue, r2);
          console.warn('送信できないため破棄:', res.error, bad);
          paintQueue();
          return step();
        }
        return sent;
      }).catch(function () { return sent; });
    }
    return step();
  }
  function paintQueue() {
    var n = queue().length;
    var e = document.getElementById('queueCount');
    if (e) e.textContent = n + ' 件';
    var b = document.getElementById('queueBadge');
    if (b) b.classList.toggle('hidden', n === 0);
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

  /* ---------------- 起動 ---------------- */
  function boot() {
    state.boot = load(K.boot, null);
    state.me = load(K.me, null);
    state.mine = load(K.mine, { answers: {}, plans: {} });
    state.date = todayStr();
    state.calYm = { y: toDate(state.date).getFullYear(), m: toDate(state.date).getMonth() + 1 };

    paintQueue();
    if (!CFG.API_URL) {
      showError('繋ぎ先が設定されていません。frontend/config.js の API_URL に Apps Script の URL を入れてください。');
      return;
    }

    if (state.boot && state.me) { start(); }
    else { document.getElementById('loading').classList.remove('hidden'); }

    api('bootstrap').then(function (r) {
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : '読み込みに失敗');
      state.boot = r;
      save(K.boot, r);
      document.getElementById('loading').classList.add('hidden');
      if (!state.me) { showSetup(); } else { start(); }
      return flush();
    }).then(function () {
      if (state.me) refreshMine();
    }).catch(function (e) {
      document.getElementById('loading').classList.add('hidden');
      if (state.boot && state.me) { start(); }   // 圏外でもキャッシュで動かす
      else showError('つながりませんでした。電波のあるところでもう一度開いてください。' );
      console.warn(e);
    });

    window.addEventListener('online', function () { flush(); });
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

  function refreshMine() {
    return api('mine', { research_id: state.me.id }).then(function (r) {
      if (r && r.ok) {
        state.mine = { answers: r.answers || {}, plans: r.plans || {} };
        save(K.mine, state.mine);
        buildCalendar();
      }
    }).catch(function () {});
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
    document.getElementById('planTitle').textContent = p.title || (p.kind === 'オフ' ? '練習はありません' : '練習');
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
      state.form.rpe = Number(t.dataset.v); paintRpeSel();
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
    var f = state.form;
    var payload;

    if (state.planMode) {
      payload = {
        action: 'plan', research_id: state.me.id, date: state.date,
        block_ids: f.blocks, note: document.getElementById('note').value.slice(0, 200),
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
        note: document.getElementById('note').value.slice(0, 200),
        entered_by: state.me.id,
        client_id: uuid(), app_version: CFG.VERSION
      };
      var errs = L.validate(payload);
      if (errs.length) { alert('出せません：\n・' + errs.join('\n・')); return; }
    }

    enqueue(payload);
    // 送信の成否を待たせない。キューに入れた時点で完了扱いにする。
    if (state.planMode) {
      state.mine.plans[state.date] = { block_ids: payload.block_ids, note: payload.note };
    } else {
      state.mine.answers[state.date] = { status: payload.status, srpe: L.srpe(payload.minutes, payload.rpe) };
    }
    save(K.mine, state.mine);
    buildCalendar();
    toast(state.planMode ? '予定を出しました' : '出しました。おつかれさま');
    flush();
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
        paintAll();
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
  }
  function shiftMonth(n) {
    var m = state.calYm.m + n, y = state.calYm.y;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    state.calYm = { y: y, m: m };
    buildCalendar();
  }

  wire();
  boot();
  window.RowLogApp = { state: state, flush: flush, openDate: openDate, showTab: showTab };
})();
