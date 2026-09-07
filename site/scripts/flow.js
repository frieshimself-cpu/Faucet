/* ═══════════════════════════════════════════════════════════════════════════
   flow.js — the interactive hardware: the valve handle, the routing diagram's
   particle flow, the four dials, and the pressure test.

   The split shown here is never hardcoded. It is read from the policy the
   engine publishes, so this page cannot drift from what actually settles.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const BPS = 10000;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  const BUCKET_COLOR = {
    inlet:     [0, 224, 122],
    buyback:   [255, 138, 91],
    drip:      [0, 224, 122],
    liquidity: [75, 215, 255],
    treasury:  [233, 189, 139],
  };

  /* ── the valve handle ────────────────────────────────────────────────────
     Three quarter-turns from shut to wide open, like a real tap. Drag it, or
     focus it and use the arrows — both drive the same water simulation.     */

  (function valve() {
    const handle = document.getElementById('valveHandle');
    const faucet = document.getElementById('faucet');
    const readout = document.getElementById('flowReadout');
    const led = document.querySelector('.fixture__led');
    if (!handle || !faucet) return;

    const MAX_TURN = 270;
    let turn = 0.72 * MAX_TURN;
    let dragging = false;
    let grabAngle = 0;
    let grabTurn = 0;

    function apply() {
      const flow = turn / MAX_TURN;
      faucet.style.setProperty('--valve-turn', `${turn}deg`);
      handle.setAttribute('aria-valuenow', String(Math.round(flow * 100)));
      if (readout) readout.textContent = `${Math.round(flow * 100)}%`;
      if (led) led.style.background = flow < 0.05 ? 'var(--burn)' : 'var(--water)';
      if (window.FaucetWater) window.FaucetWater.setFlow(flow);
    }

    function angleOf(event) {
      const box = handle.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      return (Math.atan2(event.clientY - cy, event.clientX - cx) * 180) / Math.PI;
    }

    handle.addEventListener('pointerdown', (event) => {
      dragging = true;
      grabAngle = angleOf(event);
      grabTurn = turn;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      let delta = angleOf(event) - grabAngle;
      /* Unwrap across the ±180° seam so dragging through the top doesn't jump. */
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      turn = Math.max(0, Math.min(MAX_TURN, grabTurn + delta));
      apply();
    });

    const release = (event) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(event.pointerId); } catch (_) { /* already released */ }
    };

    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);

    handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 27 : 13.5;
      const moves = {
        ArrowRight: step, ArrowUp: step,
        ArrowLeft: -step, ArrowDown: -step,
        Home: -MAX_TURN, End: MAX_TURN,
      };
      const move = moves[event.key];
      if (move === undefined) return;
      turn = Math.max(0, Math.min(MAX_TURN, turn + move));
      apply();
      event.preventDefault();
    });

    apply();
  })();

  /* ── dials ───────────────────────────────────────────────────────────────
     A dial is an arc, a swept needle, and a tick ring. The needle keeps a
     small live jitter after it settles, because an instrument reading a live
     line is never perfectly still — that detail is most of the realism.     */

  const ARC_LENGTH = Math.PI * 82;

  function buildTicks(dial) {
    const group = dial.querySelector('.dial__ticks');
    if (!group || group.childElementCount > 0) return;
    const svgNS = 'http://www.w3.org/2000/svg';

    for (let i = 0; i <= 20; i++) {
      const angle = Math.PI + (i / 20) * Math.PI;
      const major = i % 5 === 0;
      const inner = major ? 62 : 68;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', String(110 + Math.cos(angle) * inner));
      line.setAttribute('y1', String(128 + Math.sin(angle) * inner));
      line.setAttribute('x2', String(110 + Math.cos(angle) * 74));
      line.setAttribute('y2', String(128 + Math.sin(angle) * 74));
      if (major) line.setAttribute('class', 'major');
      group.appendChild(line);
    }
  }

  function paintDial(dial, value, max) {
    const ratio = Math.max(0, Math.min(1, value / max));
    dial.style.setProperty('--arc', ARC_LENGTH.toFixed(2));
    dial.style.setProperty('--dash-offset', (ARC_LENGTH * (1 - ratio)).toFixed(2));
    dial.dataset.base = String(-90 + ratio * 180);
    dial.style.setProperty('--needle', `${(-90 + ratio * 180).toFixed(2)}deg`);
  }

  function initDials() {
    const dials = Array.from(document.querySelectorAll('.dial'));
    dials.forEach((dial) => {
      buildTicks(dial);
      paintDial(dial, Number(dial.dataset.value || 0), Number(dial.dataset.max || 100));
    });

    const observer = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-live');
        /* The sweep is a CSS transition; the jitter below writes an inline
           transform every frame. Leaving the transition on would restart it on
           every write and the needle would never arrive, so hand over only
           once the sweep has finished. */
        window.setTimeout(() => entry.target.classList.add('is-settled'), 1600);
        obs.unobserve(entry.target);
      });
    }, { threshold: 0.35 });

    dials.forEach((d) => observer.observe(d));

    if (reduced.matches) return;

    /* Needle jitter. Slow, tiny, and out of phase per dial. */
    const needles = dials.map((dial, i) => ({
      dial,
      needle: dial.querySelector('.dial__needle'),
      phase: i * 1.7,
    }));

    let running = true;
    const jitter = () => {
      if (!running) return;
      const t = performance.now() / 1000;
      for (const n of needles) {
        if (!n.dial.classList.contains('is-settled') || !n.needle) continue;
        const base = Number(n.dial.dataset.base || 0);
        const wobble =
          Math.sin(t * 1.7 + n.phase) * 0.55 +
          Math.sin(t * 4.3 + n.phase * 2.1) * 0.22;
        n.needle.style.transform = `rotate(${(base + wobble).toFixed(3)}deg)`;
      }
      window.requestAnimationFrame(jitter);
    };

    /* Only spend frames on this while the console is on screen. */
    const consoleEl = document.getElementById('console');
    if (consoleEl) {
      new IntersectionObserver((entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible && !running) { running = true; window.requestAnimationFrame(jitter); }
        running = visible;
        if (visible) window.requestAnimationFrame(jitter);
      }, { threshold: 0.05 }).observe(consoleEl);
    }
  }

  /* ── particles riding the pipe paths ─────────────────────────────────────
     The dashed SVG strokes give the pipes a body of water; these are the
     discrete droplets inside it. They are sampled straight off the same path
     geometry with getPointAtLength, so they can never drift out of the pipe. */

  function initParticles(policy) {
    const svg = document.getElementById('flowDiagram');
    const canvas = document.getElementById('flowParticles');
    if (!svg || !canvas || reduced.matches) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const share = Object.fromEntries(policy.map((r) => [r.bucket, r.bps / BPS]));

    const streams = Array.from(svg.querySelectorAll('.flow__stream')).map((path) => {
      const bucket = path.dataset.bucket || 'inlet';
      const weight = bucket === 'inlet' ? 0.5 : (share[bucket] ?? 0.25);
      return {
        path,
        bucket,
        length: path.getTotalLength(),
        color: BUCKET_COLOR[bucket] || BUCKET_COLOR.inlet,
        /* More of the flow means more droplets and fatter ones. */
        count: Math.max(6, Math.round(10 + weight * 34)),
        size: 1.4 + weight * 3.4,
        drops: [],
      };
    });

    for (const s of streams) {
      s.drops = Array.from({ length: s.count }, () => ({
        at: Math.random() * s.length,
        speed: 92 + Math.random() * 70,
        r: s.size * (0.55 + Math.random() * 0.7),
      }));
    }

    let dpr = 1;
    let scale = 1;
    let originX = 0;
    let originY = 0;
    let speedScale = 1;
    let running = false;
    let last = 0;

    function measure() {
      const box = svg.getBoundingClientRect();
      if (box.width === 0) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);

      canvas.style.width = `${box.width}px`;
      canvas.style.height = `${box.height}px`;
      canvas.width = Math.round(box.width * dpr);
      canvas.height = Math.round(box.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const vb = svg.viewBox.baseVal;
      scale = Math.min(box.width / vb.width, box.height / vb.height);
      originX = (box.width - vb.width * scale) / 2;
      originY = (box.height - vb.height * scale) / 2;
    }

    function frame(now) {
      if (!running) return;
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'lighter';

      for (const s of streams) {
        const [r, g, b] = s.color;
        for (const d of s.drops) {
          d.at += d.speed * speedScale * dt;
          if (d.at > s.length) d.at -= s.length;

          const p = s.path.getPointAtLength(d.at);
          const x = originX + p.x * scale;
          const y = originY + p.y * scale;
          const radius = d.r * scale;

          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.85)`;
          ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.9)`;
          ctx.shadowBlur = radius * 4;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(x - radius * 0.28, y - radius * 0.28, radius * 0.34, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
          ctx.shadowBlur = 0;
          ctx.fill();
        }
      }

      window.requestAnimationFrame(frame);
    }

    measure();
    window.addEventListener('resize', () => window.setTimeout(measure, 80));

    new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      if (visible && !running) {
        running = true;
        last = performance.now();
        measure();
        window.requestAnimationFrame(frame);
      } else if (!visible) {
        running = false;
      }
    }, { threshold: 0.05 }).observe(svg);

    return { setSpeed(v) { speedScale = v; } };
  }

  /* ── pressure test ───────────────────────────────────────────────────────
     Allocation is done in BigInt with the same largest-remainder method the
     engine uses, so the figures on this panel are the figures that would
     settle — not a float approximation of them.                             */

  function initThroughput(policy, particles) {
    const input = document.getElementById('throughput');
    const value = document.getElementById('throughputValue');
    const list = document.getElementById('loopOutputs');
    const checksum = document.getElementById('loopChecksum');
    const diagram = document.getElementById('flowDiagram');
    if (!input || !list) return;

    function allocate(lamports) {
      const rows = policy.map((rule) => {
        const numerator = lamports * BigInt(rule.bps);
        return { rule, floor: numerator / BigInt(BPS), remainder: numerator % BigInt(BPS) };
      });

      let leftover = lamports - rows.reduce((sum, row) => sum + row.floor, 0n);
      const bonus = new Map();

      [...rows]
        .sort((a, b) => (a.remainder === b.remainder ? 0 : a.remainder > b.remainder ? -1 : 1))
        .forEach((row) => {
          if (leftover <= 0n) return;
          bonus.set(row.rule.bucket, 1n);
          leftover -= 1n;
        });

      return rows.map((row) => ({
        bucket: row.rule.bucket,
        bps: row.rule.bps,
        amount: row.floor + (bonus.get(row.rule.bucket) || 0n),
      }));
    }

    const fmt = (lamports) => (Number(lamports) / 1e9).toFixed(4);

    function render() {
      const sol = Number(input.value);
      const lamports = BigInt(Math.round(sol * 1e9));
      const allocations = allocate(lamports);

      if (value) value.textContent = sol.toFixed(2);

      const pct = ((sol - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
      input.style.setProperty('--pct', `${pct.toFixed(1)}%`);

      let out = 0n;
      for (const allocation of allocations) {
        const row = list.querySelector(`li[data-bucket="${allocation.bucket}"]`);
        if (row) {
          row.querySelector('.v').textContent = fmt(allocation.amount);
          row.querySelector('.bar').style.setProperty('--w', `${(allocation.bps / 100).toFixed(2)}%`);
        }
        out += allocation.amount;
      }

      if (checksum) {
        checksum.innerHTML =
          '<span class="loop__checksumOk" aria-hidden="true"></span> ' +
          (out === lamports
            ? `Balanced: <strong>${fmt(lamports)}</strong> in, <strong>${fmt(out)}</strong> out.`
            : '<strong>Leak detected.</strong> The engine would refuse to settle this epoch.');
      }

      /* More money moving means faster-running pipes, in both the dashes and
         the droplets, so the two never disagree about the rate. */
      const load = sol / Number(input.max);
      if (diagram) diagram.style.setProperty('--flow-speed', `${Math.max(0.5, 3.2 - load * 2.7).toFixed(2)}s`);
      if (particles) particles.setSpeed(0.55 + load * 2.6);
    }

    input.addEventListener('input', render);
    render();
  }

  /* ── outlet focus ────────────────────────────────────────────────────────
     Hovering a bucket anywhere — diagram, panel row or dial — dims the other
     three across the whole page, so the four views read as one instrument.  */

  function initFocus() {
    const diagram = document.getElementById('flowDiagram');
    if (!diagram) return;

    const targets = document.querySelectorAll('[data-bucket]');

    function focus(bucket) {
      diagram.classList.toggle('is-focused', bucket !== null);
      targets.forEach((node) => {
        node.classList.toggle('is-focused', bucket !== null && node.dataset.bucket === bucket);
      });
    }

    targets.forEach((node) => {
      node.addEventListener('mouseenter', () => focus(node.dataset.bucket));
      node.addEventListener('mouseleave', () => focus(null));
      node.addEventListener('focusin', () => focus(node.dataset.bucket));
      node.addEventListener('focusout', () => focus(null));
    });
  }

  function weightStreams(policy) {
    for (const rule of policy) {
      document
        .querySelectorAll(`.flow__stream--out[data-bucket="${rule.bucket}"]`)
        .forEach((stream) => stream.style.setProperty('--weight', String(rule.bps / BPS)));
    }
  }

  window.FaucetFlow = {
    init(policy) {
      if (!policy || policy.length === 0) return;
      weightStreams(policy);

      document.querySelectorAll('.dial').forEach((dial) => {
        const card = dial.closest('[data-bucket]');
        const rule = card && policy.find((r) => r.bucket === card.dataset.bucket);
        if (rule) dial.dataset.value = String(rule.bps / 100);
      });

      const total = policy.reduce((sum, r) => sum + r.bps, 0);
      const sum = document.getElementById('manifoldSum');
      if (sum) sum.textContent = `${(total / 100).toFixed(2)}% ROUTED`;

      initDials();
      const particles = initParticles(policy);
      initThroughput(policy, particles);
      initFocus();
    },
  };
})();
