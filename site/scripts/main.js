/* ═══════════════════════════════════════════════════════════════════════════
   main.js — data binding, the ledger, and the small page behaviours.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── loading ─────────────────────────────────────────────────────────── */

  async function loadData() {
    try {
      const response = await fetch('data/faucet.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const live = await response.json();
      return { data: live, source: 'live' };
    } catch (_) {
      /* file:// or a missing file — fall back to the baked-in copy rather than
         showing a broken page. The footer says which one is on screen. */
      return { data: window.FAUCET_FALLBACK, source: 'bundled' };
    }
  }

  /* ── view model ──────────────────────────────────────────────────────── */

  function buildBindings(data) {
    const policy = {};

    (data.policy || []).forEach((rule) => {
      policy[rule.bucket] = {
        pct: `${(rule.bps / 100).toFixed(2)}%`,
        label: rule.label,
        intent: rule.intent,
      };
    });

    return {
      'project.name': data.project.name,
      'project.tickerTag': `$${data.project.ticker}`,
      'project.launchpad': data.project.launchpad,
      'project.tagline': data.project.tagline,
      'mint.address': data.mint.address || 'not yet minted — set at launch',
      /* Use the strings the engine itself formatted. Re-deriving them here
         from the raw lamports rounds where the engine truncates, and a page
         that disagrees with its own CLI by one digit is worse than useless. */
      'totals.recycledNum': data.totals.recycled,
      'totals.drippedNum': data.totals.dripped,
      'totals.burnedNum': data.totals.burned,
      'totals.epochs': String(data.totals.epochs),
      'totals.recipients': String(data.totals.recipients),
      'policy.buyback.pct': policy.buyback ? policy.buyback.pct : '—',
      'policy.drip.pct': policy.drip ? policy.drip.pct : '—',
      'policy.liquidity.pct': policy.liquidity ? policy.liquidity.pct : '—',
      'policy.treasury.pct': policy.treasury ? policy.treasury.pct : '—',
    };
  }

  function applyBindings(bindings) {
    document.querySelectorAll('[data-bind]').forEach((node) => {
      const value = bindings[node.dataset.bind];
      if (value === undefined) return;
      if (node.hasAttribute('data-count')) {
        node.dataset.target = value;
        node.textContent = '0';
      } else if (node.namespaceURI === 'http://www.w3.org/2000/svg') {
        node.textContent = value;
      } else {
        node.textContent = value;
      }
    });
  }

  /* ── counters ────────────────────────────────────────────────────────── */

  function animateCount(node) {
    const final = String(node.dataset.target ?? node.textContent ?? '');
    /* The engine's formatter groups thousands; strip separators to parse. */
    const target = Number(final.replace(/,/g, ''));

    const settle = () => {
      node.textContent = final;
    };

    if (!Number.isFinite(target) || reduced) {
      settle();
      return;
    }

    const decimals = (final.split('.')[1] || '').length;
    const duration = 1300;
    const start = performance.now();

    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      /* Ease out cubic: fast at first, settles gently — reads like a gauge. */
      const eased = 1 - Math.pow(1 - t, 3);
      if (t < 1) {
        node.textContent = (target * eased).toFixed(decimals);
        requestAnimationFrame(tick);
      } else {
        /* Land on the engine's own string, not on our re-rounding of it. */
        settle();
      }
    }

    requestAnimationFrame(tick);
  }

  function initCounters() {
    const nodes = document.querySelectorAll('[data-count]');
    const observer = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          /* Deep-linking past the stats (or jumping there in one scroll) must
             not leave a counter stuck on zero, so anything already above the
             viewport is settled immediately instead of waiting for a pass. */
          const scrolledPast = entry.boundingClientRect.bottom < 0;
          if (!entry.isIntersecting && !scrolledPast) return;
          if (entry.isIntersecting) animateCount(entry.target);
          else entry.target.textContent = String(entry.target.dataset.target ?? '');
          obs.unobserve(entry.target);
        });
      },
      { threshold: 0.5 },
    );
    nodes.forEach((node) => observer.observe(node));
  }

  /* ── ledger ──────────────────────────────────────────────────────────── */

  function renderLedger(data, source) {
    const body = document.getElementById('ledgerBody');
    const foot = document.getElementById('ledgerFoot');
    if (!body) return;

    const epochs = (data.epochs || []).filter((epoch) => epoch.settled).slice().reverse();

    if (epochs.length === 0) {
      body.innerHTML = '<tr class="ledger__empty"><td colspan="8">No epoch has settled yet.</td></tr>';
      return;
    }

    const pick = (epoch, bucket) => {
      const found = (epoch.allocations || []).find((allocation) => allocation.bucket === bucket);
      return found ? found.amount : '—';
    };

    body.innerHTML = epochs
      .map(
        (epoch) => `
        <tr>
          <td class="ledger__epoch">#${epoch.id}</td>
          <td>${epoch.collected}</td>
          <td>${pick(epoch, 'buyback')}</td>
          <td>${epoch.drip.total}</td>
          <td>${pick(epoch, 'liquidity')}</td>
          <td>${pick(epoch, 'treasury')}</td>
          <td>${epoch.drip.recipients}</td>
          <td class="ledger__root" title="${epoch.drip.root}">${epoch.drip.root.slice(0, 18)}&hellip;</td>
        </tr>`,
      )
      .join('');

    if (foot) {
      const isMock = !data.mint.address;
      foot.innerHTML =
        `All amounts in ${data.native.symbol}. ` +
        `${epochs.length} settled epoch${epochs.length === 1 ? '' : 's'}, ` +
        `${data.totals.recipients} distinct wallets paid. ` +
        (isMock
          ? `<span class="tag-mock">synthetic</span> The token has not launched, so these epochs come from the engine's deterministic mock fee sources.`
          : `Generated from on-chain fee vaults.`) +
        ` Source: ${source === 'live' ? '<code>data/faucet.json</code>' : 'bundled snapshot'}.`;
    }
  }

  /* ── page furniture ──────────────────────────────────────────────────── */

  function initNav() {
    const nav = document.getElementById('nav');
    const links = Array.from(document.querySelectorAll('.nav__links a'));
    if (!nav) return;

    const onScroll = () => nav.classList.toggle('is-stuck', window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    const sections = links
      .map((link) => document.querySelector(link.getAttribute('href')))
      .filter(Boolean);

    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          links.forEach((link) => {
            link.classList.toggle('is-active', link.getAttribute('href') === `#${entry.target.id}`);
          });
        });
      },
      /* Fire when a section crosses the upper third, so the highlight tracks
         what you are reading rather than what is merely on screen. */
      { rootMargin: '-30% 0px -60% 0px' },
    );

    sections.forEach((section) => observer.observe(section));
  }

  function initReveal() {
    const candidates = document.querySelectorAll(
      '.section__head, .gauge-card, .proof__step, .note, .run__stage, .faq__item, .loop__canvas, .loop__panel, .ledger, .stats',
    );

    candidates.forEach((node, i) => {
      node.setAttribute('data-reveal', '');
      node.style.transitionDelay = `${Math.min(i % 6, 5) * 55}ms`;
    });

    const observer = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          obs.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );

    candidates.forEach((node) => observer.observe(node));
  }

  function initCopy() {
    document.querySelectorAll('[data-copy-target]').forEach((button) => {
      button.addEventListener('click', async () => {
        const target = document.querySelector(button.dataset.copyTarget);
        if (!target) return;
        const text = target.textContent.trim();
        const label = button.querySelector('.ca__copy-text');

        try {
          await navigator.clipboard.writeText(text);
        } catch (_) {
          /* Clipboard API needs a secure context; fall back to a selection so
             the user can still copy by hand instead of getting nothing. */
          const range = document.createRange();
          range.selectNodeContents(target);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          if (label) label.textContent = 'Selected';
          return;
        }

        button.classList.add('is-done');
        if (label) label.textContent = 'Copied';
        window.setTimeout(() => {
          button.classList.remove('is-done');
          if (label) label.textContent = 'Copy';
        }, 1800);
      });
    });
  }

  function stampFooter(data, source) {
    const node = document.getElementById('footerGenerated');
    if (!node || !data.generatedAt) return;
    const when = new Date(data.generatedAt);
    const stamp = Number.isNaN(when.valueOf()) ? data.generatedAt : when.toISOString().replace('T', ' ').slice(0, 16);
    node.textContent = `Epoch data generated ${stamp} UTC · ${source === 'live' ? 'live file' : 'bundled snapshot'}`;
  }

  function markStatsSource(source) {
    const node = document.getElementById('statsSource');
    if (!node) return;
    node.innerHTML =
      source === 'live'
        ? 'Reading <code>site/data/faucet.json</code>, written by the engine.'
        : 'Reading the bundled snapshot — serve the site over HTTP for the live file.';
  }

  /* ── boot ────────────────────────────────────────────────────────────── */

  async function boot() {
    initNav();
    initReveal();
    initCopy();

    const { data, source } = await loadData();
    if (!data) return;

    applyBindings(buildBindings(data));
    initCounters();
    renderLedger(data, source);
    stampFooter(data, source);
    markStatsSource(source);

    if (window.FaucetFlow) window.FaucetFlow.init(data.policy || []);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
