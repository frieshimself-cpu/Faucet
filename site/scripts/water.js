/* ═══════════════════════════════════════════════════════════════════════════
   water.js — the liquid.

   The faucet is SVG; the water is a canvas laid over it. The two stay in
   register because the canvas maps the faucet's own viewBox coordinates into
   pixels on every resize, so the stream always leaves the aerator and always
   lands in the tank however the layout reflows.

   What is simulated, in the order it matters:
     · a pendant drop that grows at the aerator and detaches under its own
       weight — that is what a nearly-closed tap actually does, and it is the
       difference between "dripping" and "a dashed line moving downward";
     · a laminar column with two out-of-phase edges and refraction bands;
     · impact: a crown of ejecta, a ring on the surface, and a wobble that
       travels across the meniscus;
     · bubbles rising through the tank, slowed near the surface;
     · a low haze of mist around the impact point.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const canvas = document.getElementById('waterCanvas');
  const fixture = document.getElementById('faucet');
  if (!canvas || !fixture) return;

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* Anchors, in the faucet's own viewBox units. */
  const VIEWBOX = { w: 470, h: 620 };
  const SPOUT = { x: 354, y: 476 };
  const TANK = { x: 246, y: 488, w: 208, h: 116 };

  const G = 1520;          /* gravity, px/s^2 in viewBox units */
  const MAX_DROPS = 260;
  const MAX_EJECTA = 420;

  const state = {
    dpr: 1, width: 0, height: 0,
    scale: 1, originX: 0, originY: 0,
    flow: 0.72,
    level: 0.3,
    levelTarget: 0.3,
    emit: 0,
    pendant: 0,        /* 0..1, how full the hanging drop at the spout is */
    lastFrame: 0,
    running: false,
    t: 0,
    /* Travelling wave on the meniscus, kicked by each impact. */
    wave: 0,
    wavePhase: 0,
  };

  const drops = [];
  const ejecta = [];
  const rings = [];
  const bubbles = [];
  const mist = [];

  const toCanvas = (x, y) => ({ x: state.originX + x * state.scale, y: state.originY + y * state.scale });
  const S = (n) => n * state.scale;

  function measure() {
    const canvasBox = canvas.getBoundingClientRect();
    const fixtureBox = fixture.getBoundingClientRect();
    if (canvasBox.width === 0 || fixtureBox.width === 0) return;

    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.width = canvasBox.width;
    state.height = canvasBox.height;

    canvas.width = Math.round(state.width * state.dpr);
    canvas.height = Math.round(state.height * state.dpr);
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

    /* SVG defaults to preserveAspectRatio="xMidYMid meet". */
    const scale = Math.min(fixtureBox.width / VIEWBOX.w, fixtureBox.height / VIEWBOX.h);
    state.scale = scale;
    state.originX = fixtureBox.left - canvasBox.left + (fixtureBox.width - VIEWBOX.w * scale) / 2;
    state.originY = fixtureBox.top - canvasBox.top + (fixtureBox.height - VIEWBOX.h * scale) / 2;
  }

  const surfaceY = () => TANK.y + TANK.h * (1 - state.level);

  /* Meniscus height at a given x, so the surface is a moving line rather than
     a ruled one. Amplitude decays after each impact. */
  function surfaceAt(vx) {
    const k = (vx - TANK.x) / TANK.w;
    return (
      surfaceY() +
      Math.sin(k * 7 + state.wavePhase) * 1.6 * state.wave +
      Math.sin(k * 13 - state.wavePhase * 1.7) * 0.9 * state.wave
    );
  }

  /* ── emitters ──────────────────────────────────────────────────────────── */

  function shed(radius, speed) {
    if (drops.length >= MAX_DROPS) return;
    drops.push({
      x: SPOUT.x + (Math.random() - 0.5) * 2.6,
      y: SPOUT.y + 2,
      vx: (Math.random() - 0.5) * 5,
      vy: speed,
      r: radius,
      born: state.t,
    });
  }

  function splash(vx, vy, force) {
    const count = Math.round(4 + force * 9);
    for (let i = 0; i < count; i++) {
      if (ejecta.length >= MAX_EJECTA) break;
      /* A crown: mostly upward and outward, never straight down. */
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * (1.5 + force);
      const speed = (36 + Math.random() * 120) * (0.5 + force);
      ejecta.push({
        x: vx + (Math.random() - 0.5) * 5,
        y: vy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: 0.5 + Math.random() * 1.5,
        life: 1,
      });
    }

    rings.push({ x: vx, y: vy, r: 2, life: 1, force });
    state.wave = Math.min(1.6, state.wave + 0.5 + force * 0.5);

    for (let i = 0; i < 2; i++) {
      if (mist.length > 90) break;
      mist.push({
        x: vx + (Math.random() - 0.5) * 16,
        y: vy - Math.random() * 10,
        vx: (Math.random() - 0.5) * 16,
        vy: -8 - Math.random() * 22,
        r: 2 + Math.random() * 5,
        life: 1,
      });
    }

    if (Math.random() < 0.55 && bubbles.length < 40) {
      bubbles.push({
        x: vx + (Math.random() - 0.5) * 22,
        y: TANK.y + TANK.h - Math.random() * 12,
        r: 0.9 + Math.random() * 2.4,
        vy: -(9 + Math.random() * 20),
        wob: Math.random() * Math.PI * 2,
        life: 1,
      });
    }
  }

  /* ── integration ───────────────────────────────────────────────────────── */

  function step(dt) {
    state.t += dt;

    if (state.flow > 0.18) {
      /* Open enough for a continuous column: shed droplets fast so the stream
         has body, and clear any pendant drop. */
      state.pendant = 0;
      state.emit += state.flow * 62 * dt;
      while (state.emit >= 1) {
        state.emit -= 1;
        shed(1.4 + Math.random() * 2.4, 55 + Math.random() * 90);
      }
    } else if (state.flow > 0.005) {
      /* Nearly shut: surface tension holds a bead at the aerator until its
         weight beats it, then it lets go all at once. */
      state.pendant += state.flow * 1.35 * dt;
      if (state.pendant >= 1) {
        state.pendant = 0;
        shed(4.4, 8);
      }
    } else {
      state.pendant = Math.max(0, state.pendant - dt * 0.6);
    }

    const left = TANK.x + 4;
    const right = TANK.x + TANK.w - 4;

    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.vy += G * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;

      const surface = surfaceAt(d.x);
      if (d.y >= surface) {
        if (d.x > left && d.x < right) {
          splash(d.x, surface, Math.min(1, d.vy / 620) * (0.4 + d.r / 5));
          state.level = Math.min(0.66, state.level + 0.0022 * d.r);
        }
        drops.splice(i, 1);
      } else if (state.t - d.born > 6) {
        drops.splice(i, 1);
      }
    }

    for (let i = ejecta.length - 1; i >= 0; i--) {
      const e = ejecta[i];
      e.vy += G * 0.72 * dt;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.life -= dt * 1.7;
      if (e.life <= 0 || e.y > TANK.y + TANK.h) ejecta.splice(i, 1);
    }

    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.r += (28 + r.force * 40) * dt * 1.5;
      r.life -= dt * 1.9;
      if (r.life <= 0) rings.splice(i, 1);
    }

    for (let i = mist.length - 1; i >= 0; i--) {
      const m = mist[i];
      m.vy += 24 * dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.r += 9 * dt;
      m.life -= dt * 0.85;
      if (m.life <= 0) mist.splice(i, 1);
    }

    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      b.wob += dt * 6;
      b.y += b.vy * dt;
      b.x += Math.sin(b.wob) * 7 * dt;
      /* Bubbles slow as they near the surface, then pop. */
      const depth = b.y - surfaceAt(b.x);
      if (depth < 6) b.life -= dt * 3.2;
      if (b.life <= 0 || b.y < surfaceAt(b.x) - 2) bubbles.splice(i, 1);
    }

    state.wave = Math.max(0, state.wave - dt * 1.3);
    state.wavePhase += dt * 7;

    /* The tank reads as a rate, not a total: it rises with flow and drains
       slowly, so an idle tap settles back down instead of overflowing. */
    state.levelTarget = 0.08 + state.flow * 0.5;
    state.level = lerp(state.level, state.levelTarget, Math.min(1, dt * 0.85));
  }

  const lerp = (a, b, t) => a + (b - a) * t;

  /* ── painting ──────────────────────────────────────────────────────────── */

  function drawColumn() {
    if (state.flow < 0.18) return;

    const top = toCanvas(SPOUT.x, SPOUT.y);
    const bottomV = surfaceAt(SPOUT.x);
    const bottom = toCanvas(SPOUT.x, bottomV).y;
    if (bottom <= top.y) return;

    const w = S(1.2 + state.flow * 5.6);
    const t = state.t * 4.4;
    const span = bottom - top.y;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const grad = ctx.createLinearGradient(top.x, top.y, top.x, bottom);
    grad.addColorStop(0, 'rgba(214, 255, 240, 0.92)');
    grad.addColorStop(0.35, 'rgba(0, 224, 122, 0.8)');
    grad.addColorStop(1, 'rgba(0, 168, 92, 0.16)');

    ctx.beginPath();
    ctx.moveTo(top.x - w / 2, top.y);
    for (let y = top.y; y <= bottom; y += 5) {
      const p = (y - top.y) / span;
      // A falling column necks in slightly and ripples along its length.
      const necking = 1 - p * 0.22;
      const wob = Math.sin(y * 0.09 + t) * S(1.5) * (0.25 + p);
      ctx.lineTo(top.x - (w / 2) * necking + wob, y);
    }
    for (let y = bottom; y >= top.y; y -= 5) {
      const p = (y - top.y) / span;
      const necking = 1 - p * 0.22;
      const wob = Math.cos(y * 0.085 + t * 1.14) * S(1.5) * (0.25 + p);
      ctx.lineTo(top.x + (w / 2) * necking + wob, y);
    }
    ctx.closePath();

    ctx.fillStyle = grad;
    ctx.shadowColor = 'rgba(0, 224, 122, 0.6)';
    ctx.shadowBlur = S(16);
    ctx.fill();
    ctx.shadowBlur = 0;

    /* Refraction bands sliding down the inside of the column. */
    ctx.clip();
    ctx.strokeStyle = 'rgba(214, 255, 240, 0.5)';
    ctx.lineWidth = Math.max(1, S(1.1));
    for (let i = 0; i < 5; i++) {
      const y = top.y + (((state.t * 260 + i * span * 0.22) % span));
      ctx.beginPath();
      ctx.moveTo(top.x - w, y);
      ctx.lineTo(top.x + w, y + S(2));
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawPendant() {
    if (state.pendant <= 0.02) return;
    const p = state.pendant;
    const at = toCanvas(SPOUT.x, SPOUT.y);
    const r = S(1.6 + p * 3.6);
    // The bead necks out as it fills, and stretches just before it lets go.
    const stretch = 1 + p * p * 0.9;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath();
    ctx.ellipse(at.x, at.y + r * 0.4 * stretch, r, r * stretch, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 224, 122, 0.9)';
    ctx.shadowColor = 'rgba(0, 224, 122, 0.8)';
    ctx.shadowBlur = S(12);
    ctx.fill();

    ctx.beginPath();
    ctx.ellipse(at.x - r * 0.3, at.y + r * 0.1, r * 0.3, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(214, 255, 240, 0.75)';
    ctx.shadowBlur = 0;
    ctx.fill();
    ctx.restore();
  }

  function drawDrops() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = 'rgba(0, 224, 122, 0.75)';

    for (const d of drops) {
      const at = toCanvas(d.x, d.y);
      const stretch = Math.min(3.6, 1 + Math.abs(d.vy) / 380);
      const r = S(d.r);
      ctx.beginPath();
      ctx.ellipse(at.x, at.y, r, r * stretch, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 224, 122, 0.88)';
      ctx.shadowBlur = S(9);
      ctx.fill();
      /* A highlight on the leading edge; drops are lenses, not dots. */
      ctx.beginPath();
      ctx.ellipse(at.x - r * 0.3, at.y - r * stretch * 0.25, r * 0.3, r * 0.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(214, 255, 240, 0.7)';
      ctx.shadowBlur = 0;
      ctx.fill();
    }

    ctx.restore();
  }

  function drawSurface() {
    /* The meniscus line, redrawn each frame with the travelling wave on it. */
    const left = toCanvas(TANK.x + 2, 0).x;
    const right = toCanvas(TANK.x + TANK.w - 2, 0).x;

    ctx.save();
    ctx.beginPath();
    for (let vx = TANK.x + 2; vx <= TANK.x + TANK.w - 2; vx += 4) {
      const at = toCanvas(vx, surfaceAt(vx));
      if (vx === TANK.x + 2) ctx.moveTo(at.x, at.y);
      else ctx.lineTo(at.x, at.y);
    }
    ctx.strokeStyle = `rgba(214, 255, 240, ${0.45 + state.wave * 0.3})`;
    ctx.lineWidth = Math.max(1.2, S(2));
    ctx.shadowColor = 'rgba(134, 255, 198, 0.7)';
    ctx.shadowBlur = S(6);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();

    void left; void right;
  }

  function drawEffects() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const m of mist) {
      const at = toCanvas(m.x, m.y);
      ctx.beginPath();
      ctx.arc(at.x, at.y, S(m.r), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(134, 255, 198, ${Math.max(0, m.life) * 0.1})`;
      ctx.fill();
    }

    for (const r of rings) {
      const at = toCanvas(r.x, r.y);
      ctx.beginPath();
      ctx.ellipse(at.x, at.y, S(r.r), S(r.r) * 0.26, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(180, 255, 220, ${Math.max(0, r.life) * 0.55})`;
      ctx.lineWidth = Math.max(1, S(1.2));
      ctx.stroke();
    }

    for (const b of bubbles) {
      const at = toCanvas(b.x, b.y);
      ctx.beginPath();
      ctx.arc(at.x, at.y, S(b.r), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(214, 255, 240, ${Math.max(0, b.life) * 0.55})`;
      ctx.lineWidth = Math.max(0.8, S(0.7));
      ctx.stroke();
    }

    for (const e of ejecta) {
      const at = toCanvas(e.x, e.y);
      ctx.beginPath();
      ctx.arc(at.x, at.y, S(e.r), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(134, 255, 198, ${Math.max(0, e.life) * 0.85})`;
      ctx.fill();
    }

    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, state.width, state.height);
    drawEffects();
    drawColumn();
    drawPendant();
    drawDrops();
    drawSurface();
  }

  /* The SVG tank is filled by moving its clipped water rect, so the glass,
     the graduations and the etched readout stay on top of the liquid. */
  function syncTank() {
    const water = document.getElementById('tankWater');
    const line = document.getElementById('tankSurface');
    const y = surfaceY();
    if (water) {
      water.setAttribute('y', String(y));
      water.setAttribute('height', String(Math.max(0, TANK.y + TANK.h - y)));
    }
    if (line) line.setAttribute('transform', `translate(0 ${y - 604})`);
  }

  function frame(now) {
    if (!state.running) return;
    const dt = Math.min(0.05, (now - state.lastFrame) / 1000 || 0.016);
    state.lastFrame = now;
    step(dt);
    draw();
    syncTank();
    window.requestAnimationFrame(frame);
  }

  function start() {
    if (state.running || reduced.matches) return;
    state.running = true;
    state.lastFrame = performance.now();
    window.requestAnimationFrame(frame);
  }

  function stop() { state.running = false; }

  function renderStatic() {
    stop();
    state.level = 0.44;
    state.wave = 0;
    measure();
    ctx.clearRect(0, 0, state.width, state.height);
    drawColumn();
    drawSurface();
    syncTank();
  }

  window.FaucetWater = {
    setFlow(value) {
      state.flow = Math.max(0, Math.min(1, value));
      fixture.style.setProperty('--flow', String(0.2 + state.flow * 0.8));
      if (reduced.matches) renderStatic();
    },
    getFlow() { return state.flow; },
  };

  /* ── wiring ────────────────────────────────────────────────────────────── */

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      measure();
      if (reduced.matches) renderStatic();
    }, 120);
  });

  measure();
  /* Fonts and the boot overlay both shift layout; re-measure once settled. */
  window.setTimeout(measure, 400);
  window.setTimeout(measure, 1800);

  const visibility = new IntersectionObserver(
    (entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      if (visible && !reduced.matches) { measure(); start(); } else stop();
    },
    { threshold: 0.02 },
  );
  visibility.observe(canvas);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (!reduced.matches) start();
  });

  reduced.addEventListener('change', () => (reduced.matches ? renderStatic() : start()));

  if (reduced.matches) renderStatic();
  else start();
})();
