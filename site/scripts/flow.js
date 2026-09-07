/* ═══════════════════════════════════════════════════════════════════════════
   flow.js — the interactive fixtures: the valve handle, the pressure slider,
   the routing diagram and the four gauges.

   The split shown here is not hardcoded in this file. It is read from the
   policy the engine publishes, so this page cannot drift from what actually
   settles on chain.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const BPS = 10000;

  /* ── the valve handle ────────────────────────────────────────────────── */

  (function valve() {
    const handle = document.getElementById('valveHandle');
    const faucet = document.querySelector('.faucet');
    const readout = document.getElementById('flowReadout');
    if (!handle || !faucet) return;

    /* Three quarter-turns from shut to wide open, like a real tap. */
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
      if (window.FaucetWater) window.FaucetWater.setFlow(flow);
    }

    function pointerAngle(event) {
      const box = handle.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      return (Math.atan2(event.clientY - cy, event.clientX - cx) * 180) / Math.PI;
    }

    handle.addEventListener('pointerdown', (event) => {
      dragging = true;
      grabAngle = pointerAngle(event);
      grabTurn = turn;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      let delta = pointerAngle(event) - grabAngle;
      /* Unwrap across the ±180° seam so a drag through the top doesn't jump. */
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      turn = Math.max(0, Math.min(MAX_TURN, grabTurn + delta));
      apply();
    });

    const release = (event) => {
      if (!dragging) return;
      dragging = false;
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch (_) {
        /* capture may already be gone; nothing to release */
      }
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

  /* ── gauges ──────────────────────────────────────────────────────────── */

  function paintGauge(gauge, value, max) {
    const arcLength = Math.PI * 78; /* the semicircle in the gauge SVG */
    const ratio = Math.max(0, Math.min(1, value / max));
    gauge.style.setProperty('--arc', arcLength.toFixed(2));
    gauge.style.setProperty('--dash-offset', (arcLength * (1 - ratio)).toFixed(2));
    gauge.style.setProperty('--needle', `${(-90 + ratio * 180).toFixed(2)}deg`);
  }

  function initGauges() {
    const gauges = document.querySelectorAll('.gauge');
    gauges.forEach((gauge) => {
      const value = Number(gauge.dataset.value || 0);
      const max = Number(gauge.dataset.max || 100);
      paintGauge(gauge, value, max);
    });

    /* Sweep the needles only once they are actually on screen. */
    const observer = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-live');
          obs.unobserve(entry.target);
        });
      },
      { threshold: 0.4 },
    );

    gauges.forEach((gauge) => observer.observe(gauge));
  }

  /* ── the pressure panel ──────────────────────────────────────────────── */

  function initThroughput(policy) {
    const input = document.getElementById('throughput');
    const value = document.getElementById('throughputValue');
    const list = document.getElementById('loopOutputs');
    const checksum = document.getElementById('loopChecksum');
    const diagram = document.getElementById('flowDiagram');
    if (!input || !list) return;

    /* Work in lamports so the page splits money exactly the way the engine
       does — floats would show 9.999999999 where the engine shows 10. */
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
      allocations.forEach((allocation) => {
        const row = list.querySelector(`li[data-bucket="${allocation.bucket}"] .v`);
        if (row) row.textContent = fmt(allocation.amount);
        out += allocation.amount;
      });

      if (checksum) {
        const balanced = out === lamports;
        checksum.innerHTML =
          `<span class="loop__checksumOk" aria-hidden="true"></span> ` +
          (balanced
            ? `Balanced: <strong>${fmt(lamports)}</strong> in, <strong>${fmt(out)}</strong> out.`
            : `<strong>Leak detected.</strong> The engine would refuse to settle this epoch.`);
      }

      if (diagram) {
        /* More money moving means faster-running pipes. */
        const speed = Math.max(0.55, 3.2 - (sol / Number(input.max)) * 2.6);
        diagram.style.setProperty('--flow-speed', `${speed.toFixed(2)}s`);
      }
    }

    input.addEventListener('input', render);
    render();
  }

  /* ── outlet focus: hovering a bucket dims the other three ─────────────── */

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

  /* ── stream weights: a fatter pipe carries a bigger share ─────────────── */

  function weightStreams(policy) {
    policy.forEach((rule) => {
      document
        .querySelectorAll(`.flow__stream--out[data-bucket="${rule.bucket}"]`)
        .forEach((stream) => stream.style.setProperty('--weight', String(rule.bps / BPS)));
    });
  }

  window.FaucetFlow = {
    init(policy) {
      weightStreams(policy);
      document.querySelectorAll('.gauge').forEach((gauge) => {
        const card = gauge.closest('[data-bucket]');
        const rule = card && policy.find((r) => r.bucket === card.dataset.bucket);
        if (rule) gauge.dataset.value = String(rule.bps / 100);
      });
      initGauges();
      initThroughput(policy);
      initFocus();
    },
  };
})();
