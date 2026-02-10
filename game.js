(function () {
  "use strict";

  // =========================================================
  // CONFIGURATION
  // =========================================================
  const W = 960;
  const H = 600;
  const GRID_SIZE = 4;
  const GRID_W = W / GRID_SIZE; // 240
  const GRID_H = H / GRID_SIZE; // 150

  const BALL_RADIUS = 10;
  const BALL_START_SPEED = 400;
  const BALL_SPEED_INC = 15; // extra px/s every 15 s
  const BALL_MAX_SPEED = 800;
  const BALL_BOUNCE_RAND = 0.12; // radians

  const SABER_EXT_SPEED = 800; // px/s  (was 2200 — much slower, real danger)
  const SABER_COOLDOWN = 650; // ms
  const SABER_ROT_SPEED = Math.PI * 1.6;

  const POWERUP_SPAWN_MIN = 8000;
  const POWERUP_SPAWN_MAX = 13000;
  const POWERUP_RADIUS = 14;

  const COMBO_WINDOW = 3000;

  const UNCLAIMED = 0;
  const WALL_CELL = 1;
  const CLAIMED = 2;
  const TEMP = 3;

  // =========================================================
  // UTILITY
  // =========================================================
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function dst(x1, y1, x2, y2) {
    return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  }
  function rand(lo, hi) {
    return lo + Math.random() * (hi - lo);
  }

  // Ray (ox,oy)+t*(dx,dy)  vs  segment (ax,ay)-(bx,by)
  function rayVsSeg(ox, oy, dx, dy, ax, ay, bx, by) {
    const sx = bx - ax,
      sy = by - ay;
    const den = dx * sy - dy * sx;
    if (Math.abs(den) < 1e-10) return null;
    const t = ((ax - ox) * sy - (ay - oy) * sx) / den;
    const s = ((ax - ox) * dy - (ay - oy) * dx) / den;
    if (t > 0.001 && s >= -0.001 && s <= 1.001) return { t, x: ox + t * dx, y: oy + t * dy };
    return null;
  }

  // Closest point on segment to point
  function cpOnSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax,
      dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-8) return { x: ax, y: ay };
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
    return { x: ax + t * dx, y: ay + t * dy };
  }

  // Line-segment vs circle intersection test
  function segVsCircle(ax, ay, bx, by, cx, cy, r) {
    const dx = bx - ax,
      dy = by - ay;
    const fx = ax - cx,
      fy = ay - cy;
    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - r * r;
    let disc = b * b - 4 * a * c;
    if (disc < 0) return false;
    disc = Math.sqrt(disc);
    const t1 = (-b - disc) / (2 * a);
    const t2 = (-b + disc) / (2 * a);
    return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1) || (t1 < 0 && t2 > 1);
  }

  function pointSegDist(px, py, ax, ay, bx, by) {
    const cp = cpOnSeg(px, py, ax, ay, bx, by);
    return dst(px, py, cp.x, cp.y);
  }

  // Bresenham
  function bline(x0, y0, x1, y1, cb) {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0),
      dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1,
      sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (true) {
      cb(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x0 += sx;
      }
      if (e2 < dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  // =========================================================
  // POWERUP DEFINITIONS
  // =========================================================
  const PU = {
    slowmo: { name: "SLOW-MO", icon: "S", color: "#00ff88", glow: "rgba(0,255,136,.25)", dur: 5000, pos: true },
    freeze: { name: "FREEZE", icon: "F", color: "#00ccff", glow: "rgba(0,204,255,.25)", dur: 3000, pos: true },
    ghost: { name: "GHOST BLADE", icon: "G", color: "#88ff00", glow: "rgba(136,255,0,.25)", dur: 0, pos: true },
    shield: { name: "SHIELD", icon: "D", color: "#ffff00", glow: "rgba(255,255,0,.25)", dur: 0, pos: true },
    speed: { name: "SPEED SURGE", icon: "!", color: "#ff3300", glow: "rgba(255,51,0,.25)", dur: 5000, pos: false },
    multiball: { name: "MULTI-BALL", icon: "M", color: "#ff0066", glow: "rgba(255,0,102,.25)", dur: 0, pos: false },
    phantom: { name: "PHANTOM", icon: "?", color: "#9900ff", glow: "rgba(153,0,255,.25)", dur: 8000, pos: false },
    wallrot: { name: "WALL ROT", icon: "X", color: "#ff6600", glow: "rgba(255,102,0,.25)", dur: 0, pos: false },
  };

  // =========================================================
  // AUDIO ENGINE  (Web Audio API – tiny synth)
  // =========================================================
  class SFX {
    constructor() {
      this.ctx = null;
    }
    init() {
      if (this.ctx) return;
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (_) {
        /* silent */
      }
    }
    _t(freq, dur, type, vol, delay) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime + (delay || 0);
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type || "sine";
      o.frequency.setValueAtTime(freq, now);
      g.gain.setValueAtTime(vol || 0.12, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur);
      o.connect(g);
      g.connect(this.ctx.destination);
      o.start(now);
      o.stop(now + dur);
    }
    wallPlace() {
      this._t(400, 0.12, "square", 0.08);
      this._t(600, 0.08, "sine", 0.1, 0.03);
    }
    bounce() {
      this._t(250 + Math.random() * 150, 0.04, "sine", 0.05);
    }
    slash() {
      this._t(150, 0.25, "sawtooth", 0.07);
      this._t(300, 0.12, "sine", 0.05);
    }
    gameOver() {
      this._t(200, 0.4, "sawtooth", 0.18);
      this._t(120, 0.55, "sawtooth", 0.12, 0.15);
    }
    bank() {
      this._t(500, 0.1, "sine", 0.12);
      this._t(700, 0.1, "sine", 0.12, 0.1);
      this._t(900, 0.14, "sine", 0.12, 0.2);
    }
    puGood() {
      this._t(600, 0.08, "sine", 0.1);
      this._t(900, 0.12, "sine", 0.1, 0.07);
    }
    puBad() {
      this._t(200, 0.14, "square", 0.1);
      this._t(100, 0.2, "sawtooth", 0.07, 0.04);
    }
    claim() {
      this._t(800, 0.14, "sine", 0.05);
      this._t(1000, 0.1, "sine", 0.04, 0.06);
    }
  }

  // =========================================================
  // PARTICLE SYSTEM
  // =========================================================
  class Particles {
    constructor() {
      this.p = [];
    }
    burst(x, y, n, col, spd, life) {
      spd = spd || 200;
      life = life || 0.6;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = spd * (0.3 + Math.random() * 0.7);
        this.p.push({
          x,
          y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s,
          life: life * (0.5 + Math.random() * 0.5),
          ml: life,
          col,
          sz: 1.5 + Math.random() * 2.5,
        });
      }
    }
    line(x1, y1, x2, y2, n, col) {
      const dx = x2 - x1,
        dy = y2 - y1;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / len,
        ny = dx / len;
      for (let i = 0; i < n; i++) {
        const t = Math.random();
        const side = Math.random() > 0.5 ? 1 : -1;
        const sp = 40 + Math.random() * 80;
        this.p.push({
          x: lerp(x1, x2, t),
          y: lerp(y1, y2, t),
          vx: nx * side * sp,
          vy: ny * side * sp,
          life: 0.25 + Math.random() * 0.3,
          ml: 0.55,
          col,
          sz: 1 + Math.random() * 2,
        });
      }
    }
    update(dt) {
      for (let i = this.p.length - 1; i >= 0; i--) {
        const q = this.p[i];
        q.x += q.vx * dt;
        q.y += q.vy * dt;
        q.vx *= 0.96;
        q.vy *= 0.96;
        q.life -= dt;
        if (q.life <= 0) this.p.splice(i, 1);
      }
    }
    draw(ctx) {
      for (const q of this.p) {
        ctx.globalAlpha = clamp(q.life / q.ml, 0, 1);
        ctx.fillStyle = q.col;
        ctx.fillRect(q.x - q.sz / 2, q.y - q.sz / 2, q.sz, q.sz);
      }
      ctx.globalAlpha = 1;
    }
  }

  // =========================================================
  // MAIN GAME
  // =========================================================
  class Game {
    constructor() {
      this.cvs = document.getElementById("gameCanvas");
      this.ctx = this.cvs.getContext("2d");
      this.cvs.width = W;
      this.cvs.height = H;
      this.resize();

      this.sfx = new SFX();
      this.particles = new Particles();

      // persistent input
      this.mouse = { x: W / 2, y: H / 2 };
      this.keys = {};
      this.angle = 0; // saber angle (radians)

      this.state = "menu"; // menu | playing | paused | gameover | banked
      this.bests = JSON.parse(localStorage.getItem("st_bests") || '{"score":0,"pct":0,"combo":0}');

      // demo ball for menu
      this.demo = { x: W / 2, y: H / 2, vx: 160, vy: 130, r: BALL_RADIUS, trail: [] };

      this._initBlank();
      this._input();
      this._lt = performance.now();
      this._frame = this._frame.bind(this);
      requestAnimationFrame(this._frame);
    }

    // ---------- helpers ------------------------------------------------
    resize() {
      const asp = W / H;
      const wa = window.innerWidth / window.innerHeight;
      if (wa > asp) {
        this.cvs.style.height = "100vh";
        this.cvs.style.width = "auto";
      } else {
        this.cvs.style.width = "100vw";
        this.cvs.style.height = "auto";
      }
    }
    mpos(e) {
      const r = this.cvs.getBoundingClientRect();
      return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
    }

    // ---------- init blank state (used before first play) ---------------
    _initBlank() {
      this.grid = [];
      for (let y = 0; y < GRID_H; y++) this.grid[y] = new Uint8Array(GRID_W);
      this.walls = [];
      this.balls = [];
      this.powerups = [];
      this.effects = {};
      this.notifs = [];
      this.saber = {
        ext: false,
        o: null,
        e1: null,
        e2: null,
        p1: 0,
        p2: 0,
        d1: 0,
        d2: 0,
        cd: 0,
        close: false,
        angle: 0,
      };
      this.claimedPct = 0;
      this.wallCount = 0;
      this.combo = { n: 0, t: 0 };
      this.maxCombo = 0;
      this.closeCalls = 0;
      this.elapsed = 0;
      this.score = 0;
      this.puTimer = 0;
      this.nextPu = rand(POWERUP_SPAWN_MIN, POWERUP_SPAWN_MAX);
      this.shake = { i: 0, t: 0 };
    }

    // ---------- input ---------------------------------------------------
    _input() {
      window.addEventListener("resize", () => this.resize());

      const action = () => {
        this.sfx.init();
        if (this.state === "menu" || this.state === "gameover" || this.state === "banked") this._start();
        else if (this.state === "playing") this._slash();
      };

      this.cvs.addEventListener("mousemove", (e) => {
        this.mouse = this.mpos(e);
      });
      this.cvs.addEventListener("mousedown", (e) => {
        e.preventDefault();
        action();
      });
      this.cvs.addEventListener(
        "touchstart",
        (e) => {
          e.preventDefault();
          this.mouse = this.mpos(e.touches[0]);
          this.sfx.init();
          action();
        },
        { passive: false },
      );
      this.cvs.addEventListener(
        "touchmove",
        (e) => {
          e.preventDefault();
          this.mouse = this.mpos(e.touches[0]);
        },
        { passive: false },
      );

      window.addEventListener("keydown", (e) => {
        this.keys[e.code] = true;
        this.sfx.init();
        if (e.code === "Enter" || e.code === "KeyF") action();
        if (e.code === "Space") {
          e.preventDefault();
          if (this.state === "playing") this._bank();
          else action();
        }
        if (e.code === "KeyR" && this.state !== "menu") this._start();
        if (e.code === "KeyC" && this.state === "menu") this._resetBests();
        if ((e.code === "KeyP" || e.code === "Escape") && (this.state === "playing" || this.state === "paused"))
          this.state = this.state === "playing" ? "paused" : "playing";
        // snap rotation
        if (e.code === "Digit1") this.angle = 0;
        if (e.code === "Digit2") this.angle = Math.PI / 2;
        if (e.code === "Digit3") this.angle = Math.PI / 4;
        if (e.code === "Digit4") this.angle = (Math.PI * 3) / 4;
      });
      window.addEventListener("keyup", (e) => {
        this.keys[e.code] = false;
      });
      this.cvs.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          this.angle += e.deltaY > 0 ? 0.1 : -0.1;
        },
        { passive: false },
      );
    }

    // ---------- start / reset -------------------------------------------
    _start() {
      this._initBlank();
      const a = Math.random() * Math.PI * 2;
      this.balls = [
        {
          x: W / 2 + rand(-100, 100),
          y: H / 2 + rand(-60, 60),
          vx: Math.cos(a) * BALL_START_SPEED,
          vy: Math.sin(a) * BALL_START_SPEED,
          r: BALL_RADIUS,
          trail: [],
          frozen: false,
          fvx: 0,
          fvy: 0,
        },
      ];
      this.state = "playing";
    }

    // =====================================================================
    //  GRID OPERATIONS
    // =====================================================================
    _rasterize(x1, y1, x2, y2) {
      const gx1 = clamp(Math.floor(x1 / GRID_SIZE), 0, GRID_W - 1);
      const gy1 = clamp(Math.floor(y1 / GRID_SIZE), 0, GRID_H - 1);
      const gx2 = clamp(Math.floor(x2 / GRID_SIZE), 0, GRID_W - 1);
      const gy2 = clamp(Math.floor(y2 / GRID_SIZE), 0, GRID_H - 1);
      bline(gx1, gy1, gx2, gy2, (x, y) => {
        if (x >= 0 && x < GRID_W && y >= 0 && y < GRID_H) this.grid[y][x] = WALL_CELL;
      });
    }

    _flood(sx, sy, from, to) {
      if (sx < 0 || sx >= GRID_W || sy < 0 || sy >= GRID_H) return;
      if (this.grid[sy][sx] !== from) return;
      const q = [sx + sy * GRID_W];
      let qi = 0;
      this.grid[sy][sx] = to;
      while (qi < q.length) {
        const idx = q[qi++];
        const x = idx % GRID_W,
          y = (idx - x) / GRID_W;
        const nb = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ];
        for (const [nx, ny] of nb) {
          if (nx >= 0 && nx < GRID_W && ny >= 0 && ny < GRID_H && this.grid[ny][nx] === from) {
            this.grid[ny][nx] = to;
            q.push(nx + ny * GRID_W);
          }
        }
      }
    }

    _claim() {
      // flood from each ball → mark ball zone as TEMP
      for (const b of this.balls) {
        const gx = clamp(Math.floor(b.x / GRID_SIZE), 0, GRID_W - 1);
        const gy = clamp(Math.floor(b.y / GRID_SIZE), 0, GRID_H - 1);
        // If ball cell is already wall, find nearest unclaimed cell
        if (this.grid[gy][gx] !== UNCLAIMED) {
          let found = false;
          for (let r = 1; r < 10 && !found; r++) {
            for (let dy = -r; dy <= r && !found; dy++) {
              for (let dx = -r; dx <= r && !found; dx++) {
                const nx = gx + dx,
                  ny = gy + dy;
                if (nx >= 0 && nx < GRID_W && ny >= 0 && ny < GRID_H && this.grid[ny][nx] === UNCLAIMED) {
                  this._flood(nx, ny, UNCLAIMED, TEMP);
                  found = true;
                }
              }
            }
          }
        } else {
          this._flood(gx, gy, UNCLAIMED, TEMP);
        }
      }
      // unreachable unclaimed → claimed
      let unc = 0;
      for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
          if (this.grid[y][x] === UNCLAIMED) this.grid[y][x] = CLAIMED;
          else if (this.grid[y][x] === TEMP) {
            this.grid[y][x] = UNCLAIMED;
            unc++;
          } else if (this.grid[y][x] === UNCLAIMED) unc++;
        }
      }
      // recount unclaimed (including the ones just set back)
      unc = 0;
      for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) if (this.grid[y][x] === UNCLAIMED) unc++;
      this.claimedPct = 1 - unc / (GRID_W * GRID_H);
    }

    _isUnc(x, y) {
      const gx = Math.floor(x / GRID_SIZE),
        gy = Math.floor(y / GRID_SIZE);
      return gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H && this.grid[gy][gx] === UNCLAIMED;
    }

    _rebuild() {
      for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) this.grid[y][x] = UNCLAIMED;
      for (const w of this.walls) this._rasterize(w.x1, w.y1, w.x2, w.y2);
      this._claim();
    }

    // =====================================================================
    //  RAY CASTING
    // =====================================================================
    _boundaries() {
      return [
        { x1: 0, y1: 0, x2: W, y2: 0 },
        { x1: W, y1: 0, x2: W, y2: H },
        { x1: W, y1: H, x2: 0, y2: H },
        { x1: 0, y1: H, x2: 0, y2: 0 },
      ];
    }

    _castRay(ox, oy, dx, dy) {
      let best = null,
        bestT = Infinity;
      const segs = [...this._boundaries(), ...this.walls];
      for (const s of segs) {
        const h = rayVsSeg(ox, oy, dx, dy, s.x1, s.y1, s.x2, s.y2);
        if (h && h.t < bestT) {
          bestT = h.t;
          best = h;
        }
      }
      return best;
    }

    _saberEnds() {
      const ea = this.effects.reverse ? this.angle + Math.PI / 2 : this.angle;
      const dx = Math.cos(ea),
        dy = Math.sin(ea);
      return {
        e1: this._castRay(this.mouse.x, this.mouse.y, dx, dy),
        e2: this._castRay(this.mouse.x, this.mouse.y, -dx, -dy),
        ea,
      };
    }

    // =====================================================================
    //  BALL PHYSICS
    // =====================================================================
    _updateBalls(dt) {
      let baseSpd = BALL_START_SPEED + (this.elapsed / 15) * BALL_SPEED_INC;
      let target = Math.min(baseSpd, BALL_MAX_SPEED);
      if (this.effects.slowmo) target *= 0.3;
      if (this.effects.speed) target *= 2;
      const frozen = !!this.effects.freeze;

      for (const b of this.balls) {
        if (frozen) {
          if (!b.frozen) {
            b.fvx = b.vx;
            b.fvy = b.vy;
            b.frozen = true;
          }
          b.vx = 0;
          b.vy = 0;
          continue;
        }
        if (b.frozen) {
          b.vx = b.fvx;
          b.vy = b.fvy;
          b.frozen = false;
        }
        // normalise speed
        const spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        if (spd > 0.5) {
          const s = target / spd;
          b.vx *= s;
          b.vy *= s;
        }

        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.trail.push({ x: b.x, y: b.y });
        if (b.trail.length > 22) b.trail.shift();

        // collide boundaries + walls
        const segs = [...this._boundaries(), ...this.walls];
        let col = 0;
        for (const s of segs) {
          if (col >= 4) break;
          if (this._ballSeg(b, s)) col++;
        }
      }
    }

    _ballSeg(b, s) {
      const cp = cpOnSeg(b.x, b.y, s.x1, s.y1, s.x2, s.y2);
      const dx = b.x - cp.x,
        dy = b.y - cp.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < b.r && d > 0.001) {
        const nx = dx / d,
          ny = dy / d;
        const vd = b.vx * nx + b.vy * ny;
        if (vd < 0) {
          b.vx -= 2 * vd * nx;
          b.vy -= 2 * vd * ny;
          // bounce randomness
          const ra = (Math.random() - 0.5) * BALL_BOUNCE_RAND * 2;
          const c = Math.cos(ra),
            sn = Math.sin(ra);
          const nvx = b.vx * c - b.vy * sn;
          const nvy = b.vx * sn + b.vy * c;
          b.vx = nvx;
          b.vy = nvy;
          this.sfx.bounce();
          this.particles.burst(cp.x, cp.y, 3, "#00ffff", 80, 0.25);
        }
        b.x = cp.x + nx * b.r;
        b.y = cp.y + ny * b.r;
        return true;
      }
      return false;
    }

    // =====================================================================
    //  SABER
    // =====================================================================
    _updateSaber(dt) {
      // rotation
      if (this.keys["KeyQ"] || this.keys["KeyA"]) this.angle -= SABER_ROT_SPEED * dt;
      if (this.keys["KeyE"] || this.keys["KeyD"]) this.angle += SABER_ROT_SPEED * dt;

      const sb = this.saber;
      if (!sb.ext) return;

      const spd = SABER_EXT_SPEED * dt;
      if (sb.p1 < 1) sb.p1 = Math.min(1, sb.p1 + spd / sb.d1);
      if (sb.p2 < 1) sb.p2 = Math.min(1, sb.p2 + spd / sb.d2);

      // current endpoints
      const cx = sb.o.x,
        cy = sb.o.y;
      const ex1 = lerp(cx, sb.e1.x, sb.p1),
        ey1 = lerp(cy, sb.e1.y, sb.p1);
      const ex2 = lerp(cx, sb.e2.x, sb.p2),
        ey2 = lerp(cy, sb.e2.y, sb.p2);

      // ball collision check
      for (const b of this.balls) {
        if (segVsCircle(ex2, ey2, ex1, ey1, b.x, b.y, b.r)) {
          if (this.effects.ghost) {
            delete this.effects.ghost;
            this._notif("GHOST BLADE!", "#88ff00");
            continue;
          }
          if (this.effects.shield) {
            delete this.effects.shield;
            this._notif("SHIELD ABSORBED!", "#ffff00");
            sb.ext = false;
            sb.cd = performance.now() + SABER_COOLDOWN;
            return;
          }
          this._die(b);
          return;
        }
      }

      // close call tracking
      for (const b of this.balls) {
        const d = pointSegDist(b.x, b.y, ex2, ey2, ex1, ey1);
        if (d < 30 && d > b.r) sb.close = true;
      }

      if (sb.p1 >= 1 && sb.p2 >= 1) this._completeWall();
    }

    _slash() {
      const sb = this.saber;
      if (sb.ext) return;
      if (performance.now() < sb.cd) return;
      if (!this._isUnc(this.mouse.x, this.mouse.y)) {
        this._notif("MOVE TO UNCLAIMED AREA", "#ff3333");
        return;
      }

      const { e1, e2, ea } = this._saberEnds();
      if (!e1 || !e2) return;
      const d1 = dst(this.mouse.x, this.mouse.y, e1.x, e1.y);
      const d2 = dst(this.mouse.x, this.mouse.y, e2.x, e2.y);
      if (d1 < 3 || d2 < 3) return;

      sb.ext = true;
      sb.o = { x: this.mouse.x, y: this.mouse.y };
      sb.e1 = e1;
      sb.e2 = e2;
      sb.d1 = d1;
      sb.d2 = d2;
      sb.p1 = 0;
      sb.p2 = 0;
      sb.close = false;
      sb.angle = ea;
      this.sfx.slash();
    }

    _completeWall() {
      const sb = this.saber;
      this.walls.push({ x1: sb.e2.x, y1: sb.e2.y, x2: sb.e1.x, y2: sb.e1.y });
      this.wallCount++;

      this._rasterize(sb.e2.x, sb.e2.y, sb.e1.x, sb.e1.y);
      this._claim();
      this._collectPU();

      // combo
      const now = performance.now();
      if (now - this.combo.t < COMBO_WINDOW && this.combo.n > 0) this.combo.n++;
      else this.combo.n = 1;
      this.combo.t = now;
      this.maxCombo = Math.max(this.maxCombo, this.combo.n);
      if (sb.close) {
        this.closeCalls++;
        this._notif("CLOSE CALL! +30", "#ff00ff");
      }

      this._calcScore();
      this.sfx.wallPlace();
      this.sfx.claim();
      this.particles.line(sb.e2.x, sb.e2.y, sb.e1.x, sb.e1.y, 22, "#00ffff");
      this.shake = { i: 3, t: 0.15 };

      sb.ext = false;
      sb.cd = now + SABER_COOLDOWN;
      if (this.effects.ghost) delete this.effects.ghost; // consume on use
    }

    // =====================================================================
    //  POWERUPS
    // =====================================================================
    _updatePU(dt) {
      this.puTimer += dt * 1000;
      if (this.puTimer >= this.nextPu) {
        this.puTimer = 0;
        this.nextPu = rand(POWERUP_SPAWN_MIN, POWERUP_SPAWN_MAX);
        this._spawnPU();
      }
      // tick effect timers
      for (const k of Object.keys(this.effects)) {
        const ef = this.effects[k];
        if (ef.tl !== undefined) {
          ef.tl -= dt * 1000;
          if (ef.tl <= 0) {
            delete this.effects[k];
            this._notif(k.toUpperCase() + " EXPIRED", "#666");
          }
        }
      }
      for (const p of this.powerups) p.pulse = (p.pulse || 0) + dt * 3;
    }

    _spawnPU() {
      const negChance = 0.3 + this.claimedPct * 0.55;
      const neg = Math.random() < negChance;
      const pool = neg ? ["speed", "multiball", "phantom", "wallrot"] : ["slowmo", "freeze", "ghost", "shield"];
      const type = pool[Math.floor(Math.random() * pool.length)];
      const pos = this._randUnc();
      if (pos) this.powerups.push({ x: pos.x, y: pos.y, type, def: PU[type], pulse: 0 });
    }

    _randUnc() {
      for (let i = 0; i < 120; i++) {
        const x = rand(POWERUP_RADIUS + 8, W - POWERUP_RADIUS - 8);
        const y = rand(POWERUP_RADIUS + 8, H - POWERUP_RADIUS - 8);
        if (!this._isUnc(x, y)) continue;
        let ok = true;
        for (const b of this.balls)
          if (dst(x, y, b.x, b.y) < 55) {
            ok = false;
            break;
          }
        if (ok) return { x, y };
      }
      return null;
    }

    _collectPU() {
      for (let i = this.powerups.length - 1; i >= 0; i--) {
        const p = this.powerups[i];
        const gx = Math.floor(p.x / GRID_SIZE),
          gy = Math.floor(p.y / GRID_SIZE);
        if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H && this.grid[gy][gx] === CLAIMED) {
          this._activatePU(p);
          this.powerups.splice(i, 1);
        }
      }
    }

    _activatePU(p) {
      const d = p.def;
      if (d.pos) {
        this.sfx.puGood();
      } else {
        this.sfx.puBad();
      }
      this.particles.burst(p.x, p.y, 14, d.color, 140, 0.45);
      this._notif(d.name + (d.pos ? "!" : "!!"), d.color);

      switch (p.type) {
        case "slowmo":
          this.effects.slowmo = { tl: d.dur };
          break;
        case "freeze":
          this.effects.freeze = { tl: d.dur };
          break;
        case "ghost":
          this.effects.ghost = { uses: 1 };
          break;
        case "shield":
          this.effects.shield = { uses: 1 };
          break;
        case "speed":
          this.effects.speed = { tl: d.dur };
          break;
        case "phantom":
          this.effects.phantom = { tl: d.dur };
          break;
        case "multiball": {
          const a = Math.random() * Math.PI * 2;
          const sp = BALL_START_SPEED + (this.elapsed / 15) * BALL_SPEED_INC;
          const pos = this._randUnc();
          if (pos)
            this.balls.push({
              x: pos.x,
              y: pos.y,
              vx: Math.cos(a) * sp,
              vy: Math.sin(a) * sp,
              r: BALL_RADIUS,
              trail: [],
              frozen: false,
              fvx: 0,
              fvy: 0,
            });
          break;
        }
        case "wallrot":
          if (this.walls.length > 0) {
            const idx = Math.floor(Math.random() * this.walls.length);
            const w = this.walls[idx];
            this.particles.line(w.x1, w.y1, w.x2, w.y2, 18, "#ff6600");
            this.walls.splice(idx, 1);
            this._rebuild();
          }
          break;
      }
    }

    // =====================================================================
    //  SCORING
    // =====================================================================
    _calcScore() {
      const area = Math.floor(this.claimedPct * 1000);
      const eff = this.wallCount > 0 ? Math.max(1, 2 - this.wallCount / 25) : 1;
      const spd = Math.max(1, 2 - this.elapsed / 120);
      const comboB = (this.maxCombo - 1) * 50;
      const closeB = this.closeCalls * 30;
      this.score = Math.floor(area * eff * spd + comboB + closeB);
    }

    _bank() {
      if (this.claimedPct < 0.005) return;
      this._calcScore();
      this.state = "banked";
      this.sfx.bank();
      this.shake = { i: 5, t: 0.25 };
      this._saveBests();
    }

    _die(ball) {
      this._calcScore();
      this.state = "gameover";
      this.saber.ext = false;
      this.sfx.gameOver();
      this.shake = { i: 14, t: 0.5 };
      this.particles.burst(ball.x, ball.y, 45, "#ff3300", 300, 0.8);
      this.particles.burst(ball.x, ball.y, 25, "#ffcc00", 200, 0.6);
      this._saveBests();
    }

    _saveBests() {
      if (this.score > this.bests.score) this.bests.score = this.score;
      if (this.claimedPct > this.bests.pct) this.bests.pct = this.claimedPct;
      if (this.maxCombo > this.bests.combo) this.bests.combo = this.maxCombo;
      localStorage.setItem("st_bests", JSON.stringify(this.bests));
    }

    _resetBests() {
      this.bests = { score: 0, pct: 0, combo: 0 };
      localStorage.setItem("st_bests", JSON.stringify(this.bests));
      this._notif("HIGH SCORES RESET", "#ffcc00");
    }

    _stars() {
      if (this.claimedPct >= 0.9) return 3;
      if (this.claimedPct >= 0.75) return 2;
      if (this.claimedPct >= 0.6) return 1;
      return 0;
    }

    _notif(text, color) {
      this.notifs.push({ text, color, y: H / 2 - 40 - this.notifs.length * 28, life: 2, ml: 2 });
    }

    // =====================================================================
    //  UPDATE
    // =====================================================================
    _update(dt) {
      // demo ball in menu
      if (this.state === "menu") {
        const d = this.demo;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        if (d.x - d.r < 0) {
          d.x = d.r;
          d.vx = Math.abs(d.vx);
        }
        if (d.x + d.r > W) {
          d.x = W - d.r;
          d.vx = -Math.abs(d.vx);
        }
        if (d.y - d.r < 0) {
          d.y = d.r;
          d.vy = Math.abs(d.vy);
        }
        if (d.y + d.r > H) {
          d.y = H - d.r;
          d.vy = -Math.abs(d.vy);
        }
        d.trail.push({ x: d.x, y: d.y });
        if (d.trail.length > 22) d.trail.shift();
        this.particles.update(dt);
        return;
      }
      if (this.state !== "playing") {
        this.particles.update(dt);
        return;
      }

      this.elapsed += dt;
      this._updateBalls(dt);
      this._updateSaber(dt);
      this._updatePU(dt);
      this.particles.update(dt);

      // notifications
      for (let i = this.notifs.length - 1; i >= 0; i--) {
        this.notifs[i].life -= dt;
        this.notifs[i].y -= dt * 25;
        if (this.notifs[i].life <= 0) this.notifs.splice(i, 1);
      }
      if (this.shake.t > 0) this.shake.t -= dt;
    }

    // =====================================================================
    //  RENDERING
    // =====================================================================
    _render() {
      const c = this.ctx;
      c.save();

      // screen shake
      if (this.shake.t > 0) {
        const int = this.shake.i * clamp(this.shake.t / 0.3, 0, 1);
        c.translate((Math.random() - 0.5) * int * 2, (Math.random() - 0.5) * int * 2);
      }

      // ---------- background ----------
      c.fillStyle = "#080818";
      c.fillRect(0, 0, W, H);
      c.strokeStyle = "rgba(0,200,255,.025)";
      c.lineWidth = 1;
      for (let x = 0; x <= W; x += 40) {
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, H);
        c.stroke();
      }
      for (let y = 0; y <= H; y += 40) {
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(W, y);
        c.stroke();
      }

      // ---------- claimed area ----------
      if (this.state !== "menu") {
        // batch claimed cells as horizontal runs for performance
        c.fillStyle = "rgba(0,80,200,.18)";
        for (let gy = 0; gy < GRID_H; gy++) {
          let sx = -1;
          for (let gx = 0; gx <= GRID_W; gx++) {
            const cl = gx < GRID_W && (this.grid[gy][gx] === CLAIMED || this.grid[gy][gx] === WALL_CELL);
            if (cl && sx === -1) sx = gx;
            else if (!cl && sx !== -1) {
              c.fillRect(sx * GRID_SIZE, gy * GRID_SIZE, (gx - sx) * GRID_SIZE, GRID_SIZE);
              sx = -1;
            }
          }
        }
      }

      // ---------- walls ----------
      if (this.walls.length > 0 || this.state !== "menu") {
        c.save();
        c.shadowColor = "#00ffff";
        c.shadowBlur = 8;
        c.strokeStyle = "#00ccdd";
        c.lineWidth = 2;
        for (const w of this.walls) {
          c.beginPath();
          c.moveTo(w.x1, w.y1);
          c.lineTo(w.x2, w.y2);
          c.stroke();
        }
        c.restore();
        // core
        c.strokeStyle = "rgba(180,255,255,.7)";
        c.lineWidth = 1;
        for (const w of this.walls) {
          c.beginPath();
          c.moveTo(w.x1, w.y1);
          c.lineTo(w.x2, w.y2);
          c.stroke();
        }
      }

      // boundary glow
      c.save();
      c.shadowColor = "#00aacc";
      c.shadowBlur = 12;
      c.strokeStyle = "#00889966";
      c.lineWidth = 2;
      c.strokeRect(1, 1, W - 2, H - 2);
      c.restore();

      // ---------- powerups ----------
      for (const p of this.powerups) {
        const d = p.def;
        const pulse = 1 + Math.sin(p.pulse) * 0.18;
        const r = POWERUP_RADIUS * pulse;
        c.save();
        c.shadowColor = d.color;
        c.shadowBlur = 14;
        c.beginPath();
        c.arc(p.x, p.y, r, 0, Math.PI * 2);
        c.fillStyle = d.glow;
        c.fill();
        c.strokeStyle = d.color;
        c.lineWidth = 2;
        c.stroke();
        c.fillStyle = d.color;
        c.font = 'bold 13px "Orbitron","Courier New",monospace';
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(d.icon, p.x, p.y + 1);
        c.restore();
        if (!d.pos) {
          c.strokeStyle = "rgba(255,0,0,.25)";
          c.lineWidth = 1;
          c.beginPath();
          c.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
          c.stroke();
        }
      }

      // ---------- balls ----------
      const drawBalls = this.state === "menu" ? [this.demo] : this.balls;
      for (const b of drawBalls) {
        // trail
        for (let i = 0; i < b.trail.length; i++) {
          const al = (i / b.trail.length) * 0.3;
          const sz = b.r * (i / b.trail.length);
          c.beginPath();
          c.arc(b.trail[i].x, b.trail[i].y, sz, 0, Math.PI * 2);
          c.fillStyle = `rgba(255,150,0,${al})`;
          c.fill();
        }
        // glow
        const gr = c.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r * 3);
        gr.addColorStop(0, "rgba(255,150,0,.35)");
        gr.addColorStop(0.5, "rgba(255,80,0,.08)");
        gr.addColorStop(1, "rgba(255,50,0,0)");
        c.fillStyle = gr;
        c.beginPath();
        c.arc(b.x, b.y, b.r * 3, 0, Math.PI * 2);
        c.fill();
        // body
        const bAlpha = this.effects.phantom ? 0.22 : 1;
        c.globalAlpha = bAlpha;
        c.save();
        c.shadowColor = "#ff9900";
        c.shadowBlur = 14;
        c.beginPath();
        c.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        c.fillStyle = "#ff9900";
        c.fill();
        c.restore();
        c.beginPath();
        c.arc(b.x, b.y, b.r * 0.45, 0, Math.PI * 2);
        c.fillStyle = "#ffffc8";
        c.fill();
        c.globalAlpha = 1;
      }

      // ---------- saber ----------
      if (this.state === "playing") {
        const sb = this.saber;
        if (sb.ext) {
          const cx = sb.o.x,
            cy = sb.o.y;
          const ex1 = lerp(cx, sb.e1.x, sb.p1),
            ey1 = lerp(cy, sb.e1.y, sb.p1);
          const ex2 = lerp(cx, sb.e2.x, sb.p2),
            ey2 = lerp(cy, sb.e2.y, sb.p2);
          c.save();
          c.shadowColor = "#00ffff";
          c.shadowBlur = 22;
          c.strokeStyle = "rgba(0,255,255,.55)";
          c.lineWidth = 6;
          c.beginPath();
          c.moveTo(ex2, ey2);
          c.lineTo(ex1, ey1);
          c.stroke();
          c.strokeStyle = "#fff";
          c.lineWidth = 2;
          c.beginPath();
          c.moveTo(ex2, ey2);
          c.lineTo(ex1, ey1);
          c.stroke();
          c.restore();
        } else {
          // crosshair only — no preview line (you have to aim blind)
          const mx = this.mouse.x,
            my = this.mouse.y;
          const ea2 = this.effects.reverse ? this.angle + Math.PI / 2 : this.angle;
          const col = this._isUnc(mx, my) ? "#00ffff" : "#ff3333";
          c.save();
          c.shadowColor = col;
          c.shadowBlur = 8;
          c.strokeStyle = col;
          c.lineWidth = 2;
          const dx = Math.cos(ea2) * 20,
            dy = Math.sin(ea2) * 20;
          c.beginPath();
          c.moveTo(mx - dx, my - dy);
          c.lineTo(mx + dx, my + dy);
          c.stroke();
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo(mx - -dy * 0.35, my - dx * 0.35);
          c.lineTo(mx + -dy * 0.35, my + dx * 0.35);
          c.stroke();
          c.restore();
        }
      }

      // ---------- particles ----------
      this.particles.draw(c);

      // ---------- notifications ----------
      for (const n of this.notifs) {
        c.globalAlpha = clamp(n.life / n.ml, 0, 1);
        c.fillStyle = n.color;
        c.font = 'bold 15px "Orbitron","Courier New",monospace';
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(n.text, W / 2, n.y);
      }
      c.globalAlpha = 1;

      c.restore(); // end shake

      // ---------- HUD ----------
      if (this.state === "playing" || this.state === "paused") this._drawHUD(c);

      // ---------- overlays ----------
      if (this.state === "menu") this._drawMenu(c);
      if (this.state === "paused") this._drawPaused(c);
      if (this.state === "gameover") this._drawGO(c);
      if (this.state === "banked") this._drawBanked(c);
    }

    // HUD
    _drawHUD(c) {
      // claimed %
      c.fillStyle = "#00ffff";
      c.font = 'bold 26px "Orbitron","Courier New",monospace';
      c.textAlign = "left";
      c.textBaseline = "top";
      c.fillText((this.claimedPct * 100).toFixed(1) + "%", 14, 10);
      c.fillStyle = "rgba(0,255,255,.45)";
      c.font = '11px "Orbitron","Courier New",monospace';
      c.fillText("CLAIMED", 14, 40);

      // progress bar
      c.fillStyle = "rgba(0,255,255,.12)";
      c.fillRect(14, 54, 120, 6);
      c.fillStyle = "#00ffff";
      c.fillRect(14, 54, 120 * this.claimedPct, 6);
      // star markers
      [0.6, 0.75, 0.9].forEach((th) => {
        const x = 14 + 120 * th;
        c.fillStyle = this.claimedPct >= th ? "#ffcc00" : "rgba(255,255,255,.2)";
        c.font = "10px serif";
        c.textAlign = "center";
        c.fillText("★", x, 52);
      });
      c.textAlign = "left";

      // score
      c.fillStyle = "#fff";
      c.font = 'bold 20px "Orbitron","Courier New",monospace';
      c.textAlign = "right";
      c.fillText(this.score.toLocaleString(), W - 14, 13);
      c.fillStyle = "rgba(255,255,255,.4)";
      c.font = '11px "Orbitron","Courier New",monospace';
      c.fillText("SCORE", W - 14, 38);

      // combo
      if (this.combo.n > 1 && performance.now() - this.combo.t < COMBO_WINDOW) {
        c.fillStyle = "#ff00ff";
        c.font = 'bold 16px "Orbitron","Courier New",monospace';
        c.fillText("x" + this.combo.n + " COMBO", W - 14, 56);
      }

      // active effects
      const ek = Object.keys(this.effects);
      if (ek.length) {
        c.textAlign = "center";
        let y = 12;
        for (const k of ek) {
          const ef = this.effects[k];
          const d = PU[k];
          if (!d) continue;
          let txt = d.name;
          if (ef.tl !== undefined) txt += " " + (ef.tl / 1000).toFixed(1) + "s";
          c.fillStyle = d.color;
          c.font = '13px "Orbitron","Courier New",monospace';
          c.fillText(txt, W / 2, y);
          y += 19;
        }
      }

      // footer
      c.fillStyle = "rgba(255,255,255,.25)";
      c.font = '10px "Orbitron","Courier New",monospace';
      c.textAlign = "left";
      c.fillText(
        "WALLS: " + this.wallCount + "  |  TIME: " + Math.floor(this.elapsed) + "s  |  BALLS: " + this.balls.length,
        14,
        H - 10,
      );

      // controls hint
      if (this.elapsed < 12) {
        c.textAlign = "center";
        c.fillStyle = `rgba(255,255,255,${clamp(1 - this.elapsed / 12, 0, 0.35)})`;
        c.font = '10px "Orbitron","Courier New",monospace';
        c.fillText("CLICK/F: slash | Q/E: rotate | 1-4: snap angle | SPACE: bank score | P: pause", W / 2, H - 10);
      }
    }

    // Menu
    _drawMenu(c) {
      c.fillStyle = "rgba(5,5,18,.82)";
      c.fillRect(0, 0, W, H);

      c.save();
      c.shadowColor = "#00ffff";
      c.shadowBlur = 35;
      c.fillStyle = "#00ffff";
      c.font = 'bold 58px "Orbitron","Courier New",monospace';
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("SABER TRAP", W / 2, H / 2 - 130);
      c.restore();

      c.fillStyle = "rgba(0,255,255,.5)";
      c.font = '15px "Orbitron","Courier New",monospace';
      c.textAlign = "center";
      c.fillText("Trap the ball. Claim the space.", W / 2, H / 2 - 80);

      c.fillStyle = "rgba(255,255,255,.65)";
      c.font = '12px "Orbitron","Courier New",monospace';
      const lines = [
        "CLICK or F \u2014 Slash (create wall)",
        "Q / E  or  A / D \u2014 Rotate saber",
        "1-4 \u2014 Snap angle (H / V / 45\u00b0 / 135\u00b0)",
        "SCROLL \u2014 Fine rotate",
        "SPACE \u2014 Bank score & end round",
        "P / ESC \u2014 Pause  |  R \u2014 Restart",
      ];
      lines.forEach((l, i) => c.fillText(l, W / 2, H / 2 - 25 + i * 22));

      if (Math.sin(performance.now() / 500) > 0) {
        c.fillStyle = "#fff";
        c.font = 'bold 18px "Orbitron","Courier New",monospace';
        c.fillText("CLICK OR PRESS ENTER TO START", W / 2, H / 2 + 130);
      }

      if (this.bests.score > 0) {
        c.fillStyle = "rgba(255,200,0,.55)";
        c.font = '13px "Orbitron","Courier New",monospace';
        c.fillText(
          "BEST: " + this.bests.score.toLocaleString() + " pts  |  " + (this.bests.pct * 100).toFixed(1) + "% claimed",
          W / 2,
          H / 2 + 170,
        );
        c.fillStyle = "rgba(255,255,255,.25)";
        c.font = '11px "Orbitron","Courier New",monospace';
        c.fillText("Press C to reset high scores", W / 2, H / 2 + 192);
      }
    }

    // Paused
    _drawPaused(c) {
      c.fillStyle = "rgba(5,5,18,.65)";
      c.fillRect(0, 0, W, H);
      c.save();
      c.shadowColor = "#00ffff";
      c.shadowBlur = 20;
      c.fillStyle = "#00ffff";
      c.font = 'bold 44px "Orbitron","Courier New",monospace';
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("PAUSED", W / 2, H / 2);
      c.restore();
      c.fillStyle = "rgba(255,255,255,.45)";
      c.font = '14px "Orbitron","Courier New",monospace';
      c.textAlign = "center";
      c.fillText("Press P or ESC to resume", W / 2, H / 2 + 38);
    }

    // Game Over
    _drawGO(c) {
      c.fillStyle = "rgba(18,0,0,.78)";
      c.fillRect(0, 0, W, H);
      c.save();
      c.shadowColor = "#ff3300";
      c.shadowBlur = 28;
      c.fillStyle = "#ff3300";
      c.font = 'bold 50px "Orbitron","Courier New",monospace';
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("GAME OVER", W / 2, H / 2 - 110);
      c.restore();
      this._scoreCard(c, H / 2 - 60);
    }

    // Banked
    _drawBanked(c) {
      c.fillStyle = "rgba(0,12,22,.82)";
      c.fillRect(0, 0, W, H);
      c.save();
      c.shadowColor = "#00ff88";
      c.shadowBlur = 28;
      c.fillStyle = "#00ff88";
      c.font = 'bold 44px "Orbitron","Courier New",monospace';
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("SCORE BANKED!", W / 2, H / 2 - 120);
      c.restore();
      this._scoreCard(c, H / 2 - 70);
    }

    _scoreCard(c, sy) {
      c.textAlign = "center";
      c.fillStyle = "#00ffff";
      c.font = 'bold 20px "Orbitron","Courier New",monospace';
      c.fillText("AREA CLAIMED: " + (this.claimedPct * 100).toFixed(1) + "%", W / 2, sy);

      const stars = this._stars();
      c.font = "26px serif";
      c.fillStyle = "#ffcc00";
      let st = "";
      for (let i = 0; i < 3; i++) st += i < stars ? "\u2605" : "\u2606";
      c.fillText(st, W / 2, sy + 32);

      c.font = '13px "Orbitron","Courier New",monospace';
      c.fillStyle = "rgba(255,255,255,.6)";
      c.fillText(
        "Walls: " +
          this.wallCount +
          "  |  Time: " +
          Math.floor(this.elapsed) +
          "s  |  Best Combo: x" +
          this.maxCombo +
          "  |  Close Calls: " +
          this.closeCalls,
        W / 2,
        sy + 62,
      );

      c.save();
      c.shadowColor = "#fff";
      c.shadowBlur = 10;
      c.fillStyle = "#fff";
      c.font = 'bold 34px "Orbitron","Courier New",monospace';
      c.fillText(this.score.toLocaleString() + " PTS", W / 2, sy + 105);
      c.restore();

      if (this.score >= this.bests.score && this.score > 0) {
        c.fillStyle = "#ffcc00";
        c.font = 'bold 14px "Orbitron","Courier New",monospace';
        c.fillText("\u2605 NEW BEST! \u2605", W / 2, sy + 138);
      }

      if (Math.sin(performance.now() / 500) > 0) {
        c.fillStyle = "rgba(255,255,255,.7)";
        c.font = '15px "Orbitron","Courier New",monospace';
        c.fillText("CLICK OR PRESS ENTER TO PLAY AGAIN", W / 2, sy + 175);
      }
    }

    // =====================================================================
    //  GAME LOOP
    // =====================================================================
    _frame(t) {
      const dt = Math.min((t - this._lt) / 1000, 0.05);
      this._lt = t;
      this._update(dt);
      this._render();
      requestAnimationFrame(this._frame);
    }
  }

  // =========================================================
  // BOOT
  // =========================================================
  window.addEventListener("load", () => new Game());
})();
