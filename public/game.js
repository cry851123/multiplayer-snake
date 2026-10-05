/* ============================================================
   game.js —— 游戏核心：规则引擎 + 渲染
   本地游玩和「观战别人」共用这一套代码。
   纯逻辑 + 纯绘制，不碰 DOM、不发网络请求。
   ============================================================ */
(function (global) {
  'use strict';

  var FONT = "'PingFang SC','Microsoft YaHei','Noto Sans SC',system-ui,-apple-system,sans-serif";

  var COLORS = {
    bg: '#0f1621',
    grid: 'rgba(255,255,255,0.045)',
    head: '#6cf3ab',
    tail: '#1f9d5c',
    eye: '#0a1119',
    food: '#ff5a52',
    text: '#e8eef7',
    dim: 'rgba(232,238,247,0.72)',
    panel: 'rgba(9,13,20,0.80)',
    danger: '#ff7a72',
    gold: '#ffd166'
  };

  var SPEED_LEVELS = [
    { label: '慢', base: 200, min: 120, ramp: 5 },
    { label: '中', base: 140, min: 70, ramp: 4 },
    { label: '快', base: 100, min: 55, ramp: 3 },
    { label: '极速', base: 70, min: 45, ramp: 2 }
  ];

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  var HEAD_RGB = hexToRgb(COLORS.head);
  var TAIL_RGB = hexToRgb(COLORS.tail);

  function bodyColor(t) {
    return 'rgb(' +
      Math.round(HEAD_RGB.r + (TAIL_RGB.r - HEAD_RGB.r) * t) + ',' +
      Math.round(HEAD_RGB.g + (TAIL_RGB.g - HEAD_RGB.g) * t) + ',' +
      Math.round(HEAD_RGB.b + (TAIL_RGB.b - HEAD_RGB.b) * t) + ')';
  }

  /* ============ 规则引擎 ============ */
  function createEngine(opts) {
    opts = opts || {};
    var cols = opts.cols || 20;
    var rows = opts.rows || 20;
    var wrap = !!opts.wrap;

    var eng = {
      cols: cols,
      rows: rows,
      wrap: wrap,
      snake: [],
      dir: { x: 1, y: 0 },
      food: null,
      score: 0,
      phase: 'ready',       // ready | running | paused | over | win
      startedAt: 0,
      activeMs: 0,          // 真正在跑的时间（不含暂停/切后台），用来记战绩时长
      queue: [],
      _acc: 0,
      _lastTs: 0,

      reset: function () {
        var hx = Math.floor(cols / 2), hy = Math.floor(rows / 2);
        this.snake = [];
        for (var i = 0; i < 3; i++) this.snake.push({ x: hx - i, y: hy });
        this.dir = { x: 1, y: 0 };
        this.queue = [];
        this.score = 0;
        this._acc = 0;
        this._lastTs = 0;
        this.startedAt = Date.now();
        this.activeMs = 0;
        this.phase = 'ready';
        this.spawnFood();
        return this;
      },

      spawnFood: function () {
        var occupied = {};
        for (var i = 0; i < this.snake.length; i++) occupied[this.snake[i].y * cols + this.snake[i].x] = 1;
        var free = [];
        for (var y = 0; y < rows; y++) {
          for (var x = 0; x < cols; x++) {
            if (!occupied[y * cols + x]) free.push({ x: x, y: y });
          }
        }
        this.food = free.length ? free[(Math.random() * free.length) | 0] : null;
      },

      start: function () {
        if (this.phase === 'over' || this.phase === 'win') this.reset();
        this.phase = 'running';
        this._acc = 0;
        this._lastTs = 0;
      },
      pause: function () { if (this.phase === 'running') this.phase = 'paused'; },
      resume: function () { if (this.phase === 'paused') { this.phase = 'running'; this._acc = 0; this._lastTs = 0; } },

      queueDirection: function (nx, ny) {
        var last = this.queue.length ? this.queue[this.queue.length - 1] : this.dir;
        if (nx === -last.x && ny === -last.y) return;   // 禁止 180° 反向
        if (nx === last.x && ny === last.y) return;     // 同向忽略
        if (this.queue.length >= 2) return;
        this.queue.push({ x: nx, y: ny });
      },

      stepMs: function (cfg) {
        return Math.max(cfg.min, cfg.base - this.score * cfg.ramp);
      },

      // 推进一帧；返回 'idle' | 'moved' | 'ate' | 'over' | 'win'
      advance: function (now, cfg) {
        if (this.phase !== 'running') return 'idle';
        if (!this._lastTs) this._lastTs = now;
        var dt = now - this._lastTs;
        this._lastTs = now;
        if (dt > 100) dt = 100;

        this.activeMs += dt;      // 只累计真正在跑的时间
        this._acc += dt;
        var step = this.stepMs(cfg);
        if (this._acc < step) return 'idle';
        this._acc -= step;
        if (this._acc > step) this._acc = 0;
        return this.tick();
      },

      tick: function () {
        if (this.queue.length) this.dir = this.queue.shift();

        var head = this.snake[0];
        var nx = head.x + this.dir.x;
        var ny = head.y + this.dir.y;

        if (wrap) {
          nx = (nx + cols) % cols;
          ny = (ny + rows) % rows;
        } else if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) {
          this.phase = 'over';
          return 'over';
        }

        var growing = !!(this.food && nx === this.food.x && ny === this.food.y);
        // 不增长时尾格本步腾空，允许进入（经典规则）
        var limit = growing ? this.snake.length : this.snake.length - 1;
        for (var i = 0; i < limit; i++) {
          if (this.snake[i].x === nx && this.snake[i].y === ny) {
            this.phase = 'over';
            return 'over';
          }
        }

        this.snake.unshift({ x: nx, y: ny });
        if (!growing) this.snake.pop();

        if (growing) {
          this.score++;
          this.spawnFood();
          if (!this.food) { this.phase = 'win'; return 'win'; }
          return 'ate';
        }
        return 'moved';
      },

      // 上报 / 持久化用的紧凑快照
      snapshot: function () {
        return {
          cols: cols,
          rows: rows,
          snake: this.snake.map(function (c) { return [c.x, c.y]; }),
          food: this.food ? [this.food.x, this.food.y] : null,
          dir: [this.dir.x, this.dir.y],
          score: this.score,
          phase: this.phase
        };
      }
    };

    return eng.reset();
  }

  // 把服务端 / 别的客户端的快照还原成可渲染的结构
  function normalize(st) {
    if (!st) return null;
    var snake = (st.snake || []).map(function (c) {
      return Array.isArray(c) ? { x: c[0], y: c[1] } : { x: c.x, y: c.y };
    });
    var d = st.dir || [1, 0];
    return {
      cols: st.cols || 20,
      rows: st.rows || 20,
      snake: snake,
      food: st.food ? { x: st.food[0], y: st.food[1] } : null,
      dir: { x: d[0], y: d[1] },
      score: st.score || 0,
      phase: st.phase || 'ready'
    };
  }

  /* ============ 渲染 ============ */
  function roundRectPath(ctx, x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /**
   * @param ctx    2D context（逻辑坐标已按 dpr 缩放）
   * @param size   逻辑边长（= cols * cell）
   * @param st     normalize() 的结果
   * @param opts   { overlay: [{text,size,weight,color,gap}] | null, now, since }
   */
  function drawBoard(ctx, size, st, opts) {
    opts = opts || {};
    var cols = st.cols, rows = st.rows;
    var cell = size / cols;

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, size, size);

    // 网格
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = 1; x < cols; x++) {
      var px = x * cell + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, size);
    }
    for (var y = 1; y < rows; y++) {
      var py = y * cell + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(size, py);
    }
    ctx.stroke();

    // 食物
    if (st.food) {
      var fx = st.food.x * cell + cell / 2;
      var fy = st.food.y * cell + cell / 2;
      var pulse = 1 + 0.07 * Math.sin(((opts.now || 0) - (opts.since || 0)) / 260);
      var r = (cell / 2 - cell * 0.13) * pulse;
      ctx.beginPath();
      ctx.arc(fx, fy, r + cell * 0.14, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,90,82,0.16)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(fx, fy, r, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.food;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(fx - r * 0.32, fy - r * 0.34, r * 0.26, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fill();
    }

    // 蛇（从尾到头，蛇头压最上层）
    var n = st.snake.length;
    for (var i = n - 1; i >= 0; i--) {
      var c = st.snake[i];
      var t = n > 1 ? i / (n - 1) : 0;
      var pad = i === 0 ? cell * 0.05 : cell * 0.08;
      ctx.fillStyle = bodyColor(t);
      roundRectPath(ctx, c.x * cell + pad, c.y * cell + pad, cell - pad * 2, cell - pad * 2, i === 0 ? cell * 0.3 : cell * 0.25);
      ctx.fill();
    }

    // 眼睛
    if (n) {
      var h = st.snake[0];
      var cx = h.x * cell + cell / 2;
      var cy = h.y * cell + cell / 2;
      var fwd = cell * 0.17, side = cell * 0.21, er = cell * 0.105;
      var e1, e2;
      if (st.dir.x !== 0) {
        e1 = { x: cx + st.dir.x * fwd, y: cy - side };
        e2 = { x: cx + st.dir.x * fwd, y: cy + side };
      } else {
        e1 = { x: cx - side, y: cy + st.dir.y * fwd };
        e2 = { x: cx + side, y: cy + st.dir.y * fwd };
      }
      ctx.fillStyle = COLORS.eye;
      // 两只眼睛必须各自 beginPath：同一个 path 里连续两个 arc 会用一条直线连起来，
      // 填充时会在两眼之间留下一道细线。
      [e1, e2].forEach(function (p) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, er, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // 覆盖层
    var rowsO = opts.overlay;
    if (rowsO && rowsO.length) {
      ctx.fillStyle = COLORS.panel;
      ctx.fillRect(0, 0, size, size);

      var total = 0, k;
      for (k = 0; k < rowsO.length; k++) total += rowsO[k].size + (rowsO[k].gap || 0);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var yy = (size - total) / 2;
      for (k = 0; k < rowsO.length; k++) {
        var R = rowsO[k];
        yy += R.gap || 0;
        ctx.font = (R.weight || 400) + ' ' + R.size + 'px ' + FONT;
        ctx.fillStyle = R.color || COLORS.text;
        ctx.fillText(R.text, size / 2, yy + R.size / 2);
        yy += R.size;
      }
    }
  }

  global.Snake = {
    FONT: FONT,
    COLORS: COLORS,
    SPEED_LEVELS: SPEED_LEVELS,
    createEngine: createEngine,
    normalize: normalize,
    drawBoard: drawBoard
  };
})(typeof window !== 'undefined' ? window : globalThis);
