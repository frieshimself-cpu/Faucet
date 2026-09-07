/* Film grain, generated rather than shipped as a PNG: ~400 bytes of SVG
   turbulence that scales to any DPI. Loaded by every page so the texture is
   the same everywhere and no page needs an inline script (the CSP forbids
   them). */
(function () {
  'use strict';
  var svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'>" +
    "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/>" +
    "<feColorMatrix type='saturate' values='0'/></filter>" +
    "<rect width='220' height='220' filter='url(%23n)' opacity='0.4'/></svg>";
  document.documentElement.style.setProperty('--grain-src', 'url("data:image/svg+xml,' + svg + '")');
})();
