/* ============================================================
   server.js —— 贪吃蛇多人版后端
   零依赖：只用 Node 内置模块（http / fs / path / os / crypto）。
   功能：账号令牌、查看码、实时观战（SSE）、好友关注、好友排行榜。
   存储：data/db.json（原子写入：写临时文件再改名）。
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const DEFAULT_PORT = Number(process.env.PORT || 8000);

const HISTORY_MAX = 100;      // 每人最多保留多少条战绩
const NAME_MAX = 12;
const BODY_MAX = 64 * 1024;   // 请求体上限
const ONLINE_MS = 15000;      // 多久没上报就算离线
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // 去掉 0 O 1 I 等易混字符
const CODE_LEN = 6;

/* ---------- 静态资源白名单（显式列名，天然没有目录穿越问题） ---------- */
const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/game.js': ['public/game.js', 'text/javascript; charset=utf-8'],
  '/snake.html': ['snake.html', 'text/html; charset=utf-8']    // 离线单人版，保留
};

/* ---------- 小工具 ---------- */
function json(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store'
  });
  res.end(s);
}

function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', function (c) {
    size += c.length;
    if (size > BODY_MAX) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () {
    if (!chunks.length) return cb(null, {});
    try {
      cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (e) {
      cb(e);
    }
  });
  req.on('error', function (e) { cb(e); });
}

function cleanName(raw) {
  let s = String(raw == null ? '' : raw);
  // 去掉控制字符，压缩空白
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > NAME_MAX) s = s.slice(0, NAME_MAX);
  return s;
}

