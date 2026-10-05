/* ============================================================
   selftest.js —— 贪吃蛇多人版后端「端到端」API 自测
   ------------------------------------------------------------
   用法：
       node selftest.js

   特点：
     * 零依赖：只用 Node 内置模块（fs / path / os / crypto / assert）。
     * 不起子进程：直接 require('./server.js')，用 createApp() 在内存里建实例，
       监听 0 号端口（系统随机分配），再从 app.server.address().port 读真实端口，
       所以永远不会和别人抢端口，也没有 stdout 管道问题。
     * 每次运行用一个全新的临时数据目录（os.tmpdir() 下），
       绝不碰项目真实的 data/ 目录，结束后递归删除。
     * 需要 Node 18+（依赖全局 fetch 和 WebStreams）。
     * 全部用例顺序执行，逐条打印 PASS / FAIL，最后一行是 "X passed, Y failed"。
     * 全程有 20 秒硬超时兜底，宁可大声失败也不会永久挂住。

   覆盖范围：health / 注册 / 令牌鉴权 / 实时上报 / 观战快照 / 战绩统计 /
             关注好友（幂等、自关注、不存在）/ 排行榜 / SSE 实时推送 / 重启持久化。
   ============================================================ */
'use strict';

/* ---------- 0. 运行环境检查（必须放在最前面） ---------- */
if (typeof fetch !== 'function') {
  console.error('');
  console.error('  ✗ 需要 Node 18 或更高版本：本脚本依赖全局 fetch。');
  console.error('    当前版本：' + process.version);
  console.error('    请升级 Node 后重新运行：node selftest.js');
  console.error('');
  process.exit(1);
}

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
const { createApp } = require('./server.js');

/* ---------- 1. 常量 ---------- */
const HARD_TIMEOUT_MS = 20000;   // 整轮自测的硬超时
const SSE_TIMEOUT_MS = 5000;     // 等待单个 SSE 事件的上限
const HOST = '127.0.0.1';

/* ---------- 2. 全局状态 ---------- */
let passed = 0;
let failed = 0;
let finished = false;            // shutdown 只允许跑一次
let hardTimer = null;
const servers = [];              // 需要在退出前关闭的 app 实例

// 每次运行都是全新的临时目录，绝不使用项目里的 data/
const dataDir = path.join(
  os.tmpdir(),
  'snake-selftest-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex')
);

/* ============================================================
   3. 小工具：断言计分 / HTTP 请求 / 监听 / 收尾
   ============================================================ */

/** 执行一条用例，成功记 PASS，抛错记 FAIL（不中断后续用例）。 */
async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS  ' + label);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + label);
    console.log('      原因：' + (e && e.message ? e.message : String(e)));
  }
}

/** 所有请求都走这一个入口：{method,path,token,body} -> {status,json,text}。 */
async function request(base, opts) {
  opts = opts || {};
  const headers = {};
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;

  const init = { method: opts.method || 'GET', headers: headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    init.body = JSON.stringify(opts.body);
  }

  const res = await fetch(base + opts.path, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, json: json, text: text };
}

/** 让 app 监听 0 号端口，返回系统分配的真实端口。 */
function listen(app) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    app.server.on('error', function (err) {
      if (!settled) { settled = true; reject(err); return; }
      console.error('      [server error] ' + (err && err.message));
    });
    app.listen(0, HOST, function () {
      const addr = app.server.address();
      if (!addr || typeof addr === 'string') {
        if (!settled) { settled = true; reject(new Error('拿不到监听端口')); }
        return;
      }
      settled = true;
      resolve(addr.port);
    });
  });
}

/** 关闭全部 http server（带兜底，绝不因为某个连接卡住而永久等待）。 */
function closeServers() {
  return Promise.all(servers.map(function (app) {
    return new Promise(function (resolve) {
      let settled = false;
      const done = function () { if (!settled) { settled = true; resolve(); } };
      try {
        app.server.close(done);
        // Node 18.2+：强制断开 keep-alive / SSE 长连接
        if (typeof app.server.closeAllConnections === 'function') app.server.closeAllConnections();
      } catch (e) {
        done();
      }
      setTimeout(done, 600);   // 兜底：600ms 内没回调也继续
    });
  }));
}

