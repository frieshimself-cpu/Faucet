/* Secondary pages: the build stamp in the footer and the active TOC entry. */
(function () {
  'use strict';

  fetch('/data/build.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((build) => {
      const node = document.getElementById('footerBuild');
      if (!node || !build) return;
      const built = build.builtAt ? new Date(build.builtAt).toISOString().replace('T', ' ').slice(0, 16) : 'unknown';
      node.textContent = `v${build.version} · commit ${build.short} on ${build.branch} · built ${built} UTC on ${build.host || 'local'} · ${build.tests} engine tests`;
    })
    .catch(() => {});

  const links = Array.from(document.querySelectorAll('.toc a')).filter((a) => a.getAttribute('href').startsWith('#'));
  const targets = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  if (targets.length === 0) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      links.forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === `#${entry.target.id}`));
    });
  }, { rootMargin: '-20% 0px -70% 0px' });

  targets.forEach((t) => observer.observe(t));
})();
