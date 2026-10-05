/* ============================================================
   app.js —— 多人版前端
   注册（一次）/ 令牌自动登录 / 实时上报 / 观战 / 好友 / 排行
   ============================================================ */
(function () {
  'use strict';

  var S = window.Snake;

  var TOKEN_KEY = 'snake.token.v2';
  var SPEED_KEY = 'snake.speed.v2';
  var PAD_KEY = 'snake.pad.v2';        // 'auto' | 'on' | 'off'
  var SWIPE_MIN = 14;
  var GAP = 10;
  var HEARTBEAT_MS = 2000;             // 没人看时的低频上报间隔

  var IS_TOUCH = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;

  function $(id) { return document.getElementById(id); }
  function el(sel) { return document.querySelector(sel); }

  function storeGet(k, d) {
    try { var v = window.localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; }
  }
  function storeSet(k, v) {
    try { window.localStorage.setItem(k, v); } catch (e) { /* 忽略 */ }
  }
  function storeDel(k) {
    try { window.localStorage.removeItem(k); } catch (e) { /* 忽略 */ }
  }

  /* ============================================================
     状态
     ============================================================ */
  var token = storeGet(TOKEN_KEY, '');
  var me = null;                                  // {id,name,code}
  var myStats = { best: 0, games: 0, total: 0, avg: 0 };
  var currentView = 'register';
  var speedIdx = 1;
  var padMode = storeGet(PAD_KEY, 'auto');        // auto | on | off
  var showDpad = false;
  var boardSize = 300;
  var watchSize = 300;
  var lastBodyH = 0;

  var engine = S.createEngine({ cols: 20, rows: 20, wrap: false });
  var canvas = $('gameCanvas');
  var ctx = canvas.getContext('2d');
  var boardEl = $('board');
  var wCanvas = $('watchCanvas');
  var wCtx = wCanvas.getContext('2d');
  var wBoardEl = $('watchBoard');

  var live = { watchers: 0, inflight: false, pending: false, lastAt: 0 };

  var watch = { code: null, es: null, live: null, user: null, followed: false, online: false };

  /* ============================================================
     网络
     ============================================================ */
  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(path, {
      method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var e = new Error((data && data.error) || ('HTTP ' + res.status));
          e.status = res.status;
          throw e;
        }
        return data || {};
      });
    });
  }

  /* ============================================================
     画布 / 布局
     ============================================================ */
  function setupCanvas(cv, cx, size) {
    var dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    cv.width = Math.round(size * dpr);
    cv.height = Math.round(size * dpr);
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function defaultPad(vw, vh) {
    if (!IS_TOUCH) return false;
    return vw > vh ? true : vh >= 620;
  }

  function layout() {
    var vv = window.visualViewport;
    var vw = Math.round(vv && vv.width ? vv.width : window.innerWidth);
    var vh = Math.round(vv && vv.height ? vv.height : window.innerHeight);
    // 只在真的变了才写，避免和 iOS 地址栏收起互相触发
    if (Math.abs(vh - lastBodyH) > 1) {
      lastBodyH = vh;
      document.body.style.height = vh + 'px';
    }

    var want = padMode === 'on' ? true : (padMode === 'off' ? false : defaultPad(vw, vh));
    if (want !== showDpad) showDpad = want;
    document.body.classList.toggle('pad-off', !showDpad);

    var appEl = $('app');
    var appW = appEl.clientWidth;
    var appH = appEl.clientHeight;

    var landscape = currentView === 'play' && vw > vh && vw >= 640;
    document.body.classList.toggle('landscape', landscape);

    var dpad = $('dpad');
    if (showDpad) {
      var cell = landscape
        ? Math.max(44, Math.min(64, Math.floor(appW * 0.055)))
        : Math.max(42, Math.min(62, Math.floor(Math.min(appW * 0.17, appH * 0.16))));
      dpad.style.setProperty('--cell', cell + 'px');
    }

    if (currentView === 'play') {
      var barH = el('#view-play .bar').offsetHeight;
      var sideH = el('#view-play .play-side').offsetHeight;
      if (landscape) {
        boardSize = Math.min(appH - barH - GAP, appW - 200 - GAP);
      } else {
        // 屏幕实在太小、放了方向盘棋盘就没了：这一帧临时收起方向盘
        if (showDpad && appH - barH - sideH - GAP * 2 < 150) {
          document.body.classList.add('pad-off');
          sideH = el('#view-play .play-side').offsetHeight;
        }
        boardSize = Math.min(appW, appH - barH - sideH - GAP * 2);
      }
      boardSize = Math.max(140, Math.floor(boardSize));
      boardEl.style.width = boardSize + 'px';
      boardEl.style.height = boardSize + 'px';
      setupCanvas(canvas, ctx, boardSize);
    } else if (currentView === 'watch') {
      var wbarH = el('#view-watch .bar').offsetHeight;
      var reserve = Math.min(190, Math.max(110, appH * 0.4));   // 留给下面战绩区
      watchSize = Math.max(140, Math.floor(Math.min(appW, appH - wbarH - GAP - reserve)));
      wBoardEl.style.width = watchSize + 'px';
      wBoardEl.style.height = watchSize + 'px';
      setupCanvas(wCanvas, wCtx, watchSize);
    }
  }

  var layoutPending = false;
  function requestLayout() {
    if (layoutPending) return;
    layoutPending = true;
    window.requestAnimationFrame(function () {
      layoutPending = false;
      layout();
      drawPlay(performance.now());
      drawWatch(performance.now());
    });
  }

  /* ============================================================
     视图切换
     ============================================================ */
  function showView(name) {
    currentView = name;
    ['register', 'play', 'me', 'rank', 'watch'].forEach(function (v) {
      var node = $('view-' + v);
      if (node) node.classList.toggle('active', v === name);
    });

    var noTabs = (name === 'register' || name === 'watch');
    $('tabbar').classList.toggle('hidden', noTabs);

    var btns = $('tabbar').querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-tab') === name);
    }

    if (name !== 'watch') closeStream();
    if (name !== 'play' && engine.phase === 'running') {
      engine.pause();
      updateToggleBtn();
      maybePush(true);
    }

    if (name === 'rank') refreshRank();
    if (name === 'me') refreshMe();
    requestLayout();
    window.scrollTo(0, 0);
  }

  /* ============================================================
     账号
     ============================================================ */
  function setMsg(node, text, kind) {
    node.textContent = text || '';
    node.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function applyUser(user, stats) {
    me = user;
    if (stats) myStats = stats;
    $('playName').textContent = me.name;
    $('playCode').textContent = me.code;
    $('meCode').textContent = me.code;
    $('meToken').textContent = token;
    renderPlayStats();
  }

  function logout(message) {
    token = '';
    storeDel(TOKEN_KEY);
    me = null;
    closeStream();
    showView('register');
    if (message) setMsg($('regMsg'), message, 'err');
  }

  function bootstrap(attempt) {
    attempt = attempt || 0;
    if (!token) { showView('register'); return; }
    api('/api/me').then(function (d) {
      applyUser(d.user, d.stats);
      $('meToken').textContent = d.token || token;
      renderHistory($('meHistory'), d.history);
      renderFollowers(d.followers);
      renderRank(d.friends);
      showView('play');
      maybePush(true);              // 立刻上报一次，让朋友那边看到「在线」
    }).catch(function (e) {
      if (e.status === 401) {
        logout('这台设备上的旧令牌已失效，请重新注册。');
        return;
      }
      // 服务器还没起来 / 网络抖动：先重试，别急着把用户丢回注册页，
      // 否则他会重复注册出一个新账号。
      if (attempt < 3) {
        showView('register');
        setMsg($('regMsg'), '连不上服务器，正在重试…（' + (attempt + 1) + '/3）', 'err');
        window.setTimeout(function () { bootstrap(attempt + 1); }, 1500);
        return;
      }
      showView('register');
      setMsg($('regMsg'), '连不上服务器：' + e.message + '。请确认服务器窗口还开着，然后刷新页面。', 'err');
    });
  }

  function refreshMe() {
    if (!me) return;
    api('/api/me').then(function (d) {
      myStats = d.stats;
      renderPlayStats();
      $('meBest').textContent = d.stats.best;
      $('meGames').textContent = d.stats.games;
      $('meAvg').textContent = d.stats.avg;
      $('meTotal').textContent = d.stats.total;
      $('meToken').textContent = d.token || token;
      renderHistory($('meHistory'), d.history);
      renderFollowers(d.followers);
      renderRank(d.friends);
    }).catch(function (e) {
      if (e.status === 401) logout('令牌已失效，请重新注册。');
    });
  }

  function refreshRank() {
    if (!me) return;
    api('/api/leaderboard').then(function (d) {
      renderLeaderboard(d.rows);
      var friends = d.rows.filter(function (r) { return !r.me; });
      renderRank(friends);
    }).catch(function () { /* 忽略瞬时错误 */ });
  }

  /* ============================================================
     渲染：列表
     ============================================================ */
  function fmtTime(ts) {
    if (!ts) return '—';
    var d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    var dt = new Date(ts);
    return (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
  }
  function fmtDur(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s + ' 秒';
    return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  }

  function histRow(rec) {
    var div = document.createElement('div');
    div.className = 'hist-row';
    var a = document.createElement('span');
    a.className = 's';
    a.textContent = rec.score;
    var b = document.createElement('span');
    b.className = 'd';
    b.textContent = '长度 ' + rec.length + ' · ' + fmtDur(rec.duration) + (rec.speed ? ' · ' + rec.speed : '');
    var c = document.createElement('span');
    c.className = 't';
    c.textContent = fmtTime(rec.at);
    div.appendChild(a); div.appendChild(b); div.appendChild(c);
    return div;
  }

  function renderHistory(box, list) {
    box.textContent = '';
    if (!list || !list.length) {
      var e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '还没有战绩，去玩一局吧。';
      box.appendChild(e);
      return;
    }
    list.forEach(function (r) { box.appendChild(histRow(r)); });
  }

  function personItem(opt) {
    // opt: {rank, name, code, stats, online, me, mutual, actions:[{label,cls,onClick}]}
    var div = document.createElement('div');
    div.className = 'item' + (opt.me ? ' me' : '');

    if (opt.rank !== undefined) {
      var r = document.createElement('div');
      r.className = 'rank';
      r.textContent = opt.rank;
      div.appendChild(r);
    }

    var info = document.createElement('div');
    info.className = 'info';
    var n = document.createElement('div');
    n.className = 'n';
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = opt.name;
    n.appendChild(nm);
    if (opt.me) n.appendChild(chip('我', 'badge live'));
    if (opt.mutual) n.appendChild(chip('互相关注', 'badge'));
    if (opt.online) n.appendChild(chip('在线', 'badge live'));
    info.appendChild(n);

    var sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = '查看码 ' + opt.code + ' · ' + opt.stats.games + ' 局 · 平均 ' + opt.stats.avg + ' · ' + fmtTime(opt.stats.lastAt);
    info.appendChild(sub);
    div.appendChild(info);

    var sc = document.createElement('div');
    sc.className = 'score';
    var b = document.createElement('b');
    b.textContent = opt.stats.best;
    var sp = document.createElement('span');
    sp.textContent = '最高分';
    sc.appendChild(b); sc.appendChild(sp);
    div.appendChild(sc);

    if (opt.actions && opt.actions.length) {
      var acts = document.createElement('div');
      acts.className = 'acts';
      opt.actions.forEach(function (a) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'icon-btn';
        btn.textContent = a.label;
        btn.addEventListener('click', a.onClick);
        acts.appendChild(btn);
      });
      div.appendChild(acts);
    }
    return div;
  }

  function chip(text, cls) {
    var s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function renderRank(friends) {
    var box = $('friendList');
    box.textContent = '';
    if (!friends || !friends.length) {
      var e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '还没关注任何人。把上面的查看码输入框用起来吧。';
      box.appendChild(e);
      return;
    }
    friends.forEach(function (f) {
      box.appendChild(personItem({
        name: f.user.name,
        code: f.user.code,
        stats: f.stats,
        online: f.online,
        mutual: f.mutual,
        actions: [
          { label: '看', onClick: function () { openWatch(f.user.code); } },
          { label: '取关', onClick: function () { unfollow(f.user.code); } }
        ]
      }));
    });
  }

  function renderFollowers(list) {
    var box = $('meFollowers');
    box.textContent = '';
    if (!list || !list.length) {
      var e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '还没有人关注你。把查看码发出去试试。';
      box.appendChild(e);
      return;
    }
    list.forEach(function (f) {
      box.appendChild(personItem({
        name: f.user.name,
        code: f.user.code,
        stats: f.stats,
        online: f.online,
        actions: [{ label: '看', onClick: function () { openWatch(f.user.code); } }]
      }));
    });
  }

  function renderLeaderboard(rows) {
    var box = $('rankList');
    box.textContent = '';
    if (!rows || !rows.length) return;
    rows.forEach(function (r, i) {
      box.appendChild(personItem({
        rank: i + 1,
        name: r.user.name,
        code: r.user.code,
        stats: r.stats,
        online: r.online,
        me: r.me,
        mutual: r.mutual,
        actions: r.me ? [] : [
          { label: '看', onClick: function () { openWatch(r.user.code); } },
          { label: '取关', onClick: function () { unfollow(r.user.code); } }
        ]
      }));
    });
  }

  /* ============================================================
     渲染：游戏
     ============================================================ */
  function renderPlayStats() {
    $('playScore').textContent = engine.score;
    $('playBest').textContent = myStats.best || 0;
  }

  function updateToggleBtn() {
    $('btnToggle').textContent =
      engine.phase === 'running' ? '暂停' :
      engine.phase === 'paused' ? '继续' :
      engine.phase === 'ready' ? '开始' : '再来一局';
  }

  function renderWatchers() {
    var b = $('playWatchers');
    if (live.watchers > 0) {
      b.textContent = '👀 ' + live.watchers + ' 人在看';
      b.classList.remove('hidden');
      b.classList.add('live');
    } else {
      b.classList.add('hidden');
    }
  }

  function playOverlay() {
    if (engine.phase === 'ready') {
      return [
        { text: '贪吃蛇', size: 28, weight: 700, color: S.COLORS.text, gap: 16 },
        { text: IS_TOUCH ? '点棋盘或按方向开始' : '按 空格 或点击「开始」', size: 13, color: S.COLORS.dim }
      ];
    }
    if (engine.phase === 'paused') {
      return [
        { text: '已暂停', size: 26, weight: 700, color: S.COLORS.text, gap: 16 },
        { text: '轻点棋盘继续', size: 13, color: S.COLORS.dim }
      ];
    }
    if (engine.phase === 'over') {
      return [
        { text: '游戏结束', size: 26, weight: 700, color: S.COLORS.danger, gap: 16 },
        { text: '本局得分 ' + engine.score, size: 16, weight: 600, color: S.COLORS.text, gap: 8 },
        { text: '最高分 ' + (myStats.best || 0), size: 13, color: S.COLORS.dim, gap: 18 },
        { text: '点「再来一局」继续', size: 13, color: S.COLORS.dim }
      ];
    }
    if (engine.phase === 'win') {
      return [
        { text: '通关！', size: 26, weight: 700, color: S.COLORS.gold, gap: 16 },
        { text: '本局得分 ' + engine.score, size: 16, weight: 600, color: S.COLORS.text, gap: 8 },
        { text: '点「再来一局」继续', size: 13, color: S.COLORS.dim }
      ];
    }
    return null;
  }

  function drawPlay(now) {
    if (currentView !== 'play') return;
    var st = S.normalize({
      cols: engine.cols, rows: engine.rows,
      snake: engine.snake.map(function (c) { return [c.x, c.y]; }),
      food: engine.food ? [engine.food.x, engine.food.y] : null,
      dir: [engine.dir.x, engine.dir.y],
      score: engine.score, phase: engine.phase
    });
    S.drawBoard(ctx, boardSize, st, {
      overlay: playOverlay(),
      now: now,
      since: engine.startedAt
    });
  }

  /* ============================================================
     上报实时状态
     ============================================================ */
  function maybePush(force) {
    if (!me) return;
    var now = Date.now();
    // 有人看：最快每 40ms 推一次（游戏最快 45ms 一步，够跟上）
    // 没人看：每 2s 一次心跳，用来发现新观众
    var minGap = force ? 0 : (live.watchers > 0 ? 40 : HEARTBEAT_MS);
    if (!force && now - live.lastAt < minGap) return;
    if (live.inflight) { live.pending = true; return; }

    live.inflight = true;
    live.lastAt = now;
    var snap = engine.snapshot();
    api('/api/state', { body: { live: snap, ts: now } }).then(function (r) {
      live.inflight = false;
      var n = (r && typeof r.watchers === 'number') ? r.watchers : 0;
      if (n !== live.watchers) { live.watchers = n; renderWatchers(); }
      // 不在这里立刻补发：下一帧的常规调用会带上节流间隔，
      // 否则局域网 RTT 只有几毫秒，会退化成几百次请求/秒。
      live.pending = false;
    }).catch(function () {
      live.inflight = false;
      live.pending = false;
    });
  }

  function onGameOver() {
    var rec = {
      score: engine.score,
      length: engine.snake.length,
      duration: engine.activeMs,        // 只算真正在跑的时间，暂停不计
      speed: S.SPEED_LEVELS[speedIdx].label
    };
    maybePush(true);
    // 先乐观更新，别等服务器回包才显示新纪录
    if (engine.score > (myStats.best || 0)) myStats.best = engine.score;
    renderPlayStats();
    api('/api/games', { body: rec }).then(function (r) {
      if (r && r.stats) { myStats = r.stats; renderPlayStats(); }
      setTimeout(refreshMe, 300);
    }).catch(function () { /* 忽略 */ });
  }

  /* ============================================================
     主循环
     ============================================================ */
  function loop(ts) {
    if (currentView === 'play') {
      var res = engine.advance(ts, S.SPEED_LEVELS[speedIdx]);
      if (res === 'over' || res === 'win') {
        updateToggleBtn();
        onGameOver();
      } else if (res === 'ate') {
        $('playScore').textContent = engine.score;
      }
      // 每帧都问一次：内部按「有人看 40ms / 没人看 2s」自己节流
      maybePush(false);
      drawPlay(ts);
    } else if (currentView === 'watch') {
      drawWatch(ts);
    }
    window.requestAnimationFrame(loop);
  }

  /* ============================================================
     游戏操作
     ============================================================ */
  function primaryAction() {
    if (engine.phase === 'ready') { engine.start(); }
    else if (engine.phase === 'running') { engine.pause(); }
    else if (engine.phase === 'paused') { engine.resume(); }
    else { engine.reset(); engine.start(); }
    updateToggleBtn();
    renderPlayStats();
    maybePush(true);
  }

  var DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  function applyDir(name) {
    var d = DIRS[name];
    if (!d) return;
    if (engine.phase === 'ready') {
      engine.start();
      engine.queueDirection(d[0], d[1]);
      updateToggleBtn();
      maybePush(true);
      return;
    }
    if (engine.phase !== 'running') return;
    engine.queueDirection(d[0], d[1]);
  }

  /* --- 键盘 --- */
  var KEYMAP = {
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0]
  };

  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (currentView !== 'play') return;
    var raw = e.key;
    var key = raw.length === 1 ? raw.toLowerCase() : raw;

    if (Object.prototype.hasOwnProperty.call(KEYMAP, key)) {
      e.preventDefault();
      if (engine.phase === 'ready' || engine.phase === 'running') {
        var d = KEYMAP[key];
        engine.queueDirection(d[0], d[1]);
      }
      return;
    }
    if (key === ' ' || key === 'Spacebar' || key === 'Enter') { e.preventDefault(); primaryAction(); return; }
    if (key === 'r') { e.preventDefault(); engine.reset(); engine.start(); updateToggleBtn(); renderPlayStats(); maybePush(true); return; }
    if (key >= '1' && key <= '4') { e.preventDefault(); setSpeed(Number(key) - 1); }
  });

  /* --- 方向盘 --- */
  var padActive = null, lastPadTs = 0;
  function clearPadActive() {
    if (padActive) { padActive.classList.remove('active'); padActive = null; }
  }
  function padBtnFrom(t) {
    return t && t.closest ? t.closest('button[data-dir]') : null;
  }
  $('dpad').addEventListener('pointerdown', function (e) {
    var btn = padBtnFrom(e.target);
    if (!btn) return;
    e.preventDefault();
    clearPadActive();
    padActive = btn;
    btn.classList.add('active');
    lastPadTs = Date.now();
    applyDir(btn.getAttribute('data-dir'));
  });
  $('dpad').addEventListener('click', function (e) {
    var btn = padBtnFrom(e.target);
    if (!btn) return;
    e.preventDefault();
    if (Date.now() - lastPadTs < 700) return;
    applyDir(btn.getAttribute('data-dir'));
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
    $('dpad').addEventListener(t, clearPadActive);
  });
  $('dpad').addEventListener('contextmenu', function (e) { e.preventDefault(); });

  /* --- 棋盘滑动 / 轻点 --- */
  var touch = null;
  boardEl.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { touch = null; return; }
    touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, fired: false };
  }, { passive: false });

  boardEl.addEventListener('touchmove', function (e) {
    e.preventDefault();
    if (!touch || touch.fired || e.touches.length !== 1) return;
    var t = e.touches[0];
    var dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    var ax = Math.abs(dx), ay = Math.abs(dy);
    if (Math.max(ax, ay) < SWIPE_MIN) return;
    touch.fired = true;
    applyDir(ax > ay ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  }, { passive: false });

  boardEl.addEventListener('touchend', function () {
    if (!touch) return;
    var wasSwipe = touch.fired;
    touch = null;
    if (!wasSwipe) primaryAction();
  }, { passive: false });

  boardEl.addEventListener('touchcancel', function () { touch = null; }, { passive: true });

  /* --- 速度档位 --- */
  function setSpeed(i, silent) {
    speedIdx = Math.max(0, Math.min(S.SPEED_LEVELS.length - 1, i | 0));
    if (!silent) storeSet(SPEED_KEY, String(speedIdx));
    engine._acc = 0;
    var btns = $('seg').querySelectorAll('button');
    for (var k = 0; k < btns.length; k++) {
      var on = Number(btns[k].getAttribute('data-i')) === speedIdx;
      btns[k].classList.toggle('on', on);
      btns[k].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  /* ============================================================
     好友
     ============================================================ */
  function addFriend(code) {
    code = String(code || '').trim().toUpperCase();
    if (code.length !== 6) { setMsg($('rankMsg'), '查看码是 6 位。', 'err'); return; }
    api('/api/friends', { body: { code: code } }).then(function (d) {
      setMsg($('rankMsg'), '已关注 ' + d.friend.user.name, 'ok');
      $('addCode').value = '';
      refreshRank();
      setTimeout(refreshMe, 200);
    }).catch(function (e) {
      setMsg($('rankMsg'), e.message || '关注失败', 'err');
    });
  }

  function unfollow(code) {
    api('/api/friends/' + code, { method: 'DELETE' }).then(function () {
      refreshRank();
      setTimeout(refreshMe, 200);
    }).catch(function () { /* 忽略 */ });
  }

  /* ============================================================
     观战
     ============================================================ */
  function setDot(kind, text) {
    var dot = $('watchDot');
    dot.classList.remove('on', 'off');
    if (kind) dot.classList.add(kind);
    $('watchDotText').textContent = text;
  }

  function renderWatchStats(stats, curScore) {
    $('watchBest').textContent = stats.best;
    $('watchGames').textContent = stats.games;
    $('watchAvg').textContent = stats.avg;
    $('watchScore').textContent = curScore || 0;
  }

  function renderFollowBtn() {
    var b = $('watchFollow');
    if (!watch.user) { b.classList.add('hidden'); return; }
    if (watch.user.code === (me && me.code)) { b.classList.add('hidden'); return; }
    b.classList.remove('hidden');
    b.textContent = watch.followed ? '已关注 ✓（点一下取关）' : '加为好友';
  }

  function watchOverlay() {
    if (!watch.live) {
      return [
        { text: '还没有画面', size: 22, weight: 700, color: S.COLORS.text, gap: 12 },
        { text: watch.online ? '他还没开始这一局' : '他现在不在线', size: 13, color: S.COLORS.dim }
      ];
    }
    var p = watch.live.phase;
    if (p === 'running') return null;
    if (p === 'paused') return [{ text: '他暂停了', size: 22, weight: 700, color: S.COLORS.text }];
    if (p === 'over') return [{ text: '这一局结束了', size: 22, weight: 700, color: S.COLORS.danger }];
    if (p === 'win') return [{ text: '通关了！', size: 22, weight: 700, color: S.COLORS.gold }];
    return [{ text: '准备中…', size: 20, weight: 700, color: S.COLORS.text }];
  }

  function drawWatch(now) {
    if (currentView !== 'watch') return;
    var st = S.normalize(watch.live || { cols: 20, rows: 20, snake: [], food: null, dir: [1, 0], phase: 'ready' });
    S.drawBoard(wCtx, watchSize, st, { overlay: watchOverlay(), now: now, since: 0 });
  }

  function openStream(code) {
    // 已经离开观战页（或在看别人）就别开流了，否则没人负责关闭它
    if (currentView !== 'watch' || watch.code !== code) return;
    if (watch.es) { try { watch.es.close(); } catch (e) { /* 忽略 */ } }
    if (!window.EventSource) { setDot('off', '浏览器不支持实时推送'); return; }

    var es = new EventSource('/api/watch/' + code + '/stream');
    watch.es = es;
    setDot('', '连接中');

    es.addEventListener('open', function () { setDot('on', '已连接'); });

    es.addEventListener('hello', function (ev) {
      var d = JSON.parse(ev.data);
      watch.online = !!d.online;
      watch.live = d.live || null;
      setDot(d.online ? 'on' : 'off', d.online ? '正在实时观看' : '他现在不在线');
      renderWatchStats(d.stats, watch.live ? watch.live.score : 0);
    });

    es.addEventListener('live', function (ev) {
      var d = JSON.parse(ev.data);
      watch.live = d.live || null;
      watch.online = true;
      setDot('on', '正在实时观看');
      $('watchScore').textContent = watch.live ? watch.live.score : 0;
    });

    es.addEventListener('game', function (ev) {
      var d = JSON.parse(ev.data);
      renderWatchStats(d.stats, 0);
      var box = $('watchHistory');
      if (box.querySelector('.empty')) box.textContent = '';
      box.insertBefore(histRow(d.record), box.firstChild);
    });

    es.addEventListener('error', function () {
      setDot('off', '断开，正在重连…');
    });
  }

  function closeStream() {
    if (watch.es) {
      try { watch.es.close(); } catch (e) { /* 忽略 */ }
      watch.es = null;
    }
  }

  function openWatch(code) {
    code = String(code || '').toUpperCase();
    closeStream();
    watch.code = code;
    watch.live = null;
    watch.user = null;
    watch.followed = false;

    $('watchName').textContent = '载入中…';
    $('watchCode').textContent = code;
    $('watchHistory').textContent = '';
    $('watchFollow').classList.add('hidden');
    setMsg($('watchMsg'), '');
    setDot('', '连接中');

    showView('watch');

    api('/api/users/' + code).then(function (d) {
      // 迟到的响应绝不能覆盖当前正在看的人：快速连续点两个好友时，
      // 先发的请求可能后到，那会把 B 的名字/战绩画到 A 的棋盘旁边。
      if (watch.code !== code || currentView !== 'watch') return;
      watch.user = d.user;
      watch.followed = d.followed;
      watch.online = d.online;
      $('watchName').textContent = d.user.name;
      renderWatchStats(d.stats, 0);
      renderHistory($('watchHistory'), d.history);
      renderFollowBtn();
      // 确认查看码有效之后再连实时流，否则无效的码会让 EventSource 无限重连
      openStream(code);
    }).catch(function (e) {
      if (watch.code !== code) return;
      $('watchName').textContent = '打不开';
      setDot('off', '无此查看码');
      setMsg($('watchMsg'), e.message || '找不到这个查看码', 'err');
    });
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  // 注册
  $('regBtn').addEventListener('click', function (e) {
    var name = $('regName').value.trim();
    if (!name) { setMsg($('regMsg'), '先起个昵称吧。', 'err'); return; }
    e.currentTarget.disabled = true;
    api('/api/register', { body: { name: name } }).then(function (d) {
      token = d.token;
      storeSet(TOKEN_KEY, token);
      applyUser(d.user, { best: 0, games: 0, total: 0, avg: 0 });
      setMsg($('regMsg'), '');
      engine.reset();
      updateToggleBtn();
      renderPlayStats();
      showView('play');
      maybePush(true);
    }).catch(function (err) {
      setMsg($('regMsg'), err.message || '注册失败', 'err');
    }).then(function () {
      $('regBtn').disabled = false;
    });
  });
  $('regName').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('regBtn').click();
  });

  // 用令牌登录
  $('tokenLoginBtn').addEventListener('click', function () {
    var t = $('regToken').value.trim();
    if (!t) { setMsg($('regMsg'), '先粘贴令牌。', 'err'); return; }
    api('/api/login', { body: { token: t } }).then(function () {
      token = t;
      storeSet(TOKEN_KEY, token);
      setMsg($('regMsg'), '');
      bootstrap();
    }).catch(function (e) {
      setMsg($('regMsg'), e.message || '令牌无效', 'err');
    });
  });

  // 标签栏
  $('tabbar').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-tab]') : null;
    if (!btn) return;
    showView(btn.getAttribute('data-tab'));
    btn.blur();
  });

  // 游戏按钮
  $('btnToggle').addEventListener('click', function (e) { primaryAction(); e.currentTarget.blur(); });
  $('btnRestart').addEventListener('click', function (e) {
    engine.reset();
    engine.start();
    updateToggleBtn();
    renderPlayStats();
    maybePush(true);
    e.currentTarget.blur();
  });

  $('seg').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-i]') : null;
    if (!btn) return;
    setSpeed(Number(btn.getAttribute('data-i')));
    btn.blur();
  });

  // 查看码按钮
  function copyText(text, okNode, label) {
    var done = function () { setMsg(okNode, label + '已复制', 'ok'); setTimeout(function () { setMsg(okNode, ''); }, 2000); };
    var fail = function () { setMsg(okNode, '复制失败，请长按手动复制。', 'err'); };

    // 局域网是 http，不是安全上下文，navigator.clipboard 通常在手机上不可用，
    // 所以必须准备 execCommand 兜底。
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done(); else fail();
      } catch (e) {
        fail();
      }
    }

    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  }
  $('copyCode').addEventListener('click', function () { if (me) copyText(me.code, $('meMsg'), '查看码'); });
  $('copyToken').addEventListener('click', function () { copyText(token, $('meMsg'), '令牌'); });
  $('shareCode').addEventListener('click', function () {
    if (!me) return;
    var text = '来贪吃蛇看我在玩，我的查看码是 ' + me.code;
    if (navigator.share) {
      navigator.share({ text: text }).catch(function () { /* 用户取消 */ });
    } else {
      copyText(text, $('meMsg'), '邀请文字');
    }
  });

  // 加了陌生人的查看码
  $('addFriendBtn').addEventListener('click', function () { addFriend($('addCode').value); });
  $('addCode').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') addFriend($('addCode').value);
  });
  $('addCode').addEventListener('input', function (e) {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  // 观战页
  $('watchBack').addEventListener('click', function () { showView('play'); });
  $('watchFollow').addEventListener('click', function () {
    if (!watch.user) return;
    if (watch.followed) {
      api('/api/friends/' + watch.user.code, { method: 'DELETE' }).then(function () {
        watch.followed = false;
        renderFollowBtn();
        setMsg($('watchMsg'), '已取消关注', 'ok');
      }).catch(function (e) { setMsg($('watchMsg'), e.message || '操作失败', 'err'); });
    } else {
      api('/api/friends', { body: { code: watch.user.code } }).then(function () {
        watch.followed = true;
        renderFollowBtn();
        setMsg($('watchMsg'), '已加为好友，以后在「排行」里就能直接找到他。', 'ok');
      }).catch(function (e) { setMsg($('watchMsg'), e.message || '操作失败', 'err'); });
    }
  });

  // 方向盘显示模式
  function renderPadBtn() {
    $('padToggle').textContent = padMode === 'auto' ? '方向盘：自动' : (padMode === 'on' ? '方向盘：总是显示' : '方向盘：从不显示');
  }
  $('padToggle').addEventListener('click', function (e) {
    padMode = padMode === 'auto' ? 'on' : (padMode === 'on' ? 'off' : 'auto');
    storeSet(PAD_KEY, padMode);
    renderPadBtn();
    requestLayout();
    e.currentTarget.blur();
  });

  // 失焦自动暂停
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && engine.phase === 'running') {
      engine.pause();
      updateToggleBtn();
      maybePush(true);
    }
  });

  window.addEventListener('resize', requestLayout);
  window.addEventListener('orientationchange', function () { window.setTimeout(requestLayout, 120); });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', requestLayout);
    window.visualViewport.addEventListener('scroll', requestLayout);
  }

  /* ============================================================
     启动
     ============================================================ */
  (function init() {
    // 速度档位按钮的文字来自唯一数据源
    var seg = $('seg');
    for (var i = 0; i < S.SPEED_LEVELS.length; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-i', String(i));
      b.textContent = S.SPEED_LEVELS[i].label;
      seg.appendChild(b);
    }
    var sv = parseInt(storeGet(SPEED_KEY, '1'), 10);
    setSpeed(isFinite(sv) ? sv : 1, true);
    renderPadBtn();

    engine.reset();
    updateToggleBtn();
    renderPlayStats();
    setDot('', '未连接');

    layout();
    bootstrap();

    window.requestAnimationFrame(loop);
    window.setTimeout(requestLayout, 300);
    window.setInterval(function () {
      if (currentView === 'rank') refreshRank();
      else if (currentView === 'me') refreshMe();
    }, 5000);
  })();
})();
