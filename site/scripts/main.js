/* ═══════════════════════════════════════════════════════════════════════════
   main.js — data in, page out.

   Loads the engine's published epoch file, binds it into the page, renders the
   ledger and the ticker, and hands the routing policy to the diagram and the
   dials. Everything numeric on the page comes from here; nothing is typed
   into the markup twice.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  async function loadData() {
    try {
      const response = await fetch('data/faucet.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { data: await response.json(), source: 'live' };
    } catch (_) {
      /* file:// blocks fetch, and the JSON may not have been regenerated yet.
         Fall back to the baked-in snapshot rather than showing a broken page;
         the footer says which one is on screen. */
      return { data: window.FAUCET_FALLBACK, source: 'bundled' };
    }
  }

  /* ── bindings ────────────────────────────────────────────────────────────
     The engine already formatted these strings. Re-deriving them from raw
     lamports here would round where the engine truncates, and a page that
     disagrees with its own CLI by one digit is worse than useless.          */

  function buildBindings(data) {
    const policy = {};
    for (const rule of data.policy || []) {
      policy[rule.bucket] = { pct: `${(rule.bps / 100).toFixed(2)}%` };
    }

    const pct = (bucket) => (policy[bucket] ? policy[bucket].pct : '—');

    return {
      'project.name': data.project.name,
      'project.tickerTag': `$${data.project.ticker}`,
      'project.launchpad': data.project.launchpad,
      'project.tagline': data.project.tagline,
      'mint.address': data.mint.address || 'not yet minted — set at launch',
      'totals.recycledNum': data.totals.recycled,
      'totals.drippedNum': data.totals.dripped,
      'totals.burnedNum': data.totals.burned,
      'totals.epochs': String(data.totals.epochs),
      'totals.recipients': String(data.totals.recipients),
      'policy.buyback.pct': pct('buyback'),
      'policy.drip.pct': pct('drip'),
      'policy.liquidity.pct': pct('liquidity'),
      'policy.treasury.pct': pct('treasury'),
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
    const duration = 1500;
    const start = performance.now();

    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      /* Ease out cubic: quick off the mark, settles like a needle. */
      const eased = 1 - Math.pow(1 - t, 3);
      if (t < 1) {
        node.textContent = (target * eased).toFixed(decimals);
        window.requestAnimationFrame(tick);
      } else {
        settle();
      }
    }

    window.requestAnimationFrame(tick);
  }

  function initCounters() {
    const observer = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          /* Deep-linking past the stats must not leave a counter on zero, so
             anything already above the viewport is settled immediately. */
          const scrolledPast = entry.boundingClientRect.bottom < 0;
          if (!entry.isIntersecting && !scrolledPast) return;
          if (entry.isIntersecting) animateCount(entry.target);
          else entry.target.textContent = String(entry.target.dataset.target ?? '');
          obs.unobserve(entry.target);
        });
      },
      { threshold: 0.5 },
    );

    document.querySelectorAll('[data-count]').forEach((node) => observer.observe(node));
  }

  /* ── the tank readout, etched on the glass ───────────────────────────── */

  function fillTank(data) {
    const node = document.getElementById('tankValue');
    if (node) node.textContent = `${data.totals.recycled} ${data.native.symbol}`;
  }

  /* ── ledger ──────────────────────────────────────────────────────────── */

  function renderLedger(data, source) {
    const body = document.getElementById('ledgerBody');
    const foot = document.getElementById('ledgerFoot');
    if (!body) return;

    const epochs = (data.epochs || []).filter((e) => e.settled).slice().reverse();

    if (epochs.length === 0) {
      body.innerHTML = '<tr class="ledger__empty"><td colspan="9">No epoch has settled yet.</td></tr>';
      return;
    }

    const pick = (epoch, bucket) => (epoch.allocations || []).find((a) => a.bucket === bucket);
    const amount = (epoch, bucket) => { const a = pick(epoch, bucket); return a ? a.amount : '—'; };
    const width = (epoch, bucket) => { const a = pick(epoch, bucket); return a ? a.bps / 100 : 0; };

    body.innerHTML = epochs
      .map(
        (epoch, i) => `
        <tr style="animation-delay:${i * 70}ms">
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
        </tr>`,
      )
      .join('');

    if (foot) {
      const synthetic = !data.mint.address;
      foot.innerHTML =
        `All amounts in ${data.native.symbol}. ` +
        `${epochs.length} settled epoch${epochs.length === 1 ? '' : 's'}, ` +
        `${data.totals.recipients} distinct wallets paid. ` +
        (synthetic
          ? '<span class="tag-mock">synthetic</span> The token has not launched, so these epochs come from the engine\'s deterministic mock fee sources.'
          : 'Generated from on-chain fee vaults.') +
        ` Source: ${source === 'live' ? '<code>data/faucet.json</code>' : 'bundled snapshot'}.`;
    }
  }

  /* ── ticker ──────────────────────────────────────────────────────────── */

  function buildTicker(data) {
    if (!window.FaucetMotion) return;

    const items = [];
    const settled = (data.epochs || []).filter((e) => e.settled).slice().reverse();

    items.push(`<b>${data.project.name}</b> <span class="up">$${data.project.ticker}</span> &middot; ${data.project.launchpad}`);
    items.push(`FEES RECYCLED <b>${data.totals.recycled}</b> <span class="up">${data.native.symbol}</span>`);
    items.push(`DRIPPED <b>${data.totals.dripped}</b> ${data.native.symbol} &rarr; <b>${data.totals.recipients}</b> WALLETS`);
    items.push(`BURNED <span class="burn">${data.totals.burned} ${data.native.symbol}</span>`);

    for (const epoch of settled.slice(0, 6)) {
      items.push(
        `EPOCH <b>#${epoch.id}</b> &middot; ${epoch.collected} ${data.native.symbol} ` +
        `&middot; ROOT <span class="hash">${epoch.drip.root.slice(0, 14)}…</span>`,
      );
    }

    items.push('100.00% OF FEES ROUTED BACK &middot; <span class="up">CONSERVED</span>');
    window.FaucetMotion.buildTicker(items);
  }

  /* ── footer + provenance ─────────────────────────────────────────────── */

  function stampFooter(data, source) {
    const node = document.getElementById('footerGenerated');
    if (!node || !data.generatedAt) return;
    const when = new Date(data.generatedAt);
    const stamp = Number.isNaN(when.valueOf())
      ? data.generatedAt
      : when.toISOString().replace('T', ' ').slice(0, 16);
    node.textContent = `Epoch data generated ${stamp} UTC · ${source === 'live' ? 'live file' : 'bundled snapshot'}`;
  }

  function markSource(source) {
    const node = document.getElementById('statsSource');
    if (!node) return;
    node.innerHTML =
      source === 'live'
        ? 'Reading <code>site/data/faucet.json</code>, written by the engine.'
        : 'Reading the bundled snapshot — serve the site over HTTP for the live file.';
  }

  /* ── boot ────────────────────────────────────────────────────────────── */

  async function start() {
    const { data, source } = await loadData();
    if (!data) return;

    applyBindings(buildBindings(data));
    initCounters();
    fillTank(data);
    renderLedger(data, source);
    buildTicker(data);
    stampFooter(data, source);
    markSource(source);

    if (window.FaucetFlow) window.FaucetFlow.init(data.policy || []);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