/** 统一退出路径：关服务器 -> 删临时目录 -> 强制 process.exit。 */
async function shutdown(code) {
  if (finished) return;
  finished = true;
  if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }

  // 硬兜底：万一 close 回调迟迟不来，2 秒后无论如何退出
  setTimeout(function () { process.exit(code); }, 2000);

  try { await closeServers(); } catch (e) { /* 忽略 */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(code);
}

/* ============================================================
   4. 极简 SSE 客户端
      - 按 '\n\n' 切帧
      - 忽略以 ':' 开头的注释/心跳行
      - 支持多行 data:（用 '\n' 连接）
      - 没有 data 的帧（例如服务端的 retry: 2000）不派发事件
   ============================================================ */
function createSseClient() {
  const events = [];
  let pending = null;        // {pred, resolve, reject, label, timer}
  let ended = false;
  let buffer = '';

  function flush() {
    if (!pending) return;
    for (let i = 0; i < events.length; i++) {
      if (pending.pred(events[i])) {
        const ev = events.splice(i, 1)[0];
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        p.resolve(ev);
        return;
      }
    }
    if (ended) {
      const p = pending;
      pending = null;
      clearTimeout(p.timer);
      p.reject(new Error('SSE 流已结束，但期望的事件没有到达：' + p.label));
    }
  }

  function parseFrame(frame) {
    const lines = frame.split('\n');
    let event = 'message';
    const dataLines = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.charAt(0) === ':') continue;      // 心跳注释，跳过
      const idx = line.indexOf(':');
      const field = idx < 0 ? line : line.slice(0, idx);
      let value = idx < 0 ? '' : line.slice(idx + 1);
      if (value.charAt(0) === ' ') value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (!dataLines.length) return null;                   // 无 data 不派发
    const raw = dataLines.join('\n');
    let data;
    try { data = JSON.parse(raw); } catch (e) { data = { __raw: raw }; }
    return { event: event, data: data };
  }

  return {
    feed: function (chunk) {
      buffer += String(chunk).replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseFrame(frame);
        if (ev) events.push(ev);
      }
      flush();
    },
    end: function () { ended = true; flush(); },
    /** 等待第一个满足 pred 的事件；超时或流结束都会 reject。 */
    next: function (pred, timeoutMs, label) {
      pred = pred || function () { return true; };
      return new Promise(function (resolve, reject) {
        const p = { pred: pred, resolve: resolve, reject: reject, label: label, timer: null };
        p.timer = setTimeout(function () {
          if (pending === p) {
            pending = null;
            reject(new Error('等待 SSE 事件超时（' + timeoutMs + 'ms）：' + label));
          }
        }, timeoutMs);
        pending = p;
        flush();
      });
    }
  };
}

/* ============================================================
   5. 主流程
   ============================================================ */