function randomCode() {
  let out = '';
  const bytes = crypto.randomBytes(CODE_LEN);
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

/* ============================================================
   创建应用实例（可被 selftest.js 直接 require，不必起子进程）
   ============================================================ */
function createApp(opts) {
  opts = opts || {};
  const dataDir = opts.dataDir || process.env.SNAKE_DATA_DIR || path.join(ROOT, 'data');
  const dbFile = path.join(dataDir, 'db.json');
  const quiet = !!opts.quiet;

  function log() {
    if (!quiet) console.log.apply(console, arguments);
  }

  /* ---------- 数据 ---------- */
  let db = { users: {}, codes: {}, tokens: {} };
  const liveByUser = Object.create(null);    // 内存里的实时状态，不落盘
  const liveAt = Object.create(null);        // 最近一次上报时间
  const watchers = Object.create(null);      // code -> Set(res)

  function loadDb() {
    try {
      const parsed = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
      db = {
        users: (parsed && parsed.users) || {},
        codes: (parsed && parsed.codes) || {},
        tokens: (parsed && parsed.tokens) || {}
      };
    } catch (e) {
      if (e.code !== 'ENOENT') log('[db] 读取失败，将从空数据开始：' + e.message);
      db = { users: {}, codes: {}, tokens: {} };
    }
  }

  function saveDb() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = dbFile + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, users: db.users, codes: db.codes, tokens: db.tokens }));
      fs.renameSync(tmp, dbFile);
    } catch (e) {
      log('[db] 保存失败：' + e.message);
    }
  }

  function userByToken(token) {
    if (!token) return null;
    const id = db.tokens[token];
    return id && db.users[id] ? db.users[id] : null;
  }

  function auth(req) {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? userByToken(m[1].trim()) : null;
  }

  function userByCode(code) {
    const id = db.codes[String(code || '').toUpperCase()];
    return id && db.users[id] ? db.users[id] : null;
  }

  function statsOf(u) {
    return {
      best: u.best || 0,
      games: u.games || 0,
      total: u.total || 0,
      avg: u.games ? Math.round((u.total / u.games) * 10) / 10 : 0,
      lastAt: u.lastAt || 0
    };
  }

  function pub(u) {
    return { id: u.id, name: u.name, code: u.code, createdAt: u.createdAt };
  }

  function isOnline(u) {
    return Date.now() - (liveAt[u.id] || 0) < ONLINE_MS;
  }

  function followersOf(u) {
    const out = [];
    Object.keys(db.users).forEach(function (id) {
      const other = db.users[id];
      if (other.id === u.id) return;
      if ((other.following || []).indexOf(u.id) >= 0) out.push(other);
    });
    return out;
  }

  function friendsOf(u) {
    const out = [];
    (u.following || []).forEach(function (id) {
      const f = db.users[id];
      if (f) out.push(f);
    });
    return out;
  }

  function uniqueCode() {
    for (let i = 0; i < 50; i++) {
      const c = randomCode();
      if (!db.codes[c]) return c;
    }
    return null;
  }

  function uniqueName(base) {
    const taken = Object.create(null);
    Object.keys(db.users).forEach(function (id) { taken[db.users[id].name.toLowerCase()] = 1; });
    if (!taken[base.toLowerCase()]) return base;
    for (let i = 0; i < 30; i++) {
      const n = base + '#' + (100 + ((Math.random() * 900) | 0));
      if (!taken[n.toLowerCase()]) return n;
    }
    return base + '#' + Date.now().toString().slice(-4);
  }

  /* ---------- SSE ---------- */
  function addWatcher(code, res) {
    (watchers[code] || (watchers[code] = new Set())).add(res);
  }
  function removeWatcher(code, res) {
    const set = watchers[code];
    if (!set) return;
    set.delete(res);
    if (!set.size) delete watchers[code];
  }
  function watchCount(code) {
    return watchers[code] ? watchers[code].size : 0;
  }
  const SSE_MAX_BUFFER = 256 * 1024;   // 单个观众积压这么多字节就踢掉，别把内存吃光

  function dropWatcher(code, res) {
    try { res.end(); } catch (e) { /* 忽略 */ }
    removeWatcher(code, res);
  }

  function sseSend(code, res, event, payload) {
    try {
      // 手机息屏 / 页面切后台时不再读 socket，写队列会一直涨（每个观众约 18MB/小时）
      if (res.writableLength > SSE_MAX_BUFFER) {
        dropWatcher(code, res);
        return;
      }
      res.write('event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n');
    } catch (e) {
      dropWatcher(code, res);   // 客户端已断开
    }
  }

  function broadcast(code, event, payload) {
    const set = watchers[code];
    if (!set) return;
    // 先复制一份：发送过程中可能把某个跟不上的观众踢掉
    Array.from(set).forEach(function (res) { sseSend(code, res, event, payload); });
  }

  /* ---------- 路由 ---------- */
  function handleApi(req, res, pathname) {
    const method = req.method;

    if (pathname === '/api/health' && method === 'GET') {
      return json(res, 200, {
        ok: true,
        users: Object.keys(db.users).length,
        uptime: Math.round(process.uptime())
      });
    }

    /* --- 注册：昵称即可，服务端发令牌 --- */
    if (pathname === '/api/register' && method === 'POST') {
      return readBody(req, function (err, body) {
        if (err) return json(res, 400, { ok: false, error: '请求格式不对' });
        const name = cleanName(body && body.name);
        if (!name) return json(res, 400, { ok: false, error: '昵称不能为空' });

        const code = uniqueCode();
        if (!code) return json(res, 500, { ok: false, error: '生成查看码失败，请重试' });

        const id = crypto.randomBytes(8).toString('hex');
        const token = randomToken();
        const user = {
          id: id,
          name: uniqueName(name),
          code: code,
          createdAt: Date.now(),
          best: 0, games: 0, total: 0, lastAt: 0,
          history: [],
          following: []
        };
        db.users[id] = user;
        db.codes[code] = id;
        db.tokens[token] = id;
        saveDb();
        log('[reg] ' + user.name + '  ' + code);
        return json(res, 200, { ok: true, user: pub(user), token: token });
      });
    }

    /* --- 换设备：用旧的令牌直接换回来 --- */
    if (pathname === '/api/login' && method === 'POST') {
      return readBody(req, function (err, body) {
        if (err) return json(res, 400, { ok: false, error: '请求格式不对' });
        const u = userByToken(body && String(body.token || '').trim());
        if (!u) return json(res, 401, { ok: false, error: '令牌无效' });
        return json(res, 200, { ok: true, user: pub(u) });
      });
    }

    /* --- 我的资料 --- */
    if (pathname === '/api/me' && method === 'GET') {
      const u = auth(req);
      if (!u) return json(res, 401, { ok: false, error: '未登录' });
      const tk = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '')[1].trim();
      return json(res, 200, {
        ok: true,
        user: pub(u),
        token: tk,
        stats: statsOf(u),
        history: (u.history || []).slice(0, 20),
        online: isOnline(u),
        friends: friendsOf(u).map(function (f) {
          return { user: pub(f), stats: statsOf(f), online: isOnline(f), mutual: (f.following || []).indexOf(u.id) >= 0 };
        }),
        followers: followersOf(u).map(function (f) {
          return { user: pub(f), stats: statsOf(f), online: isOnline(f) };
        })
      });
    }

    /* --- 上报实时战况 --- */
    if (pathname === '/api/state' && method === 'POST') {
      const u = auth(req);
      if (!u) return json(res, 401, { ok: false, error: '未登录' });
      return readBody(req, function (err, body) {
        if (err) return json(res, 400, { ok: false, error: '请求格式不对' });
        const live = body && body.live;
        if (!live || typeof live !== 'object') return json(res, 400, { ok: false, error: '缺少 live' });
        liveByUser[u.id] = live;
        liveAt[u.id] = Date.now();
        broadcast(u.code, 'live', { live: live, online: true });
        return json(res, 200, { ok: true, watchers: watchCount(u.code) });
      });
    }

    /* --- 一局结束，记入战绩 --- */
    if (pathname === '/api/games' && method === 'POST') {
      const u = auth(req);
      if (!u) return json(res, 401, { ok: false, error: '未登录' });
      return readBody(req, function (err, body) {
        if (err) return json(res, 400, { ok: false, error: '请求格式不对' });
        const score = Math.max(0, Math.min(100000, Number(body && body.score) || 0));
        const rec = {
          score: score,
          length: Math.max(0, Number(body && body.length) || 0),
          duration: Math.max(0, Math.round(Number(body && body.duration) || 0)),
          speed: String((body && body.speed) || '').slice(0, 12),
          at: Date.now()
        };
        u.history = u.history || [];
        u.history.unshift(rec);
        if (u.history.length > HISTORY_MAX) u.history.length = HISTORY_MAX;
        u.games = (u.games || 0) + 1;
        u.total = (u.total || 0) + score;
        if (score > (u.best || 0)) u.best = score;
        u.lastAt = rec.at;
        saveDb();
        const payload = { score: score, name: u.name, stats: statsOf(u), record: rec };
        broadcast(u.code, 'game', payload);
        return json(res, 200, { ok: true, stats: statsOf(u) });
      });
    }

    /* --- 按查看码看某人 --- */
    let m = /^\/api\/users\/([A-Za-z0-9]+)$/.exec(pathname);
    if (m && method === 'GET') {
      const u = auth(req);
      if (!u) return json(res, 401, { ok: false, error: '未登录' });
      const target = userByCode(m[1]);
      if (!target) return json(res, 404, { ok: false, error: '查看码不存在' });
      return json(res, 200, {
        ok: true,
        user: pub(target),
        stats: statsOf(target),
        history: (target.history || []).slice(0, 20),
        online: isOnline(target),
        isMe: target.id === u.id,
        followed: (u.following || []).indexOf(target.id) >= 0
      });
    }

    /* --- 观战：轮询兜底 --- */
    m = /^\/api\/watch\/([A-Za-z0-9]+)\/snapshot$/.exec(pathname);
    if (m && method === 'GET') {
      const target = userByCode(m[1]);
      if (!target) return json(res, 404, { ok: false, error: '查看码不存在' });
      return json(res, 200, {
        ok: true,
        user: pub(target),
        stats: statsOf(target),
        live: liveByUser[target.id] || null,
        online: isOnline(target),
        updatedAt: liveAt[target.id] || 0,
        watchers: watchCount(target.code)
      });
    }

    /* --- 观战：SSE 实时推送 --- */
    m = /^\/api\/watch\/([A-Za-z0-9]+)\/stream$/.exec(pathname);
    if (m && method === 'GET') {
      const target = userByCode(m[1]);
      if (!target) return json(res, 404, { ok: false, error: '查看码不存在' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write('retry: 2000\n\n');

      const code = target.code;
      addWatcher(code, res);
      sseSend(code, res, 'hello', {
        user: pub(target),
        stats: statsOf(target),
        live: liveByUser[target.id] || null,
        online: isOnline(target),
        watchers: watchCount(code)
      });

      const ping = setInterval(function () {
        try { res.write(': ping\n\n'); } catch (e) { /* 忽略 */ }
      }, 20000);

      let closed = false;
      function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        removeWatcher(code, res);
      }
      req.on('close', cleanup);
      req.on('error', cleanup);
      res.on('error', cleanup);
      return undefined;
    }

    /* --- 关注（加好友） --- */
    if (pathname === '/api/friends' && method === 'POST') {
      const u = auth(req);
      if (!u) return json(res, 401, { ok: false, error: '未登录' });
      return readBody(req, function (err, body) {
        if (err) return json(res, 400, { ok: false, error: '请求格式不对' });
        const target = userByCode(body && body.code);
        if (!target) return json(res, 404, { ok: false, error: '查看码不存在' });
        if (target.id === u.id) return json(res, 400, { ok: false, error: '不能添加自己' });
        u.following = u.following || [];
        if (u.following.indexOf(target.id) < 0) {
          u.following.push(target.id);
          saveDb();
        }
        return json(res, 200, {
          ok: true,
          friend: {
            user: pub(target),
            stats: statsOf(target),
            online: isOnline(target),
            mutual: (target.following || []).indexOf(u.id) >= 0
          }
        });
      });
    }

    /* --- 取关 --- */
    m = /^\/api\/friends\/([A-Za-z0-9]+)$/.exec(pathname);
    if (m && method === 'DELETE') {
      const u = auth(req);
      if (!u) return json(res, 401, { ok: false, error: '未登录' });
      const target = userByCode(m[1]);
      if (!target) return json(res, 404, { ok: false, error: '查看码不存在' });
      u.following = (u.following || []).filter(function (id) { return id !== target.id; });
      saveDb();
      return json(res, 200, { ok: true });
    }

    /* --- 排行榜：我 + 我关注的人 --- */
    if (pathname === '/api/leaderboard' && method === 'GET') {
      const u = auth(req);
      if (!u) return json(res, 401, { ok: false, error: '未登录' });
      const list = [u].concat(friendsOf(u));
      const rows = list.map(function (x) {
        return {
          user: pub(x),
          stats: statsOf(x),
          online: isOnline(x),
          me: x.id === u.id,
          mutual: x.id !== u.id && (x.following || []).indexOf(u.id) >= 0
        };
      });
      rows.sort(function (a, b) {
        if (b.stats.best !== a.stats.best) return b.stats.best - a.stats.best;
        if (b.stats.games !== a.stats.games) return b.stats.games - a.stats.games;
        return a.user.name.localeCompare(b.user.name, 'zh');
      });
      return json(res, 200, { ok: true, rows: rows });
    }

    return json(res, 404, { ok: false, error: '没有这个接口' });
  }

  function handleStatic(req, res, pathname) {
    const entry = STATIC[pathname];
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + pathname);
      return;
    }
    fs.readFile(path.join(ROOT, entry[0]), function (err, data) {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 读不到文件 ' + entry[0] + '：' + err.message);
        return;
      }
      res.writeHead(200, {
        'Content-Type': entry[1],
        'Content-Length': data.length,
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
  }

  const server = http.createServer(function (req, res) {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (e) {
      pathname = '/';
    }

    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    try {
      if (pathname.indexOf('/api/') === 0) return handleApi(req, res, pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { ok: false, error: '方法不允许' });
      }
      return handleStatic(req, res, pathname);
    } catch (e) {
      log('[err] ' + (e && e.stack ? e.stack : e));
      try { json(res, 500, { ok: false, error: '服务器内部错误' }); } catch (e2) { /* 忽略 */ }
      return undefined;
    }
  });

  loadDb();

  return {
    server: server,
    dataDir: dataDir,
    dbFile: dbFile,
    db: function () { return db; },
    liveOf: function (code) {
      const u = userByCode(code);
      return u ? liveByUser[u.id] || null : null;
    },
    watchersOf: function (code) { return watchCount(code); },
    save: saveDb,
    listen: function (port, host, cb) {
      return server.listen(port, host, cb);
    }
  };
}

