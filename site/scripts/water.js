/* ═══════════════════════════════════════════════════════════════════════════
   water.js — the droplet simulation behind the hero fixture.

   The faucet is an SVG; the water is a canvas sitting behind it. The two are
   kept in register by mapping the SVG's viewBox coordinates into canvas pixels
   every resize, so the stream always leaves the aerator and always lands in the
   tank no matter how the layout reflows.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const canvas = document.getElementById('waterCanvas');
  const fixture = document.querySelector('.faucet');
  if (!canvas || !fixture) return;

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* Anchor points, in the faucet's own viewBox coordinates. */
  const VIEWBOX = { w: 420, h: 520 };
  const SPOUT = { x: 321, y: 404 };
  const TANK = { x: 238, y: 418, w: 150, h: 92 };

  const state = {
    dpr: 1,
    width: 0,
    height: 0,
    /* Mapping from viewBox units into canvas pixels. */
    scale: 1,
    originX: 0,
    originY: 0,
    /* 0..1, driven by the valve handle. */
    flow: 0.72,
    /* Smoothed tank level, 0..1. */
    level: 0,
    levelTarget: 0.34,
    emitAccumulator: 0,
    lastFrame: 0,
    running: false,
  };

  const drops = [];
  const splashes = [];
  const ripples = [];

  const MAX_DROPS = 220;
  const MAX_SPLASHES = 320;

  function toCanvas(x, y) {
    return { x: state.originX + x * state.scale, y: state.originY + y * state.scale };
  }

  function measure() {
    const canvasBox = canvas.getBoundingClientRect();
    const fixtureBox = fixture.getBoundingClientRect();

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

  function spawnDrop() {
    if (drops.length >= MAX_DROPS) return;
    const spout = toCanvas(SPOUT.x, SPOUT.y);
    const jitter = (Math.random() - 0.5) * 3.2 * state.scale;
    drops.push({
      x: spout.x + jitter,
      y: spout.y,
      vx: jitter * 0.06,
      vy: 40 + Math.random() * 90,
      r: (1.5 + Math.random() * 2.6) * state.scale,
      life: 0,
    });
  }

  function splash(x, y) {
    const count = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < count; i++) {
      if (splashes.length >= MAX_SPLASHES) break;
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.1;
      const speed = (45 + Math.random() * 110) * Math.max(state.scale, 0.4);
      splashes.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: (0.8 + Math.random() * 1.5) * state.scale,
        life: 1,
      });
    }
    ripples.push({ x, y, r: 2 * state.scale, life: 1 });
  }

  function surfaceY() {
    return TANK.y + TANK.h * (1 - state.level);
  }

  function step(dt) {
    /* Emit at a rate proportional to flow; below a trickle it becomes discrete
       drips rather than a stream, which is what a nearly-closed tap does. */
    const rate = state.flow * 46;
    state.emitAccumulator += rate * dt;
    while (state.emitAccumulator >= 1) {
      state.emitAccumulator -= 1;
      spawnDrop();
    }

    const surface = toCanvas(TANK.x, surfaceY()).y;
    const tankLeft = toCanvas(TANK.x, TANK.y).x;
    const tankRight = toCanvas(TANK.x + TANK.w, TANK.y).x;

    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.vy += 1500 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.life += dt;

      if (d.y >= surface) {
        if (d.x > tankLeft && d.x < tankRight) splash(d.x, surface);
        drops.splice(i, 1);
      } else if (d.life > 4) {
        drops.splice(i, 1);
      }
    }

    for (let i = splashes.length - 1; i >= 0; i--) {
      const s = splashes[i];
      s.vy += 1100 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= dt * 1.9;
      if (s.life <= 0) splashes.splice(i, 1);
    }

    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.r += 46 * state.scale * dt;
      r.life -= dt * 2.4;
      if (r.life <= 0) ripples.splice(i, 1);
    }

    /* The tank rises with flow and slowly drains, so the level reads as a rate
       rather than a total — an idle tap settles back down. */
    state.levelTarget = Math.min(0.92, 0.12 + state.flow * 0.72);
    state.level += (state.levelTarget - state.level) * Math.min(1, dt * 1.4);
  }

  function drawStream() {
    if (state.flow < 0.16) return;

    const spout = toCanvas(SPOUT.x, SPOUT.y);
    const surface = toCanvas(TANK.x, surfaceY()).y;
    const width = (1.4 + state.flow * 5.2) * state.scale;
    const t = performance.now() / 260;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const gradient = ctx.createLinearGradient(spout.x, spout.y, spout.x, surface);
    gradient.addColorStop(0, 'rgba(123, 255, 192, 0.9)');
    gradient.addColorStop(0.5, 'rgba(0, 224, 122, 0.75)');
    gradient.addColorStop(1, 'rgba(0, 168, 92, 0.15)');

    ctx.beginPath();
    ctx.moveTo(spout.x - width / 2, spout.y);
    /* Wobble both edges out of phase so the column looks like moving liquid. */
    for (let y = spout.y; y <= surface; y += 6) {
      const p = (y - spout.y) / Math.max(1, surface - spout.y);
      const wobble = Math.sin(y * 0.06 + t) * 1.7 * state.scale * (0.35 + p);
      ctx.lineTo(spout.x - width / 2 + wobble - p * width * 0.16, y);
    }
    for (let y = surface; y >= spout.y; y -= 6) {
      const p = (y - spout.y) / Math.max(1, surface - spout.y);
      const wobble = Math.cos(y * 0.055 + t * 1.1) * 1.7 * state.scale * (0.35 + p);
      ctx.lineTo(spout.x + width / 2 + wobble + p * width * 0.16, y);
    }
    ctx.closePath();

    ctx.fillStyle = gradient;
    ctx.shadowColor = 'rgba(0, 224, 122, 0.55)';
    ctx.shadowBlur = 18 * state.scale;
    ctx.fill();
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, state.width, state.height);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    /* ripples on the surface */
    for (const r of ripples) {
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, r.r, r.r * 0.28, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(168, 255, 212, ${Math.max(0, r.life) * 0.5})`;
      ctx.lineWidth = 1.2 * state.scale;
      ctx.stroke();
    }

    for (const d of drops) {
      /* Stretch each drop along its velocity — a falling drop is a teardrop. */
      const stretch = Math.min(3.2, 1 + Math.abs(d.vy) / 420);
      ctx.beginPath();
      ctx.ellipse(d.x, d.y, d.r, d.r * stretch, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 224, 122, 0.85)';
      ctx.shadowColor = 'rgba(0, 224, 122, 0.7)';
      ctx.shadowBlur = 10 * state.scale;
      ctx.fill();
    }

    ctx.shadowBlur = 0;

    for (const s of splashes) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(123, 255, 192, ${Math.max(0, s.life) * 0.8})`;
      ctx.fill();
    }

    ctx.restore();

    drawStream();
  }

  function syncTankSvg() {
    const water = document.getElementById('tankWater');
    const surfaceLine = document.getElementById('tankSurface');
    const y = surfaceY();
    if (water) {
      water.setAttribute('y', String(y));
      water.setAttribute('height', String(Math.max(0, TANK.y + TANK.h - y)));
    }
    if (surfaceLine) {
      surfaceLine.setAttribute('transform', `translate(0 ${y - 510})`);
    }
  }

  function frame(now) {
    if (!state.running) return;
    const dt = Math.min(0.05, (now - state.lastFrame) / 1000 || 0.016);
    state.lastFrame = now;
    step(dt);
    draw();
    syncTankSvg();
    requestAnimationFrame(frame);
  }

  function start() {
    if (state.running) return;
    state.running = true;
    state.lastFrame = performance.now();
    requestAnimationFrame(frame);
  }

  function stop() {
    state.running = false;
  }

  /* Static, honest fallback for reduced motion: fill the tank, draw nothing that moves. */
  function renderStatic() {
    stop();
    state.level = 0.62;
    ctx.clearRect(0, 0, state.width, state.height);
    syncTankSvg();
    drawStream();
  }

  /* ── public hook, used by the valve handle in flow.js ── */
  window.FaucetWater = {
    setFlow(value) {
      state.flow = Math.max(0, Math.min(1, value));
      fixture.style.setProperty('--flow', String(0.25 + state.flow * 0.75));
      if (reduced.matches) renderStatic();
    },
    getFlow() {
      return state.flow;
    },
  };

  const onResize = throttle(() => {
    measure();
    if (reduced.matches) renderStatic();
  }, 120);

  measure();

  /* Don't burn a render loop on a hero that has scrolled away. */
  const visibility = new IntersectionObserver(
    (entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (visible && !reduced.matches) start();
      else stop();
    },
    { threshold: 0.02 },
  );
  visibility.observe(canvas);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (!reduced.matches) start();
  });

  window.addEventListener('resize', onResize);
  reduced.addEventListener('change', () => (reduced.matches ? renderStatic() : start()));

  if (reduced.matches) renderStatic();
  else start();

  function throttle(fn, ms) {
    let last = 0;
    let timer = null;
    return function throttled() {
      const now = Date.now();
      const wait = ms - (now - last);
      if (wait <= 0) {
        last = now;
        fn();
      } else if (timer === null) {
        timer = window.setTimeout(() => {
          timer = null;
          last = Date.now();
          fn();
        }, wait);
      }
    };
  }
})();