async function main() {
  console.log('');
  console.log('=== 贪吃蛇多人版 · 端到端 API 自测 ===');
  console.log('Node 版本：' + process.version);
  console.log('临时数据目录：' + dataDir);
  console.log('');

  /* ---------- 启动第一个 app 实例 ---------- */
  const app = createApp({ dataDir: dataDir, quiet: true });
  servers.push(app);
  const port = await listen(app);
  const base = 'http://' + HOST + ':' + port;
  console.log('服务地址：' + base + '   （端口由系统随机分配）');
  console.log('');

  /* 用例之间共享的数据 */
  let A = null, tokenA = '';          // 用户 A：阿甲
  let B = null, tokenB = '';          // 用户 B：阿乙
  const snapshotA = {                 // 一帧「真实」的游戏中快照
    cols: 20,
    rows: 20,
    snake: [[10, 10], [9, 10], [8, 10], [7, 10], [6, 10]],
    food: [14, 9],
    dir: [1, 0],
    score: 3,
    phase: 'running'
  };

  /* ============ a. 健康检查 ============ */
  await check('a. GET /api/health -> ok:true', async function () {
    const r = await request(base, { path: '/api/health' });
    assert.strictEqual(r.status, 200, '状态码应为 200，实际 ' + r.status);
    assert.strictEqual(r.json.ok, true, 'ok 应为 true');
  });

  /* ============ b. 注册用户 A ============ */
  await check('b. POST /api/register {name:"阿甲"} -> token + user.code/user.name 正确', async function () {
    const r = await request(base, { method: 'POST', path: '/api/register', body: { name: '阿甲' } });
    // 先记录 A，保证后续用例即使这一条失败也能拿到有用的报错而不是 null 崩溃
    if (r.json && r.json.user) { A = r.json.user; tokenA = r.json.token || ''; }

    assert.strictEqual(r.status, 200, '状态码应为 200，实际 ' + r.status);
    assert.strictEqual(r.json.ok, true, 'ok 应为 true');
    assert.ok(r.json.token && typeof r.json.token === 'string', '应返回字符串 token');
    assert.ok(A, '应返回 user 对象');
    assert.match(A.code, /^[A-Z0-9]{6}$/, 'user.code 应为 6 位大写字母数字，实际 ' + A.code);
    assert.strictEqual(A.name, '阿甲', 'user.name 应为 阿甲');
  });

  /* ============ c. 带令牌取自己的资料 ============ */
  await check('c. GET /api/me（带 token）-> code 一致 / best=0 / token 回显', async function () {
    const r = await request(base, { path: '/api/me', token: tokenA });
    assert.strictEqual(r.status, 200, '状态码应为 200，实际 ' + r.status);
    assert.strictEqual(r.json.ok, true, 'ok 应为 true');
    assert.strictEqual(r.json.user.code, A.code, 'user.code 应与注册时一致');
    assert.strictEqual(r.json.stats.best, 0, 'stats.best 初始应为 0');
    assert.strictEqual(r.json.token, tokenA, 'token 应原样回显');
  });

  /* ============ d. 无令牌 ============ */
  await check('d. GET /api/me（不带 token）-> 401', async function () {
    const r = await request(base, { path: '/api/me' });
    assert.strictEqual(r.status, 401, '状态码应为 401，实际 ' + r.status);
    assert.strictEqual(r.json.ok, false, 'ok 应为 false');
  });

  /* ============ e. 伪造令牌 ============ */
  await check('e. GET /api/me（伪造 token）-> 401', async function () {
    const r = await request(base, { path: '/api/me', token: crypto.randomBytes(24).toString('hex') });
    assert.strictEqual(r.status, 401, '状态码应为 401，实际 ' + r.status);
    assert.strictEqual(r.json.ok, false, 'ok 应为 false');
  });

  /* ============ f. 空昵称 ============ */
  await check('f. POST /api/register {name:"   "} -> 400', async function () {
    const r = await request(base, { method: 'POST', path: '/api/register', body: { name: '   ' } });
    assert.strictEqual(r.status, 400, '状态码应为 400，实际 ' + r.status);
    assert.strictEqual(r.json.ok, false, 'ok 应为 false');
  });

  /* ============ g. 同名注册 -> 自动加后缀 ============ */
  await check('g. 同名再注册 -> 显示名自动加后缀（与原名不同）', async function () {
    const r = await request(base, { method: 'POST', path: '/api/register', body: { name: '阿甲' } });
    assert.strictEqual(r.status, 200, '状态码应为 200，实际 ' + r.status);
    assert.strictEqual(r.json.ok, true, 'ok 应为 true');
    assert.notStrictEqual(r.json.user.name, '阿甲', '第二个同名用户的显示名必须与原名不同');
    assert.match(r.json.user.name, /^阿甲#/, '显示名应为「阿甲#NNN」形式，实际 ' + r.json.user.name);
    assert.notStrictEqual(r.json.user.code, A.code, '两个人的查看码不能相同');
  });

  /* ============ h. 上报实时快照 ============ */
  await check('h. POST /api/state 上报实时快照 -> ok，watchers=0', async function () {
    const r = await request(base, {
      method: 'POST', path: '/api/state', token: tokenA, body: { live: snapshotA }
    });
    assert.strictEqual(r.status, 200, '状态码应为 200，实际 ' + r.status);
    assert.strictEqual(r.json.ok, true, 'ok 应为 true');
    assert.strictEqual(r.json.watchers, 0, '此时还没有观战者，watchers 应为 0');
  });

  /* ============ i. 轮询兜底快照：内容必须与上报的完全一致 ============ */
  await check('i. GET /api/watch/<A.code>/snapshot -> live 与上报内容深度相等', async function () {
    const r = await request(base, { path: '/api/watch/' + A.code + '/snapshot' });
    assert.strictEqual(r.status, 200, '状态码应为 200，实际 ' + r.status);
    assert.strictEqual(r.json.ok, true, 'ok 应为 true');
    assert.notStrictEqual(r.json.live, null, 'live 不应为 null');
    assert.deepStrictEqual(r.json.live, snapshotA, 'live 应与上报的快照完全一致');
    assert.strictEqual(r.json.user.code, A.code, 'user.code 应为 A 的查看码');
  });

  /* ============ j. 不存在的查看码 ============ */
  await check('j. GET /api/watch/ZZZZZZ/snapshot -> 404', async function () {
    const r = await request(base, { path: '/api/watch/ZZZZZZ/snapshot' });
    assert.strictEqual(r.status, 404, '状态码应为 404，实际 ' + r.status);
    assert.strictEqual(r.json.ok, false, 'ok 应为 false');
  });

  /* ============ k. 第一局战绩 ============ */
  await check('k. POST /api/games 第一局(12 分) -> best=12 / games=1 / total=12 / avg=12', async function () {
    const r = await request(base, {
      method: 'POST', path: '/api/games', token: tokenA,
      body: { score: 12, length: 15, duration: 30000, speed: '中' }
    });
    assert.strictEqual(r.status, 200, '状态码应为 200，实际 ' + r.status);
    assert.strictEqual(r.json.ok, true, 'ok 应为 true');
    assert.strictEqual(r.json.stats.best, 12, 'best 应为 12');
    assert.strictEqual(r.json.stats.games, 1, 'games 应为 1');
    assert.strictEqual(r.json.stats.total, 12, 'total 应为 12');
    assert.strictEqual(r.json.stats.avg, 12, 'avg 应为 12');
  });

  /* ============ l. 第二局分数更低：best 不变，均值下降 ============ */
  await check('l. POST /api/games 第二局(5 分) -> best 仍 12 / games=2 / total=17 / avg=8.5', async function () {
    const r = await request(base, {
      method: 'POST', path: '/api/games', token: tokenA,
      body: { score: 5, length: 8, duration: 12000, speed: '快' }
    });
    assert.strictEqual(r.status, 200, '状态码应为 200，实际 ' + r.status);
    assert.strictEqual(r.json.stats.best, 12, '低分不应覆盖 best，应仍为 12');
    assert.strictEqual(r.json.stats.games, 2, 'games 应为 2');
    assert.strictEqual(r.json.stats.total, 17, 'total 应为 17');
    assert.strictEqual(r.json.stats.avg, 8.5, 'avg 应为 8.5');
  });

  /* ============ m0. 注册用户 B ============ */
  await check('m0. POST /api/register 注册用户 B（阿乙）', async function () {
    const r = await request(base, { method: 'POST', path: '/api/register', body: { name: '阿乙' } });
    if (r.json && r.json.user) { B = r.json.user; tokenB = r.json.token || ''; }

    assert.strictEqual(r.status, 200, '状态码应为 200，实际 ' + r.status);
    assert.strictEqual(r.json.ok, true, 'ok 应为 true');
    assert.ok(B, '应返回 user 对象');
    assert.match(B.code, /^[A-Z0-9]{6}$/, 'user.code 格式不对，实际 ' + B.code);
  });

  /* ============ m. B 视角看 A ============ */
  await check('m. B 用令牌 GET /api/users/<A.code> -> followed=false / history=2 / best=12', async function () {
    const r = await request(base, { path: '/api/users/' + A.code, token: tokenB });
    assert.strictEqual(r.status, 200, '状态码应为 200，实际 ' + r.status);
    assert.strictEqual(r.json.ok, true, 'ok 应为 true');
    assert.strictEqual(r.json.followed, false, 'B 还没关注 A，followed 应为 false');
    assert.strictEqual(r.json.history.length, 2, 'A 应有 2 条战绩，实际 ' + r.json.history.length);
    assert.strictEqual(r.json.stats.best, 12, 'A 的 best 应为 12');
    assert.strictEqual(r.json.isMe, false, '对 B 来说 isMe 应为 false');
  });

  /* ============ n. B 关注 A ============ */
  await check('n. POST /api/friends (B 加 A) -> friend.user.code === A.code', async function () {
    const r = await request(base, {
      method: 'POST', path: '/api/friends', token: tokenB, body: { code: A.code }
    });
    assert.strictEqual(r.status, 200, '状态码应为 200，实际 ' + r.status);
    assert.strictEqual(r.json.ok, true, 'ok 应为 true');
    assert.strictEqual(r.json.friend.user.code, A.code, 'friend.user.code 应为 A.code');
  });

  /* ============ o. 重复关注必须幂等 ============ */
  await check('o. 重复关注同一查看码 -> 仍然 ok，且排行榜里 A 只出现一次', async function () {
    const r2 = await request(base, {
      method: 'POST', path: '/api/friends', token: tokenB, body: { code: A.code }
    });
    assert.strictEqual(r2.status, 200, '重复关注状态码仍应为 200，实际 ' + r2.status);
    assert.strictEqual(r2.json.ok, true, 'ok 应为 true');

    const lb = await request(base, { path: '/api/leaderboard', token: tokenB });
    assert.strictEqual(lb.status, 200, '状态码应为 200，实际 ' + lb.status);
    const dup = lb.json.rows.filter(function (x) { return x.user.code === A.code; });
    assert.strictEqual(dup.length, 1, 'A 在 B 的排行榜中只应出现 1 次，实际 ' + dup.length);
  });

  /* ============ p. 不能加自己 ============ */
  await check('p. POST /api/friends {code:B.code} -> 400', async function () {
    const r = await request(base, {
      method: 'POST', path: '/api/friends', token: tokenB, body: { code: B.code }
    });
    assert.strictEqual(r.status, 400, '状态码应为 400，实际 ' + r.status);
    assert.strictEqual(r.json.ok, false, 'ok 应为 false');
  });

  /* ============ q. 关注不存在的查看码 ============ */
  await check('q. POST /api/friends {code:"ZZZZZZ"} -> 404', async function () {
    const r = await request(base, {
      method: 'POST', path: '/api/friends', token: tokenB, body: { code: 'ZZZZZZ' }
    });
    assert.strictEqual(r.status, 404, '状态码应为 404，实际 ' + r.status);
    assert.strictEqual(r.json.ok, false, 'ok 应为 false');
  });

  /* ============ r. B 的排行榜 ============ */
  await check('r. GET /api/leaderboard（B）-> 2 行，第一行是 A(12 分)，B 行 me=true', async function () {
    const r = await request(base, { path: '/api/leaderboard', token: tokenB });
    assert.strictEqual(r.status, 200, '状态码应为 200，实际 ' + r.status);
    assert.strictEqual(r.json.ok, true, 'ok 应为 true');
    assert.strictEqual(r.json.rows.length, 2, '应为「我 + 我关注的人」共 2 行，实际 ' + r.json.rows.length);
    assert.strictEqual(r.json.rows[0].user.code, A.code, '第一行应为 A（12 分）');
    assert.strictEqual(r.json.rows[0].stats.best, 12, '第一行 best 应为 12');

    const mine = r.json.rows.filter(function (x) { return x.me === true; });
    assert.strictEqual(mine.length, 1, '应有且仅有 1 行 me=true');
    assert.strictEqual(mine[0].user.code, B.code, 'me=true 的那行应是 B 自己');
  });

  /* ============ s. A 的排行榜（谁也没关注） ============ */
  await check('s. GET /api/leaderboard（A）-> 只有 1 行（A 自己）', async function () {
    const r = await request(base, { path: '/api/leaderboard', token: tokenA });
    assert.strictEqual(r.status, 200, '状态码应为 200，实际 ' + r.status);
    assert.strictEqual(r.json.rows.length, 1, 'A 没关注任何人，应只有 1 行，实际 ' + r.json.rows.length);
    assert.strictEqual(r.json.rows[0].user.code, A.code, '唯一一行应是 A');
  });

  /* ============ t. 取关 ============ */
  await check('t. DELETE /api/friends/<A.code>（B 取关）-> ok，排行榜回到 1 行', async function () {
    const del = await request(base, { method: 'DELETE', path: '/api/friends/' + A.code, token: tokenB });
    assert.strictEqual(del.status, 200, '状态码应为 200，实际 ' + del.status);
    assert.strictEqual(del.json.ok, true, 'ok 应为 true');

    const lb = await request(base, { path: '/api/leaderboard', token: tokenB });
    assert.strictEqual(lb.status, 200, '状态码应为 200，实际 ' + lb.status);
    assert.strictEqual(lb.json.rows.length, 1, '取关后应只剩 B 自己，实际 ' + lb.json.rows.length);
  });

  /* ============ u. SSE 实时观战（最重要的一条） ============ */
  await check('u. SSE 观战：第一个事件是 hello，随后上报状态能收到 live(score 更新)', async function () {
    const ac = new AbortController();
    let client = null;
    let pump = null;
    try {
      const res = await fetch(base + '/api/watch/' + A.code + '/stream', {
        headers: { Accept: 'text/event-stream' },
        signal: ac.signal
      });
      assert.strictEqual(res.status, 200, 'SSE 状态码应为 200，实际 ' + res.status);
      assert.ok(res.body, 'SSE 响应应带可读流 body');

      client = createSseClient();
      const reader = res.body.getReader();
      const dec = new TextDecoder();

      // 后台泵：把字节流增量喂给解析器
      pump = (async function () {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            client.feed(dec.decode(chunk.value, { stream: true }));
          }
        } catch (e) {
          // 被 AbortController 中止属于正常收尾
        }
        client.end();
      })();

      // (1) 第一个派发出来的事件必须是 hello
      const first = await client.next(function () { return true; }, SSE_TIMEOUT_MS, 'hello');
      assert.strictEqual(first.event, 'hello', '第一个事件应为 hello，实际 ' + first.event);
      assert.ok(first.data && first.data.user, 'hello 事件应带 user');
      assert.strictEqual(first.data.user.code, A.code, 'hello.user.code 应为 A.code');

      // (2) 再上报一帧新状态，应收到 live 事件
      const newScore = 7;
      const newSnap = Object.assign({}, snapshotA, {
        score: newScore,
        snake: [[11, 10], [10, 10], [9, 10], [8, 10]]
      });
      const post = await request(base, {
        method: 'POST', path: '/api/state', token: tokenA, body: { live: newSnap }
      });
      assert.strictEqual(post.status, 200, '上报状态应为 200，实际 ' + post.status);
      assert.ok(post.json.watchers >= 1, '此时应有观战者，watchers=' + post.json.watchers);

      const liveEv = await client.next(function (ev) { return ev.event === 'live'; }, SSE_TIMEOUT_MS, 'live');
      assert.ok(liveEv.data && liveEv.data.live, 'live 事件应带 live 快照');
      assert.strictEqual(liveEv.data.live.score, newScore, 'live.live.score 应为新值 ' + newScore);
    } finally {
      // 必须收掉这条长连接，否则进程无法退出
      try { ac.abort(); } catch (e) { /* 忽略 */ }
      if (pump) { try { await pump; } catch (e) { /* 忽略 */ } }
    }
  });

  /* ============ v. 持久化：同 dataDir 起第二个实例 ============ */
  await check('v. 持久化：同一 dataDir 新建实例，A 的原 token 仍拿到同一个 code', async function () {
    app.save();   // 显式落盘（其实各次写入已经存过了）

    const app2 = createApp({ dataDir: dataDir, quiet: true });
    servers.push(app2);                       // 退出时两个实例都会被关掉
    const port2 = await listen(app2);
    const base2 = 'http://' + HOST + ':' + port2;

    const r = await request(base2, { path: '/api/me', token: tokenA });
    assert.strictEqual(r.status, 200, '重启后状态码应为 200，实际 ' + r.status);
    assert.strictEqual(r.json.ok, true, 'ok 应为 true');
    assert.strictEqual(r.json.user.code, A.code, '重启后同一 token 应拿到同一查看码');
  });

  /* ---------- 汇总 ---------- */
  console.log('');
  console.log('---------------------------------------------');
  if (failed === 0) console.log('结果：全部通过 ✔');
  else console.log('结果：有 ' + failed + ' 条用例失败 ✘');
  console.log(passed + ' passed, ' + failed + ' failed');
  console.log('---------------------------------------------');
  console.log('');
}

/* ============================================================
   6. 硬超时 + 启动
   ============================================================ */
hardTimer = setTimeout(function () {
  console.error('');
  console.error('FAIL  总超时：自测在 ' + (HARD_TIMEOUT_MS / 1000) + ' 秒内没有跑完，强制退出');
  console.error('');
  console.error(passed + ' passed, ' + failed + ' failed');
  failed++;
  shutdown(1);
}, HARD_TIMEOUT_MS);

main().then(
  function () {
    shutdown(failed === 0 ? 0 : 1);
  },
  function (err) {
    failed++;
    console.error('');
    console.error('FAIL  自测过程中抛出未捕获错误：');
    console.error(err && err.stack ? err.stack : String(err));
    console.error('');
    console.error(passed + ' passed, ' + failed + ' failed');
    shutdown(1);
  }
);
