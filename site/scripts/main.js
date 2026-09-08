/* main.js — data in, page out. Loads faucet.json (the burn ledger the engine
   wrote) and build.json, binds them into the page, renders the burn log. */

(function () {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  async function loadJson(path, fallback) {
    try {
      const r = await fetch(path, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { data: await r.json(), source: 'live' };
    } catch (_) {
      return { data: fallback, source: 'bundled' };
    }
  }

  const num = (s) => Number(String(s).replace(/,/g, ''));

  function buildBindings(d, build) {
    const rule = (d.policy || [])[0] || { bps: 10000, label: '', intent: '' };
    const date = build.commitDate ? new Date(build.commitDate) : null;
    return {
      'project.name': d.project.name,
      'project.nameUpper': d.project.name.toUpperCase(),
      'project.tickerTag': `$${d.project.ticker}`,
      'project.launchpad': d.project.launchpad,
      'project.chain': d.project.chain,
      'project.tagline': d.project.tagline,
      'token.address': d.token.address || 'not yet deployed',
      'token.symbol': d.token.symbol,
      'native.symbol': d.native.symbol,
      'devWallet': d.devWallet || 'to be provided',
      'burnAddress': d.burnAddress,
      'chain.chainId': d.chain.chainId === null ? 'unset' : String(d.chain.chainId),
      'modeLabel': d.mode === 'live' ? 'on-chain' : d.mode === 'mock' ? 'mock chain, pre-launch' : 'none yet',
      'totals.ethSpentNum': d.totals.ethSpent,
      'totals.tokensBurnedNum': d.totals.tokensBurned,
      'totals.supplyBurnedPct': d.totals.supplyBurnedPct || '—',
      'totals.burns': String(d.totals.burns),
      'policy.buyback.pct': `${(rule.bps / 100).toFixed(2)}%`,
      'policy.buyback.label': rule.label,
      'policy.buyback.intent': rule.intent,
      'limits.gasReserve': d.limits.gasReserve,
      'limits.minBuyback': d.limits.minBuyback,
      'limits.slippagePct': `${(d.limits.slippageBps / 100).toFixed(2)}%`,
      'limits.deadline': String(d.limits.deadlineSeconds),
      'build.version': build.version || '0.0.0',
      'build.short': build.short || 'local',
      'build.branch': build.branch || 'local',
      'build.tests': String(build.tests || 0),
      'build.stage': d.mode === 'live' ? 'live' : 'pre-launch',
      'build.date': date && !Number.isNaN(date.valueOf()) ? date.toISOString().slice(0, 10) : 'today',
    };
  }

  function applyBindings(b) {
    document.querySelectorAll('[data-bind]').forEach((node) => {
      const v = b[node.dataset.bind];
      if (v === undefined) return;
      if (node.hasAttribute('data-count')) { node.dataset.target = v; node.textContent = '0'; }
      else node.textContent = v;
    });
  }

  function animateCount(node) {
    const final = String(node.dataset.target ?? '');
    const target = num(final);
    const settle = () => { node.textContent = final; };
    if (!Number.isFinite(target) || reduced) return settle();
    const decimals = (final.split('.')[1] || '').length;
    const start = performance.now();
    (function tick(now) {
      const t = Math.min(1, (now - start) / 1200);
      const e = 1 - Math.pow(1 - t, 3);
      if (t < 1) { node.textContent = (target * e).toFixed(decimals); requestAnimationFrame(tick); } else settle();
    })(start);
  }

  function initCounters() {
    const obs = new IntersectionObserver((entries, o) => {
      entries.forEach((en) => {
        const past = en.boundingClientRect.bottom < 0;
        if (!en.isIntersecting && !past) return;
        if (en.isIntersecting) animateCount(en.target); else en.target.textContent = String(en.target.dataset.target ?? '');
        o.unobserve(en.target);
      });
    }, { threshold: 0.5 });
    document.querySelectorAll('[data-count]').forEach((n) => obs.observe(n));
  }

  async function hashPolicy(policy) {
    const node = document.getElementById('policyHash');
    if (!node || !window.crypto?.subtle) return;
    const canonical = JSON.stringify(policy.map((r) => [r.bucket, r.bps]));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
    node.textContent = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    node.title = `sha256 of ${canonical}`;
  }

  function buildSparklines(d) {
    const burns = d.burns || [];
    if (burns.length === 0) return;
    let acc = 0;
    const series = {
      eth: burns.map((b) => Number(b.ethSpentRaw)),
      tokens: burns.map((b) => Number(b.tokensBurnedRaw)),
      cumulative: burns.map((b) => (acc += Number(b.tokensBurnedRaw))),
      gas: burns.map((b) => num(b.gas)),
    };
    document.querySelectorAll('[data-spark]').forEach((node) => {
      const v = series[node.dataset.spark];
      if (!v) return;
      const max = Math.max(...v), min = Math.min(...v), span = max - min || 1;
      node.innerHTML = v.map((x, i) => `<i style="--h:${v.length === 1 ? 100 : 30 + Math.round(((x - min) / span) * 70)}%;--d:${i * 60}ms" title="burn #${burns[i].id}"></i>`).join('');
    });
  }

  function renderLedger(d, source) {
    const body = document.getElementById('ledgerBody');
    const foot = document.getElementById('ledgerFoot');
    const meta = document.getElementById('ledgerMeta');
    if (!body) return;
    const burns = (d.burns || []).slice().reverse();
    if (burns.length === 0) { body.innerHTML = '<tr class="ledger__empty"><td colspan="8">No burns yet.</td></tr>'; return; }

    const eth = d.native.symbol, tok = d.token.symbol;
    const when = (iso) => iso.replace('T', ' ').slice(0, 16) + ' UTC';
    const txCell = (b) => b.explorerUrl
      ? `<a class="ledger__root" href="${b.explorerUrl}" rel="noopener" title="${b.txHash}">${b.txHash.slice(0, 12)}…${b.txHash.slice(-4)}</a>`
      : `<span class="ledger__root" title="${b.txHash}">${b.txHash.slice(0, 12)}…${b.txHash.slice(-4)}</span>${b.mode === 'mock' ? ' <span class="tag-mock">mock</span>' : ''}`;

    body.innerHTML = burns.map((b, i) => `
      <tr class="ledger__row" data-burn="${b.id}" style="animation-delay:${i * 50}ms">
        <td class="ledger__epoch">#${b.id}</td>
        <td>${when(b.timestamp)}</td>
        <td>${b.ethSpent} ${eth}</td>
        <td>${b.tokensBurned} ${tok}</td>
        <td>${b.slippageRealisedBps >= 0 ? '−' : '+'}${(Math.abs(b.slippageRealisedBps) / 100).toFixed(2)}%</td>
        <td>${b.gas}</td>
        <td>${txCell(b)}</td>
        <td><button class="ledger__toggle" type="button" aria-expanded="false" aria-controls="burn-${b.id}" aria-label="Details for burn ${b.id}">+</button></td>
      </tr>
      <tr class="ledger__detail" id="burn-${b.id}" hidden><td colspan="8">
        <div class="detail">
          <div class="detail__col"><h4>Swap</h4><dl class="detail__facts">
            <div><dt>Quote</dt><dd class="mono">${b.expectedOut} ${tok}</dd></div>
            <div><dt>Min out</dt><dd class="mono">${b.minOut} ${tok}</dd></div>
            <div><dt>Filled</dt><dd class="mono">${b.tokensBurned} ${tok}</dd></div>
          </dl></div>
          <div class="detail__col"><h4>Chain</h4><dl class="detail__facts">
            <div><dt>Block</dt><dd class="mono">${b.block.toLocaleString()}</dd></div>
            <div><dt>Tx</dt><dd class="mono hash">${b.txHash}</dd></div>
            <div><dt>Mode</dt><dd class="mono">${b.mode}</dd></div>
          </dl></div>
          <div class="detail__col"><h4>Recipient</h4><dl class="detail__facts">
            <div><dt>To</dt><dd class="mono hash">${d.burnAddress}</dd></div>
            <div><dt>Gas</dt><dd class="mono">${b.gas} ${eth}</dd></div>
          </dl></div>
          <div class="detail__actions">
            ${b.explorerUrl ? `<a class="btn btn--ghost btn--sm" href="${b.explorerUrl}" rel="noopener">Open on explorer</a>` : ''}
            <button class="btn btn--ghost btn--sm" type="button" data-verify-hash="${b.txHash}">Look up in verifier</button>
          </div>
        </div>
      </td></tr>`).join('');

    body.addEventListener('click', (ev) => {
      const t = ev.target.closest('.ledger__toggle');
      if (t) {
        const detail = document.getElementById(t.getAttribute('aria-controls'));
        const open = t.getAttribute('aria-expanded') === 'true';
        t.setAttribute('aria-expanded', String(!open)); t.textContent = open ? '+' : '−';
        t.closest('tr').classList.toggle('is-open', !open); detail.hidden = open; return;
      }
      const v = ev.target.closest('[data-verify-hash]');
      if (v && window.FaucetVerify) window.FaucetVerify.lookup(v.dataset.verifyHash);
    });

    if (meta) meta.textContent = `${burns.length} burns · ${source === 'live' ? 'data/faucet.json' : 'bundled snapshot'}`;
    if (foot) {
      foot.innerHTML = `Amounts in ${eth} and ${tok}. ` + (d.mode === 'mock'
        ? '<span class="tag-mock">mock</span> Pre-launch: these burns were produced against the engine\'s in-memory chain with deterministic rewards (seed 42), reproducible with <code>npm run cycle</code>. Transaction hashes are placeholders until the first live cycle.'
        : 'Every transaction hash links to the chain explorer.');
    }
  }

  function stamp(d, build, source) {
    const nav = document.getElementById('navBuild');
    if (nav) nav.textContent = `v${build.version || '0.1.0'} · ${build.short || 'local'}`;
    const footer = document.getElementById('footerBuild');
    if (footer) {
      const gen = d.generatedAt ? new Date(d.generatedAt).toISOString().replace('T', ' ').slice(0, 16) : 'unknown';
      const built = build.builtAt ? new Date(build.builtAt).toISOString().replace('T', ' ').slice(0, 16) : 'unknown';
      footer.textContent = `v${build.version} · commit ${build.short} on ${build.branch} · ${build.commitCount || 0} commits · built ${built} UTC on ${build.host || 'local'} · ledger ${gen} UTC (${source}) · ${build.tests} engine tests`;
    }
    const tank = document.getElementById('tankValue');
    if (tank) tank.textContent = `${d.totals.tokensBurned} ${d.token.symbol}`;
    const src = document.getElementById('statsSource');
    if (src) src.innerHTML = source === 'live' ? 'Source: <code>data/faucet.json</code>, written by <code>faucet burn --write-site</code>.' : 'Source: bundled snapshot. Serve over HTTP for the live file.';

    const pill = (id, ok, okText, noText) => { const n = document.getElementById(id); if (!n) return; n.textContent = ok ? okText : noText; n.className = `pill ${ok ? 'pill--ok' : ''}`; };
    pill('pillChain', d.chain.chainId !== null, 'set', 'unset');
    pill('pillToken', !!d.token.address, 'set', 'unset');
    pill('pillWallet', !!d.devWallet, 'set', 'unset');
    const mode = document.getElementById('pillMode');
    if (mode) { mode.textContent = d.mode === 'live' ? 'on-chain' : 'synthetic'; mode.className = `pill ${d.mode === 'live' ? 'pill--ok' : 'pill--warn'}`; }
  }

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
    stamp(data, build, source);
    hashPolicy(data.policy || []);
    if (window.FaucetFlow) window.FaucetFlow.init(data);
    if (window.FaucetVerify) window.FaucetVerify.init(data);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
