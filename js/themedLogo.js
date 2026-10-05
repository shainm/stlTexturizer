/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * themedLogo.js — the PDS edition's logo: a flat "B" with soft low-poly
 * facets, drawn in the theme colour (--theme-color, js/pdsSettings.js).
 *
 *  - logoSvg(hex) is the one drawing. logo.svg / logo.png in the repo root are
 *    it in the default steel blue (saved from logoSvg() — keep them in step
 *    when the drawing changes), for the README, social cards, the first paint
 *    and launcher/make_shortcuts.ps1.
 *  - In the page it recolours every <img class="app-logo">, the favicon (an
 *    Edge --app window shows the favicon in the taskbar, so the taskbar
 *    follows too) and --logo-url (the settings menu's faded corner logo).
 *    It watches <html>'s style attribute rather than the pds-theme-color
 *    event, so a profile load or the pre-paint script in index.html count too.
 *  - onLogoIcon(cb) hands PNG frames for an .ico to personal.js, which sends
 *    them to launcher/serve.py to rewrite launcher/icon.ico (the Desktop /
 *    Start menu / pinned shortcut icon). Debounced: the colour picker fires
 *    on every drag step.
 */

export const DEFAULT_LOGO_COLOR = '#4a84c4';

const B_OUTER = 'M120 64H298C366 64 408 102 408 156C408 194 388 222 356 238C402 252 430 290 430 340C430 404 382 448 314 448H120Z';
const B_HOLES = 'M200 134H290C316 134 330 148 330 168C330 188 316 204 290 204H200Z' +
                'M200 274H302C334 274 350 292 350 324C350 356 334 378 302 378H200Z';
const B = B_OUTER + B_HOLES;

// [path, white (+) or black (-) overlay opacity]: light from the top left
const FACETS = [
  ['M120 64L260 64L200 160Z',    0.18],
  ['M260 64L408 156L330 168Z',   0.10],
  ['M200 204L356 238L290 274Z',  0.12],
  ['M120 256L200 160L200 340Z', -0.08],
  ['M356 238L430 340L350 324Z', -0.12],
  ['M120 448L200 340L200 448Z', -0.10],
  ['M200 378L430 340L314 448Z', -0.16],
];

/** hex mixed toward `to` (0..1) — '#rrggbb' in, '#rrggbb' out. */
function mix(hex, to, t) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v + (to - v) * t));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}

/** The logo as SVG source in the given colour (square, the B centred). */
export function logoSvg(hex = DEFAULT_LOGO_COLOR) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) hex = DEFAULT_LOGO_COLOR;
  const facets = FACETS.map(([d, o]) =>
    `<path d="${d}" fill="${o > 0 ? '#fff' : '#000'}" opacity="${Math.abs(o)}"/>`).join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="75 56 400 400" width="512" height="512">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    `<stop offset="0" stop-color="${mix(hex, 255, 0.35)}"/><stop offset="1" stop-color="${mix(hex, 0, 0.35)}"/>` +
    `</linearGradient><clipPath id="c"><path d="${B}" clip-rule="evenodd"/></clipPath></defs>` +
    `<path d="${B}" fill="url(#g)" fill-rule="evenodd"/><g clip-path="url(#c)">${facets}</g></svg>`;
}

const dataUrl = (svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

// ── In the page ─────────────────────────────────────────────────────────────
const ICO_SIZES = [256, 48, 32, 16];
let _iconCb = null, _iconTimer = 0, _color = null;

/** PNG frames ({size: base64}) of the logo in `hex`, for an .ico. */
async function pngFrames(hex) {
  const img = new Image();
  img.src = dataUrl(logoSvg(hex));
  await img.decode();
  const frames = {};
  for (const s of ICO_SIZES) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, s, s);
    frames[s] = cv.toDataURL('image/png').split(',')[1];
  }
  return frames;
}

function sendIcon() {
  if (!_iconCb || !_color) return;
  clearTimeout(_iconTimer);
  const hex = _color;
  _iconTimer = setTimeout(async () => {
    try { await _iconCb(await pngFrames(hex)); } catch { /* no server, or an old one */ }
  }, 800);
}

/** cb(frames) gets the .ico frames now and after every theme colour change. */
export function onLogoIcon(cb) {
  _iconCb = cb;
  sendIcon();
}

function apply() {
  const root = document.documentElement;
  const hex = (getComputedStyle(root).getPropertyValue('--theme-color').trim().toLowerCase()) || DEFAULT_LOGO_COLOR;
  if (hex === _color) return;
  _color = hex;
  const url = dataUrl(logoSvg(hex));
  for (const img of document.querySelectorAll('img.app-logo')) img.src = url;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
  link.type = 'image/svg+xml';
  link.href = url;
  root.style.setProperty('--logo-url', `url("${url}")`);
  sendIcon();
}

if (typeof document !== 'undefined') {
  apply();
  new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
}