/* ---------- 直接运行时启动 ---------- */
function isPrivateIPv4(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some(function (n) { return !(n >= 0 && n <= 255); })) return false;
  return p[0] === 10 ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31);
}

function lanAddresses() {
  // 这台机器上常有多个虚拟网卡（VMware / Hyper-V / VPN / 热点），
  // 它们的地址对手机是没用的。所以只保留私有网段，并把 192.168.* 排最前面
  // —— 家用路由器几乎都是这个网段，手机要输的就是它。
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (n) {
      if (n.family !== 'IPv4' || n.internal) return;
      if (!isPrivateIPv4(n.address)) return;          // 过滤 114.114.114.114 这类公网地址
      if (out.indexOf(n.address) < 0) out.push(n.address);
    });
  });
  function rank(ip) {
    if (ip.indexOf('192.168.') === 0) return 0;
    if (ip.indexOf('10.') === 0) return 1;
    return 2;
  }
  out.sort(function (a, b) { return rank(a) - rank(b); });
  return out;
}

if (require.main === module) {
  // 局域网小服务：宁可把错误打出来继续跑，也不要整个进程挂掉让所有人断线。
  // （只装在「直接运行」时，selftest 里不会被吞掉错误。）
  process.on('uncaughtException', function (e) {
    console.error('[未捕获异常] ' + (e && e.stack ? e.stack : e));
  });
  process.on('unhandledRejection', function (e) {
    console.error('[未处理的 Promise] ' + (e && e.stack ? e.stack : e));
  });

  const app = createApp({});
  // 端口优先级：命令行参数 > 环境变量 PORT > 默认 8000
  const port = Number(process.argv[2]) || DEFAULT_PORT;
  app.listen(port, '0.0.0.0', function () {
    const ips = lanAddresses();
    console.log('');
    console.log('  贪吃蛇多人版已启动    数据文件：' + app.dbFile);
    console.log('');
    console.log('  这台电脑上：      http://localhost:' + port + '/');
    ips.forEach(function (ip, i) {
      console.log('  ' + (i === 0 ? '手机 / 平板：     ' : '（备用地址）      ') + 'http://' + ip + ':' + port + '/');
    });
    if (ips.length > 1) {
      console.log('                    ↑ 手机优先试第一条（192.168 开头的）');
    }
    console.log('');
    console.log('  离线单人版：      .../snake.html');
    console.log('  保持这个窗口开着。按 Ctrl+C 停止。');
    console.log('');
  });
}

module.exports = { createApp: createApp };
