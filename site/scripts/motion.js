/* ═══════════════════════════════════════════════════════════════════════════
   motion.js — everything that moves but isn't water.

   Boot sequence, film grain, the cursor bead, magnetic buttons, click ripples,
   scroll-linked reveals, the riser, the section joints, the headline wipe,
   the ticker, the terminal typewriter and the Merkle proof animation.

   One shared rAF loop drives the per-frame work (bead + scroll readouts), so
   the page never runs four loops that each cost a frame.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ── film grain ───────────────────────────────────────────────────────────
     Generated rather than shipped as a PNG: it is ~400 bytes of markup and it
     scales to any DPI without a second asset.                                */

  (function grain() {
    const svg =
      "<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'>" +
      "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/>" +
      "<feColorMatrix type='saturate' values='0'/></filter>" +
      "<rect width='220' height='220' filter='url(%23n)' opacity='0.4'/></svg>";
    document.documentElement.style.setProperty('--grain-src', `url("data:image/svg+xml,${svg.replace(/"/g, "'")}")`);
  })();

  /* ── boot sequence ─────────────────────────────────────────────────────── */

  function boot() {
    const el = document.getElementById('boot');
    if (!el) return Promise.resolve();

    if (reduced.matches) {
      el.classList.add('is-done', 'is-gone');
      return Promise.resolve();
    }

    document.body.style.overflow = 'hidden';

    return new Promise((resolve) => {
      window.setTimeout(() => {
        el.classList.add('is-done');
        document.body.style.overflow = '';
        resolve();
        window.setTimeout(() => el.classList.add('is-gone'), 1100);
      }, 1450);
    });
  }

  /* ── cursor bead ───────────────────────────────────────────────────────── */

  const bead = { el: document.getElementById('bead'), x: -60, y: -60, tx: -60, ty: -60, live: false };

  function initBead() {
    if (!bead.el || !finePointer.matches || reduced.matches) return;

    window.addEventListener('pointermove', (event) => {
      bead.tx = event.clientX;
      bead.ty = event.clientY;
      if (!bead.live) {
        bead.live = true;
        bead.x = bead.tx;
        bead.y = bead.ty;
        bead.el.classList.add('is-live');
      }
    }, { passive: true });

    window.addEventListener('pointerdown', () => bead.el.classList.add('is-hot'));
    window.addEventListener('pointerup', () => bead.el.classList.remove('is-hot'));
    document.addEventListener('mouseleave', () => bead.el.classList.remove('is-live'));

    const hot = 'a, button, summary, input, [role="slider"], .dial-card, .loop__outputs li';
    document.querySelectorAll(hot).forEach((node) => {
      node.addEventListener('mouseenter', () => bead.el.classList.add('is-hot'));
      node.addEventListener('mouseleave', () => bead.el.classList.remove('is-hot'));
    });
  }

  /* ── magnetic buttons + click ripples ──────────────────────────────────── */

  function initTactile() {
    if (finePointer.matches && !reduced.matches) {
      document.querySelectorAll('[data-magnet]').forEach((node) => {
        node.addEventListener('pointermove', (event) => {
          const box = node.getBoundingClientRect();
          const dx = event.clientX - (box.left + box.width / 2);
          const dy = event.clientY - (box.top + box.height / 2);
          node.style.setProperty('--mx', `${clamp(dx * 0.22, -14, 14)}px`);
          node.style.setProperty('--my', `${clamp(dy * 0.32, -10, 10)}px`);
        });
        node.addEventListener('pointerleave', () => {
          node.style.setProperty('--mx', '0px');
          node.style.setProperty('--my', '0px');
        });
      });
    }

    document.querySelectorAll('.btn, .ca__copy').forEach((node) => {
      node.addEventListener('pointerdown', (event) => {
        if (reduced.matches) return;
        const box = node.getBoundingClientRect();
        const size = Math.max(box.width, box.height) * 2.4;
        const drop = document.createElement('span');
        drop.className = 'ripple';
        drop.style.width = drop.style.height = `${size}px`;
        drop.style.left = `${event.clientX - box.left}px`;
        drop.style.top = `${event.clientY - box.top}px`;
        node.appendChild(drop);
        window.setTimeout(() => drop.remove(), 700);
      });
    });
  }

  /* ── headline wipe ─────────────────────────────────────────────────────── */

  function initHeadline() {
    const title = document.querySelector('[data-split]');
    if (!title) return;

    title.querySelectorAll('.line').forEach((line, i) => {
      // Bare text needs a wrapper before it can be transformed independently.
      if (!line.firstElementChild) line.innerHTML = `<span>${line.innerHTML}</span>`;
      line.querySelectorAll(':scope > span, :scope > em').forEach((part) => {
        part.style.setProperty('--d', `${120 + i * 130}ms`);
      });
    });

    window.requestAnimationFrame(() => title.classList.add('is-in'));
  }

  /* ── reveals ───────────────────────────────────────────────────────────── */

  function initReveal() {
    const targets = document.querySelectorAll(
      '.section__head, .dial-card, .proof__step, .note, .run__stage, .faq__item, ' +
      '.loop__frame, .loop__panel, .ledger, .stats, .console__seal, .tree, .terminal',
    );

    targets.forEach((node, i) => {
      node.setAttribute('data-reveal', '');
      node.style.transitionDelay = `${Math.min(i % 5, 4) * 70}ms`;
    });

    const observer = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          obs.unobserve(entry.target);
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -6% 0px' },
    );

    targets.forEach((node) => observer.observe(node));
  }

  /* ── scroll-linked hardware: riser, nav meter, joints, the run ─────────── */

  const scrollBits = {
    riser: document.getElementById('riser'),
    riserFill: document.getElementById('riserFill'),
    meterArc: document.getElementById('navMeterArc'),
    meterNeedle: document.getElementById('navMeterNeedle'),
    joints: Array.from(document.querySelectorAll('[data-joint]')),
    run: document.getElementById('run'),
    nav: document.getElementById('nav'),
  };

  const METER_ARC = 53.4; /* path length of the little nav gauge */

  function paintScroll() {
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    const progress = max > 0 ? clamp(window.scrollY / max, 0, 1) : 0;

    if (scrollBits.riserFill) scrollBits.riserFill.style.setProperty('--fill', `${(progress * 100).toFixed(2)}%`);
    if (scrollBits.riser) scrollBits.riser.classList.toggle('is-live', window.scrollY > 120);
    if (scrollBits.nav) scrollBits.nav.classList.toggle('is-stuck', window.scrollY > 14);

    if (scrollBits.meterArc) {
      scrollBits.meterArc.style.strokeDashoffset = String(METER_ARC * (1 - progress));
    }
    if (scrollBits.meterNeedle) {
      scrollBits.meterNeedle.style.transform = `rotate(${(-90 + progress * 180).toFixed(1)}deg)`;
    }

    /* Each joint fills as it crosses the viewport, so the water appears to
       travel down the page between sections rather than teleport. */
    const vh = window.innerHeight;
    for (const joint of scrollBits.joints) {
      const box = joint.getBoundingClientRect();
      const t = clamp((vh * 0.86 - box.top) / (box.height + vh * 0.24), 0, 1);
      joint.style.setProperty('--fill', t.toFixed(3));
    }

    if (scrollBits.run) {
      const box = scrollBits.run.getBoundingClientRect();
      const t = clamp((vh * 0.78 - box.top) / (box.height * 0.82), 0, 1);
      const stages = scrollBits.run.querySelectorAll('.run__stage');
      const live = scrollBits.run.querySelector('.run__stage.is-live') || stages[stages.length - 1];
      const ceiling = live
        ? live.offsetTop + live.querySelector('.run__valve').offsetHeight / 2 + 12
        : scrollBits.run.offsetHeight;
      scrollBits.run.style.setProperty('--run-fill', `${Math.round(Math.min(t * scrollBits.run.offsetHeight, ceiling))}px`);
    }
  }

  /* ── nav active link ───────────────────────────────────────────────────── */

  function initNavLinks() {
    const links = Array.from(document.querySelectorAll('.nav__links a'));
    const sections = links.map((l) => document.querySelector(l.getAttribute('href'))).filter(Boolean);
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          links.forEach((link) => link.classList.toggle('is-active', link.getAttribute('href') === `#${entry.target.id}`));
        });
      },
      { rootMargin: '-32% 0px -58% 0px' },
    );

    sections.forEach((s) => observer.observe(s));
  }

  /* ── terminal typewriter ───────────────────────────────────────────────── */

  const TERMINAL_SCRIPT = [
    ['t-dim', '$ '], ['t-cmd', 'faucet'], ['', ' verify out/claims/epoch-3.json '], ['t-str', 'Hood042…'], ['', '\n\n'],
    ['t-ok', '  proof valid'], ['', '\n'],
    ['t-key', '  owner  '], ['', 'Hood042xxxxxxxxxxxxxxxxxxxxxxxxxxxx\n'],
    ['t-key', '  index  '], ['', '42\n'],
    ['t-key', '  amount '], ['', '0.0006 SOL\n'],
    ['t-key', '  proof  '], ['', '7 node(s)\n'],
    ['t-key', '  root   '], ['t-hash', '0x168163ee52ae9bf84eec35874632371dc…'], ['', '\n\n'],
    ['t-dim', '$ '], ['t-cmd', 'faucet'], ['', ' policy\n\n'],
    ['t-ok', '  100.00% of collected fees are routed back into the project.'], ['', '\n\n'],
    ['t-dim', '$ '], ['t-cmd', 'faucet'], ['', ' cycle --epochs 6 --write-site\n\n'],
    ['t-key', '  collected     '], ['', '0.1282 SOL\n'],
    ['t-key', '  routing       '], ['', 'buyback 35.00%  drip 35.00%  liq 20.00%  build 10.00%\n'],
    ['t-key', '  conserved     '], ['t-ok', 'yes'], ['', ' — routed == collected\n'],
  ];

  function typeTerminal() {
    const out = document.getElementById('termOut');
    const caret = document.getElementById('termCaret');
    if (!out) return;

    if (reduced.matches) {
      out.innerHTML = TERMINAL_SCRIPT.map(([c, t]) => (c ? `<span class="${c}">${t}</span>` : t)).join('');
      if (caret) caret.style.display = 'none';
      return;
    }

    let token = 0;
    let char = 0;
    let node = null;

    function step() {
      if (token >= TERMINAL_SCRIPT.length) {
        if (caret) caret.style.opacity = '0.35';
        return;
      }

      const [cls, text] = TERMINAL_SCRIPT[token];

      if (char === 0) {
        node = cls ? document.createElement('span') : document.createTextNode('');
        if (cls) node.className = cls;
        out.appendChild(node);
      }

      char += 1;
      const slice = text.slice(0, char);
      if (cls) node.textContent = slice;
      else node.nodeValue = slice;

      if (char >= text.length) {
        token += 1;
        char = 0;
      }

      /* Newlines pause like a command finishing; characters rattle out fast. */
      const last = text[Math.max(0, char - 1)];
      window.setTimeout(step, last === '\n' ? 130 : 11 + Math.random() * 14);
    }

    step();
  }

  /* ── the Merkle tree ───────────────────────────────────────────────────── */

  function buildTree() {
    const edges = document.getElementById('treeEdges');
    const nodes = document.getElementById('treeNodes');
    if (!edges || !nodes) return;

    const LEAVES = 8;
    const levels = [
      { count: 8, y: 224, w: 46, h: 22 },
      { count: 4, y: 158, w: 40, h: 20 },
      { count: 2, y: 92,  w: 40, h: 20 },
      { count: 1, y: 30,  w: 62, h: 24 },
    ];

    const xs = levels.map((level) =>
      Array.from({ length: level.count }, (_, i) => {
        const span = 560 / LEAVES;
        const group = LEAVES / level.count;
        return span * (i * group + group / 2);
      }),
    );

    const svgNS = 'http://www.w3.org/2000/svg';
    const made = { edges: [], nodes: [], labels: [] };

    for (let lv = 0; lv < levels.length - 1; lv++) {
      xs[lv].forEach((x, i) => {
        const line = document.createElementNS(svgNS, 'line');
        line.setAttribute('x1', String(x));
        line.setAttribute('y1', String(levels[lv].y - levels[lv].h / 2));
        line.setAttribute('x2', String(xs[lv + 1][Math.floor(i / 2)]));
        line.setAttribute('y2', String(levels[lv + 1].y + levels[lv + 1].h / 2));
        line.dataset.level = String(lv);
        line.dataset.index = String(i);
        edges.appendChild(line);
        made.edges.push(line);
      });
    }

    levels.forEach((level, lv) => {
      xs[lv].forEach((x, i) => {
        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('x', String(x - level.w / 2));
        rect.setAttribute('y', String(level.y - level.h / 2));
        rect.setAttribute('width', String(level.w));
        rect.setAttribute('height', String(level.h));
        rect.setAttribute('rx', String(lv === levels.length - 1 ? 7 : 5));
        if (lv === levels.length - 1) rect.classList.add('root');
        rect.dataset.level = String(lv);
        rect.dataset.index = String(i);
        nodes.appendChild(rect);
        made.nodes.push(rect);

        const label = document.createElementNS(svgNS, 'text');
        label.setAttribute('x', String(x));
        label.setAttribute('y', String(level.y + 3.5));
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('class', 'tree__label');
        label.textContent = lv === 0 ? `#${i}` : lv === levels.length - 1 ? 'ROOT' : 'h';
        label.dataset.level = String(lv);
        label.dataset.index = String(i);
        nodes.appendChild(label);
        made.labels.push(label);
      });
    });

    const leafOut = document.getElementById('treeLeaf');
    const sibOut = document.getElementById('treeSibs');

    function highlight(leaf) {
      made.edges.forEach((e) => e.classList.remove('on'));
      made.nodes.forEach((n) => n.classList.remove('on', 'sib'));
      made.labels.forEach((n) => n.classList.remove('on', 'sib'));

      const mark = (level, index, cls) => {
        made.nodes.find((n) => +n.dataset.level === level && +n.dataset.index === index)?.classList.add(cls);
        made.labels.find((n) => +n.dataset.level === level && +n.dataset.index === index)?.classList.add(cls);
      };

      let index = leaf;
      let siblings = 0;
      mark(0, index, 'on');

      for (let lv = 0; lv < levels.length - 1; lv++) {
        // The sibling at this level is exactly what the proof carries.
        const sibling = index % 2 === 0 ? index + 1 : index - 1;
        if (sibling < levels[lv].count) {
          mark(lv, sibling, 'sib');
          siblings += 1;
        }
        made.edges
          .find((e) => +e.dataset.level === lv && +e.dataset.index === index)
          ?.classList.add('on');
        index = Math.floor(index / 2);
        mark(lv + 1, index, 'on');
      }

      if (leafOut) leafOut.textContent = String(leaf);
      if (sibOut) sibOut.textContent = String(siblings);
    }

    let leaf = 5;
    highlight(leaf);

    if (reduced.matches) return;

    let timer = null;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      if (visible && timer === null) {
        timer = window.setInterval(() => {
          leaf = (leaf + 3) % 8;
          highlight(leaf);
        }, 2400);
      } else if (!visible && timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    }, { threshold: 0.25 });

    observer.observe(document.getElementById('tree'));
  }

  /* ── shared frame loop ─────────────────────────────────────────────────── */

  let queued = false;

  function frame() {
    if (bead.el && bead.live) {
      bead.x = lerp(bead.x, bead.tx, 0.22);
      bead.y = lerp(bead.y, bead.ty, 0.22);
      bead.el.style.transform = `translate3d(${bead.x}px, ${bead.y}px, 0) translate(-50%, -50%)`;
    }
    if (queued) {
      paintScroll();
      queued = false;
    }
    window.requestAnimationFrame(frame);
  }

  /* ── copy button ───────────────────────────────────────────────────────── */

  function initCopy() {
    document.querySelectorAll('[data-copy-target]').forEach((button) => {
      button.addEventListener('click', async () => {
        const target = document.querySelector(button.dataset.copyTarget);
        if (!target) return;
        const label = button.querySelector('.ca__copy-text');

        try {
          await navigator.clipboard.writeText(target.textContent.trim());
        } catch (_) {
          /* Clipboard needs a secure context; select the text so the user can
             still copy it by hand rather than getting nothing at all. */
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

  /* ── public surface ────────────────────────────────────────────────────── */

  window.FaucetMotion = {
    /** Builds the marquee. Doubled so the -50% translate loops seamlessly. */
    buildTicker(items) {
      const track = document.getElementById('tickerTrack');
      if (!track || items.length === 0) return;
      const html = items.map((i) => `<span class="ticker__item">${i}</span>`).join('');
      track.innerHTML = html + html;
    },
    startTerminal() {
      const terminal = document.getElementById('terminal');
      if (!terminal) return;
      const observer = new IntersectionObserver((entries, obs) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          obs.disconnect();
          typeTerminal();
        });
      }, { threshold: 0.3 });
      observer.observe(terminal);
    },
  };

  /* ── boot ──────────────────────────────────────────────────────────────── */

  function start() {
    initBead();
    initTactile();
    initReveal();
    initNavLinks();
    initCopy();
    buildTree();
    window.FaucetMotion.startTerminal();

    queued = true;
    paintScroll();
    window.addEventListener('scroll', () => { queued = true; }, { passive: true });
    window.addEventListener('resize', () => { queued = true; }, { passive: true });
    window.requestAnimationFrame(frame);

    boot().then(initHeadline);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
