/* ═══════════════════════════════════════════════════════════════════════════
   main.js — data in, page out.

   Loads the engine's published epoch file and the build stamp, binds them
   into the page, renders the ledger and the ticker, and hands the routing
   policy to the diagram, the dials and the verifier. Nothing numeric on the
   page is typed into the markup twice.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  async function loadJson(path, fallback) {
    try {
      const response = await fetch(path, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { data: await response.json(), source: 'live' };
    } catch (_) {
      return { data: fallback, source: 'bundled' };
    }
  }

  /* ── bindings ────────────────────────────────────────────────────────── */

  function buildBindings(data, build) {
    const policy = {};
    for (const rule of data.policy || []) policy[rule.bucket] = `${(rule.bps / 100).toFixed(2)}%`;
    const pct = (bucket) => policy[bucket] || '—';

    const date = build.commitDate ? new Date(build.commitDate) : null;

    return {
      'project.name': data.project.name,
      'project.nameUpper': data.project.name.toUpperCase(),
      'project.tickerTag': `$${data.project.ticker}`,
      'project.launchpad': data.project.launchpad,
      'project.tagline': data.project.tagline,
      'mint.address': data.mint.address || 'not yet minted',
      'totals.recycledNum': data.totals.recycled,
      'totals.drippedNum': data.totals.dripped,
      'totals.burnedNum': data.totals.burned,
      'totals.epochs': String(data.totals.epochs),
      'totals.recipients': String(data.totals.recipients),
      'policy.buyback.pct': pct('buyback'),
      'policy.drip.pct': pct('drip'),
      'policy.liquidity.pct': pct('liquidity'),
      'policy.treasury.pct': pct('treasury'),
      'build.version': build.version || '0.0.0',
      'build.short': build.short || 'local',
      'build.branch': build.branch || 'local',
      'build.tests': String(build.tests || 0),
      'build.stage': data.mint.address ? 'live' : 'pre-launch',
      'build.date': date && !Number.isNaN(date.valueOf()) ? date.toISOString().slice(0, 10) : 'today',
    };
  }

  function applyBindings(bindings) {
    document.querySelectorAll('[data-bind]').forEach((node) => {
      const value = bindings[node.dataset.bind];
      if (value === undefined) return;
      if (node.hasAttribute('data-count')) {
        node.dataset.target = value;
        node.textContent = '0';
      } else {
        node.textContent = value;
      }
    });
  }

  /* ── counters ────────────────────────────────────────────────────────── */

  function animateCount(node) {
    const final = String(node.dataset.target ?? node.textContent ?? '');
    const target = Number(final.replace(/,/g, ''));
    const settle = () => { node.textContent = final; };
    if (!Number.isFinite(target) || reduced) { settle(); return; }

    const decimals = (final.split('.')[1] || '').length;
    const start = performance.now();
    function tick(now) {
      const t = Math.min(1, (now - start) / 1400);
      const eased = 1 - Math.pow(1 - t, 3);
      if (t < 1) { node.textContent = (target * eased).toFixed(decimals); window.requestAnimationFrame(tick); }
      else settle();
    }
    window.requestAnimationFrame(tick);
  }

  function initCounters() {
    const observer = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        const scrolledPast = entry.boundingClientRect.bottom < 0;
        if (!entry.isIntersecting && !scrolledPast) return;
        if (entry.isIntersecting) animateCount(entry.target);
        else entry.target.textContent = String(entry.target.dataset.target ?? '');
        obs.unobserve(entry.target);
      });
    }, { threshold: 0.5 });
    document.querySelectorAll('[data-count]').forEach((node) => observer.observe(node));
  }

  /* ── policy hash ─────────────────────────────────────────────────────────
     A fingerprint of the split as this page sees it. Anyone can recompute it
     from data/faucet.json and compare against a commit.                     */

  async function hashPolicy(policy) {
    const node = document.getElementById('policyHash');
    if (!node || !window.crypto || !window.crypto.subtle) return;
    const canonical = JSON.stringify(policy.map((r) => [r.bucket, r.bps]));
    const digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    node.textContent = hex.slice(0, 16);
    node.title = `sha256 of ${canonical}`;
  }

  /* ── sparklines ──────────────────────────────────────────────────────── */

  function buildSparklines(data) {
    const epochs = (data.epochs || []).filter((e) => e.settled);
    if (epochs.length === 0) return;

    let running = 0;
    const series = {
      collected: epochs.map((e) => Number(e.collectedRaw)),
      drip: epochs.map((e) => Number(e.drip.totalRaw)),
      burn: epochs.map((e) => Number((e.allocations.find((a) => a.bucket === 'buyback') || {}).amountRaw || 0)),
      epochs: epochs.map((e) => (running += Number(e.collectedRaw))),
    };

    document.querySelectorAll('[data-spark]').forEach((node) => {
      const values = series[node.dataset.spark];
      if (!values) return;
      const max = Math.max(...values);
      const min = Math.min(...values);
      const span = max - min || 1;
      node.innerHTML = values
        .map((v, i) => {
          const h = values.length === 1 ? 100 : 30 + Math.round(((v - min) / span) * 70);
          return `<i style="--h:${h}%;--d:${i * 60}ms" title="epoch ${epochs[i].id}"></i>`;
        })
        .join('');
    });
  }

  /* ── ledger, with expandable rows ────────────────────────────────────── */

  function renderLedger(data, source) {
    const body = document.getElementById('ledgerBody');
    const foot = document.getElementById('ledgerFoot');
    const meta = document.getElementById('ledgerMeta');
    if (!body) return;

    const epochs = (data.epochs || []).filter((e) => e.settled).slice().reverse();
    if (epochs.length === 0) {
      body.innerHTML = '<tr class="ledger__empty"><td colspan="10">No epoch has settled yet.</td></tr>';
      return;
    }

    const pick = (epoch, bucket) => (epoch.allocations || []).find((a) => a.bucket === bucket);
    const amount = (epoch, bucket) => { const a = pick(epoch, bucket); return a ? a.amount : '—'; };
    const width = (epoch, bucket) => { const a = pick(epoch, bucket); return a ? a.bps / 100 : 0; };
    const sym = data.native.symbol;

    body.innerHTML = epochs
      .map((epoch, i) => {
        const slots = epoch.window.toSlot - epoch.window.fromSlot;
        const sources = (epoch.sources || [])
          .map((s) => `<tr><td>${s.kind}</td><td class="num">${s.receipts}</td><td class="num">${s.total} ${sym}</td></tr>`)
          .join('');
        const allocations = (epoch.allocations || [])
          .map((a) => `<tr><td>${a.label}</td><td class="num">${(a.bps / 100).toFixed(2)}%</td><td class="num">${a.amount} ${sym}</td></tr>`)
          .join('');
        return `
        <tr class="ledger__row" data-epoch="${epoch.id}" style="animation-delay:${i * 60}ms">
          <td class="ledger__epoch">#${epoch.id}</td>
          <td>${epoch.collected}</td>
          <td>
            <span class="splitbar" role="img" aria-label="Split for epoch ${epoch.id}">
              <i style="width:${width(epoch, 'buyback')}%"></i>
              <i style="width:${width(epoch, 'drip')}%"></i>
              <i style="width:${width(epoch, 'liquidity')}%"></i>
              <i style="width:${width(epoch, 'treasury')}%"></i>
            </span>
          </td>
          <td>${amount(epoch, 'buyback')}</td>
          <td>${epoch.drip.total}</td>
          <td>${amount(epoch, 'liquidity')}</td>
          <td>${amount(epoch, 'treasury')}</td>
          <td>${epoch.drip.recipients}</td>
          <td class="ledger__root" title="${epoch.drip.root}">${epoch.drip.root.slice(0, 20)}&hellip;</td>
          <td><button class="ledger__toggle" type="button" aria-expanded="false" aria-controls="epoch-${epoch.id}" aria-label="Details for epoch ${epoch.id}">+</button></td>
        </tr>
        <tr class="ledger__detail" id="epoch-${epoch.id}" hidden>
          <td colspan="10">
            <div class="detail">
              <div class="detail__col">
                <h4>Window</h4>
                <dl class="detail__facts">
                  <div><dt>Slots</dt><dd class="mono">${epoch.window.fromSlot.toLocaleString()} → ${epoch.window.toSlot.toLocaleString()} <span>(${slots.toLocaleString()})</span></dd></div>
                  <div><dt>Closed</dt><dd class="mono">${epoch.closedAt.replace('T', ' ').slice(0, 19)} UTC</dd></div>
                  <div><dt>Root</dt><dd class="mono hash">${epoch.drip.root}</dd></div>
                </dl>
              </div>
              <div class="detail__col">
                <h4>Sources</h4>
                <table class="detail__table"><thead><tr><th>Adapter</th><th class="num">Receipts</th><th class="num">Total</th></tr></thead><tbody>${sources}</tbody></table>
              </div>
              <div class="detail__col">
                <h4>Allocation</h4>
                <table class="detail__table"><thead><tr><th>Bucket</th><th class="num">Share</th><th class="num">Amount</th></tr></thead><tbody>${allocations}</tbody></table>
              </div>
              <div class="detail__actions">
                <a class="btn btn--ghost btn--sm" href="data/claims/epoch-${epoch.id}.json">Claim file</a>
                <button class="btn btn--ghost btn--sm" type="button" data-verify-epoch="${epoch.id}">Verify a wallet in this epoch</button>
              </div>
            </div>
          </td>
        </tr>`;
      })
      .join('');

    body.addEventListener('click', (event) => {
      const toggle = event.target.closest('.ledger__toggle');
      if (toggle) {
        const detail = document.getElementById(toggle.getAttribute('aria-controls'));
        const open = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!open));
        toggle.textContent = open ? '+' : '−';
        toggle.closest('tr').classList.toggle('is-open', !open);
        detail.hidden = open;
        return;
      }
      const verify = event.target.closest('[data-verify-epoch]');
      if (verify && window.FaucetVerify) window.FaucetVerify.focusEpoch(Number(verify.dataset.verifyEpoch));
    });

    if (meta) meta.textContent = `${epochs.length} epochs · ${source === 'live' ? 'data/faucet.json' : 'bundled snapshot'}`;

    if (foot) {
      const synthetic = !data.mint.address;
      foot.innerHTML =
        `Amounts in ${sym}. ${data.totals.recipients} distinct wallets paid across ${epochs.length} epochs. ` +
        (synthetic
          ? '<span class="tag-mock">synthetic</span> Pre-launch: these epochs come from the engine\'s deterministic mock fee sources (seed 42), so they are reproducible with <code>npm run cycle</code>.'
          : 'Generated from on-chain fee vaults.');
    }
  }

  /* ── ticker ──────────────────────────────────────────────────────────── */

  function buildTicker(data, build) {
    if (!window.FaucetMotion) return;
    const settled = (data.epochs || []).filter((e) => e.settled).slice().reverse();
    const items = [
      `<b>${data.project.name}</b> <span class="up">$${data.project.ticker}</span> · ${data.project.launchpad}`,
      `RECYCLED <b>${data.totals.recycled}</b> <span class="up">${data.native.symbol}</span>`,
      `DRIPPED <b>${data.totals.dripped}</b> ${data.native.symbol} → <b>${data.totals.recipients}</b> WALLETS`,
      `BURNED <span class="burn">${data.totals.burned} ${data.native.symbol}</span>`,
    ];
    for (const epoch of settled.slice(0, 6)) {
      items.push(`EPOCH <b>#${epoch.id}</b> · ${epoch.collected} ${data.native.symbol} · ROOT <span class="hash">${epoch.drip.root.slice(0, 14)}…</span>`);
    }
    items.push(`ENGINE v${build.version || '0.1.0'} · ${build.tests || 0} TESTS · BUILD <span class="hash">${build.short || 'local'}</span>`);
    window.FaucetMotion.buildTicker(items);
  }

  /* ── stamps ──────────────────────────────────────────────────────────── */

  function stampBuild(data, build, sources) {
    const nav = document.getElementById('navBuild');
    if (nav) nav.textContent = `v${build.version || '0.1.0'} · ${build.short || 'local'}`;

    const footer = document.getElementById('footerBuild');
    if (footer) {
      const gen = data.generatedAt ? new Date(data.generatedAt).toISOString().replace('T', ' ').slice(0, 16) : 'unknown';
      const built = build.builtAt ? new Date(build.builtAt).toISOString().replace('T', ' ').slice(0, 16) : 'unknown';
      footer.textContent =
        `v${build.version} · commit ${build.short} on ${build.branch} · ${build.commitCount || 0} commits · ` +
        `built ${built} UTC on ${build.host || 'local'} · epoch data ${gen} UTC (${sources.data}) · ` +
        `${build.tests} engine tests`;
    }

    const tank = document.getElementById('tankValue');
    if (tank) tank.textContent = `${data.totals.recycled} ${data.native.symbol}`;

    const statsSource = document.getElementById('statsSource');
    if (statsSource) {
      statsSource.innerHTML = sources.data === 'live'
        ? 'Source: <code>data/faucet.json</code>, written by <code>faucet cycle</code>.'
        : 'Source: bundled snapshot. Serve over HTTP for the live file.';
    }
  }

  /* ── boot ────────────────────────────────────────────────────────────── */

  async function start() {
    const [{ data, source }, { data: build }] = await Promise.all([
      loadJson('data/faucet.json', window.FAUCET_FALLBACK),
      loadJson('data/build.json', { version: '0.1.0', short: 'local', branch: 'local', tests: 0 }),
    ]);
    if (!data) return;

    applyBindings(buildBindings(data, build));
    initCounters();
    buildSparklines(data);
    renderLedger(data, source);
    buildTicker(data, build);
    stampBuild(data, build, { data: source });
    hashPolicy(data.policy || []);

    if (window.FaucetFlow) window.FaucetFlow.init(data.policy || []);
    if (window.FaucetVerify) window.FaucetVerify.init(data);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
