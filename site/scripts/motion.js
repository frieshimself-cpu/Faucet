/* ═══════════════════════════════════════════════════════════════════════════
   motion.js — everything that moves but isn't water.

   Scroll-linked reveals, the pipe joints between sections, the headline
   wipe, the ticker, the Merkle proof illustration, the caustics on the tile
   wall, and the nav. One shared rAF loop drives the scroll work.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
      '.section__head, .dial-card, .note, .loop__frame, .loop__panel, .ledger, .stats, ' +
      '.tree, .verify__form, .verify__result, .constants, .notes__col, .status',
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

  /* ── scroll-linked hardware: the joints between sections ──────────────── */

  const scrollBits = {
    joints: Array.from(document.querySelectorAll('[data-joint]')),
    nav: document.getElementById('nav'),
  };

  function paintScroll() {
    if (scrollBits.nav) scrollBits.nav.classList.toggle('is-stuck', window.scrollY > 14);

    /* Each joint fills as it crosses the viewport, so the water appears to
       travel down the page between sections rather than teleport. */
    const vh = window.innerHeight;
    for (const joint of scrollBits.joints) {
      const box = joint.getBoundingClientRect();
      const t = clamp((vh * 0.86 - box.top) / (box.height + vh * 0.24), 0, 1);
      joint.style.setProperty('--fill', t.toFixed(3));
    }
  }

  /* ── nav active link ───────────────────────────────────────────────────── */

  function initNavLinks() {
    const links = Array.from(document.querySelectorAll('.nav__links a')).filter((l) => l.getAttribute('href').startsWith('#'));
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


  /* ── caustics on the tile wall ────────────────────────────────────────────
     Light refracted through moving water makes a lattice of bright ridges.
     A sum of three drifting sine fields, raised to a power so only the crests
     glow, painted at ~80×100 and blurred up by CSS. Cost: negligible.      */

  function initCaustics() {
    const canvas = document.getElementById('causticsCanvas');
    const scene = document.getElementById('scene');
    if (!canvas || !scene || reduced.matches) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = 80;
    const H = 100;
    canvas.width = W;
    canvas.height = H;
    const image = ctx.createImageData(W, H);
    const data = image.data;

    let running = false;
    let raf = 0;

    function paint(now) {
      if (!running) return;
      const t = now / 1000;
      const flow = window.FaucetWater ? window.FaucetWater.getFlow() : 0.7;
      const gain = 0.35 + flow * 0.65;

      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const u = x / W;
          const v = y / H;
          const a = Math.sin(u * 9.0 + t * 0.9 + Math.sin(v * 5.0 + t * 0.6) * 1.2);
          const b = Math.sin(v * 11.0 - t * 1.1 + Math.sin(u * 6.0 - t * 0.5) * 1.1);
          const c = Math.sin((u + v) * 7.5 + t * 0.7);
          let k = (a + b + c) / 3;            // -1 .. 1
          k = Math.max(0, k);
          k = k * k * k;                      // only the crests
          // Brightest low and to the right, near the tank; fades toward the lamp.
          const falloff = 0.25 + 0.75 * v * (0.4 + 0.6 * u);
          const i = (y * W + x) * 4;
          const lum = Math.min(1, k * 3.2 * gain * falloff);
          data[i]     = 0;
          data[i + 1] = 224 * lum;
          data[i + 2] = 122 * lum;
          data[i + 3] = 255 * lum;
        }
      }

      ctx.putImageData(image, 0, 0);
      raf = window.requestAnimationFrame(paint);
    }

    new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      if (visible && !running) {
        running = true;
        raf = window.requestAnimationFrame(paint);
      } else if (!visible) {
        running = false;
        window.cancelAnimationFrame(raf);
      }
    }, { threshold: 0.05 }).observe(scene);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { running = false; window.cancelAnimationFrame(raf); }
      else if (!running) { running = true; raf = window.requestAnimationFrame(paint); }
    });
  }

  /* ── shared frame loop ─────────────────────────────────────────────────── */

  let queued = false;

  function frame() {
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
  };

  /* ── boot ──────────────────────────────────────────────────────────────── */

  function start() {
    initReveal();
    initNavLinks();
    initCopy();
    buildTree();
    initCaustics();

    queued = true;
    paintScroll();
    window.addEventListener('scroll', () => { queued = true; }, { passive: true });
    window.addEventListener('resize', () => { queued = true; }, { passive: true });
    window.requestAnimationFrame(frame);

    initHeadline();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
