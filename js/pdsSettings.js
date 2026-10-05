/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * pdsSettings.js — the PDS edition's settings menu (the gear in the
 * viewport's top right) and the floating layout around it. Called from
 * personal.js initPersonal, with the same `app` internals.
 *
 *  - Appearance: the panel style (data-style on <html>: Gradient, the default,
 *    with the tray panels' glow; Matte, flat tinted surfaces like Material
 *    You; Glass, frosted panels like Apple's), the theme colour
 *    (--theme-color; panel-look.css derives the
 *    accent, hover and glow from it), Dark / Light (drives main.js's hidden
 *    #theme-toggle so the viewer follows), Language (main.js fills .lang-seg).
 *  - Profiles: named sets of settings, kept in this browser (IndexedDB). A
 *    profile is the settings-only .bumpmesh the Export already writes as
 *    "_shared settings" (no model, no paint), so loading one is a
 *    settings-only project load: layers, custom textures and undo included.
 *    Saving to an existing profile updates it.
 *  - Default profile: a new session (nothing in sessionStorage) starts with
 *    it, and Reset goes back to it instead of the built-in defaults.
 *  - Support: CNC Kitchen's store / tip links and the What's New, License
 *    and Imprint popups live only here. The export thank-you popup, the store
 *    banner and the What's New popup at start-up are switched off.
 *  - The model's textured / untextured preview colours follow the theme
 *    colour (modelColors), or with Model colours > Material the texture's
 *    material (materialColors: wood brown, stone grey, ... in a high and a
 *    low colour); personal.js initColours shows and applies them.
 *  - Beta features: their tools sit in the cards they belong to with a Beta
 *    tag (index.html); a click on the tag opens their explanation here.
 *  - Folding cards: a click on a card's title folds it to just the title
 *    (remembered per card).
 *  - Layout: tells the viewer how much of the canvas the floating cards cover
 *    (setViewInset), so the model centres in what's left.
 */

import { setViewInset, setViewerTheme } from './viewer.js';

const LS = 'bm-pds-';
const ACCENT_KEY = LS + 'accent';          // also read by index.html's pre-paint script
const DEFAULT_KEY = LS + 'default-profile';
const STYLE_KEY = LS + 'style';              // also read by index.html: gradient (default) | matte | glass
const MODEL_COLORS_KEY = LS + 'model-colors';  // theme (default) | material
const DEFAULT_ACCENT = '#4a84c4';

// The tray panels' accents, plus BumpMesh's own purple.
const SWATCHES = [
  { hex: '#4a84c4', name: 'BumpMesh blue (the logo)' },
  { hex: '#d9473f', name: 'NX red' },
  { hex: '#1db954', name: 'Spotify green' },
  { hex: '#d97757', name: 'Claude orange' },
  { hex: '#e0a526', name: 'Amber' },
  { hex: '#2bb3a3', name: 'Teal' },
  { hex: '#7c6aff', name: 'Original purple' },
  { hex: '#8c9096', name: 'Graphite (monotone)' },
];

function lsGet(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} }

const $ = (id) => document.getElementById(id);

// ── Profile store (IndexedDB: profiles can carry custom texture PNGs, too
//    big for localStorage) ─────────────────────────────────────────────────
let _db = null;
function db() {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const req = indexedDB.open('bm-pds-profiles', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('profiles', { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _db;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('profiles', mode);
    const req = fn(t.objectStore('profiles'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
const listProfiles = async () => ((await tx('readonly', s => s.getAll())) || [])
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
const getProfile = (name) => tx('readonly', s => s.get(name));
const putProfile = (p) => tx('readwrite', s => s.put(p));
const deleteProfile = (name) => tx('readwrite', s => s.delete(name));

// ── Theme colour ────────────────────────────────────────────────────────────
function applyAccent(hex, changed) {
  document.documentElement.style.setProperty('--theme-color', hex);
  refreshViewer();   // Matte tints the 3D view's background with it
  // a new theme colour re-ties the textured / untextured preview colours
  // (personal.js initColours), dropping a hand-picked one
  if (changed) window.dispatchEvent(new CustomEvent('pds-theme-color', { detail: hex }));
}

/** The theme colour now in effect (index.html's saved one, else the CSS default). */
export function currentThemeColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim().toLowerCase() || DEFAULT_ACCENT;
}

/**
 * The model's preview colours for a theme colour: calm, dusty versions of
 * it. Textured = the theme colour's hue, untextured = the opposite hue (the
 * original teal / orange pair is nearly that), both at low saturation and a
 * lowish lightness. Low on purpose: the preview takes these as linear light
 * (previewMaterial.js), so on the shaded model they come out much lighter and
 * stronger than the swatch. A grey theme keeps a muted orange.
 */
export function modelColors(hex) {
  const [h, s] = hexToHsl(hex);
  // a grey (monotone) theme: light grey textured, darker grey untextured
  if (s < 0.12) return { textured: hslToHex(h, s, 0.42), untextured: hslToHex(h, s, 0.2) };
  const textured = hslToHex(h, Math.min(0.34, Math.max(0.18, s * 0.5)), 0.36);
  const untextured = hslToHex((h + 180) % 360, 0.36, 0.38);
  return { textured, untextured };
}

// ── Material colours (Settings > Model colours > Material) ─────────────────
// The textured surface takes the colours of what its texture depicts, as a
// pair: `high` for the raised parts, `low` for the recessed ones (the shader
// mixes them by the relief's height). Matched on the texture's name first
// (custom maps too: "oak.png" is wood), then on its gallery category; the
// rest (patterns, geometric) keep the theme colour, with darker low parts.
// Dark-ish on purpose: the preview renders colours lighter than their hex.
const MATERIALS = [
  { name: 'Bark',     re: /bark/i,                                              high: '#3e2a1e', low: '#6e5038' },
  { name: 'Wood',     re: /wood|grain|plank|timber|oak|walnut|maple|burl/i,       high: '#4a2e1c', low: '#8a6440' },
  { name: 'Bamboo',   re: /bamboo|reed|straw|wicker|basket|rattan|cane|tachiwaki|flute|ribs/i, high: '#8a7a48', low: '#5c4e2c' },
  { name: 'Leaves',   re: /lea(f|ves)|moss|grass|fern/i,                          high: '#4a6a38', low: '#2e4224' },
  { name: 'Scales',   re: /scale|dragon|reptile/i,                                high: '#4f7a6c', low: '#2c4a40' },
  { name: 'Brick',    re: /brick|roof|shingle|terracotta/i,                       high: '#8a4632', low: '#5a5550' },
  { name: 'Stone',    re: /cobble|flagstone|setts|stone|rock|granite|slate|marble/i, high: '#7c7872', low: '#3e3b37' },
  { name: 'Concrete', re: /concrete|sand|stipple|speckle|matte|plaster|stucco/i,  high: '#77746e', low: '#57544f' },
  { name: 'Leather',  re: /leather|haircell|hide|suede/i,                         high: '#6e4429', low: '#43281a' },
  { name: 'Carbon',   re: /carbon/i,                                              high: '#50545a', low: '#1f2124' },
  { name: 'Metal',    re: /brushed|hammer|knurl|spark|chainmail|armou?r|metal|steel|isogrid|grip|cog|death star|diamond plate/i, high: '#959ba2', low: '#50555b' },
  { name: 'Fabric',   re: /weave|twill|knit|fabric|denim|linen|canvas|curtain|cloth/i, high: '#5e6a86', low: '#3a4258' },
  { name: 'Water',    re: /rain|ripple|wave|sazanami|current|cloud|water/i,       high: '#5f8aa6', low: '#2f4c62' },
  { name: 'Crystal',  re: /crystal|ice|gem|glass|bubble/i,                        high: '#86a8bf', low: '#4a6a84' },
];
const CATEGORY_MATERIALS = {
  natural: { name: 'Natural', high: '#7a6a4e', low: '#4a3e2c' },
  fabric:  { name: 'Fabric',  high: '#5e6a86', low: '#3a4258' },
  mold:    { name: 'Plastic', high: '#62666d', low: '#3c3f44' },
};

/** {name, high, low} for a texture ({name, category} or null) under a theme colour. */
export function materialColors(tex, theme) {
  const name = tex?.name || '';
  const m = MATERIALS.find(x => x.re.test(name)) || CATEGORY_MATERIALS[tex?.category];
  if (m) return { name: m.name, high: m.high, low: m.low };
  const [h, s, l] = hexToHsl(modelColors(theme).textured);
  return { name: 'Theme', high: hslToHex(h, s, l), low: hslToHex(h, s, l * 0.55) };
}

export const modelColorMode = () => (lsGet(MODEL_COLORS_KEY, 'theme') === 'material' ? 'material' : 'theme');

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}

/** The 3D view's colours come from the CSS (viewer.js cssColor): re-read them. */
function refreshViewer() {
  setViewerTheme(document.documentElement.getAttribute('data-theme') === 'light');
}

function initModelColors() {
  const seg = $('pds-model-colors-seg');
  const sync = () => {
    for (const b of seg.querySelectorAll('button')) {
      const on = b.dataset.mode === modelColorMode();
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    lsSet(MODEL_COLORS_KEY, b.dataset.mode === 'material' ? 'material' : null);
    window.dispatchEvent(new CustomEvent('pds-model-colors'));   // personal.js initColours
    sync();
  });
  sync();
}

function initStyle() {
  const seg = $('pds-style-seg');
  const sync = () => {
    const style = document.documentElement.getAttribute('data-style') || 'gradient';
    for (const b of seg.querySelectorAll('button')) {
      const on = b.dataset.style === style;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-style]');
    if (!b) return;
    const style = b.dataset.style;
    if (style === 'gradient') document.documentElement.removeAttribute('data-style');
    else document.documentElement.setAttribute('data-style', style);
    lsSet(STYLE_KEY, style === 'gradient' ? null : style);
    refreshViewer();
    sync();
  });
  sync();
}

function initAppearance() {
  const box = $('pds-accent-swatches');
  let current = lsGet(ACCENT_KEY, DEFAULT_ACCENT).toLowerCase();
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'pds-swatch pds-swatch-custom';
  custom.title = 'Pick any colour';
  custom.setAttribute('aria-label', 'Custom theme colour');

  const mark = () => {
    let known = false;
    for (const b of box.querySelectorAll('button.pds-swatch')) {
      const on = b.dataset.hex === current;
      known ||= on;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
    custom.value = current;
    custom.classList.toggle('active', !known);
  };
  const pick = (hex, save = true) => {
    current = hex.toLowerCase();
    applyAccent(current, save);
    if (save) lsSet(ACCENT_KEY, current === DEFAULT_ACCENT ? null : current);
    mark();
  };
  for (const s of SWATCHES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pds-swatch';
    b.dataset.hex = s.hex;
    b.title = s.name;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', s.name);
    b.style.setProperty('--sw', s.hex);
    b.addEventListener('click', () => pick(s.hex));
    box.append(b);
  }
  custom.addEventListener('input', () => pick(custom.value));
  box.append(custom);
  pick(current, false);

  // Dark / Light: main.js's (hidden) toggle does the switching and the viewer.
  const seg = $('pds-mode-seg');
  const sync = () => {
    const mode = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    for (const b of seg.querySelectorAll('button')) {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if ((b.dataset.mode === 'light') !== isLight) $('theme-toggle').click();
    sync();
  });
  sync();
}

// ── Menu open / close ───────────────────────────────────────────────────────
function initMenu(onOpen) {
  const menu = $('pds-settings'), gear = $('pds-settings-btn');
  const isOpen = () => !menu.classList.contains('hidden');
  const set = (open) => {
    menu.classList.toggle('hidden', !open);
    gear.classList.toggle('active', open);
    gear.setAttribute('aria-expanded', String(open));
    if (open) onOpen();
  };
  gear.addEventListener('click', () => set(!isOpen()));
  $('pds-settings-close').addEventListener('click', () => set(false));
  // Click anywhere else closes it, but not a popup the menu opened (License,
  // What's New, ...) or a confirm.
  document.addEventListener('pointerdown', (e) => {
    if (!isOpen() || menu.contains(e.target) || gear.contains(e.target)) return;
    if (e.target.closest('.license-overlay, .welcome-overlay, .pds-modal')) return;
    set(false);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isOpen()) return;
    if (document.querySelector('.license-overlay:not(.hidden), .welcome-overlay:not(.hidden)')) return;
    set(false);
    gear.focus();
  });
  // The menu's own popups (What's New, License, Imprint) open on top of it.
  for (const id of ['welcome-link', 'license-link', 'imprint-link']) {
    $(id)?.addEventListener('click', () => set(false));
  }
  return { open: () => set(true) };
}

// ── Beta tags: a click opens the menu at that tool's explanation ───────────
function initBetaTags(menu) {
  document.addEventListener('click', (e) => {
    const tag = e.target.closest('.beta-badge[data-beta]');
    if (!tag) return;
    e.preventDefault();   // inside a label: don't tick its checkbox
    const item = $('pds-beta-' + tag.dataset.beta);
    menu.open();
    if (!item) return;
    // A folded Beta card opens first; scroll once it has its height.
    const opening = unfoldCard(item.closest('.pds-foldable'));
    setTimeout(() => {
      item.scrollIntoView({ block: 'center', behavior: 'smooth' });
      item.classList.remove('pds-flash');
      void item.offsetWidth;   // restart the highlight
      item.classList.add('pds-flash');
    }, opening ? 300 : 0);
  });
}

// ── Profiles ────────────────────────────────────────────────────────────────
function initProfiles(app, notify) {
  const list = $('pds-profile-list');
  const target = $('pds-profile-target');
  const nameBox = $('pds-profile-name');
  const saveBtn = $('pds-profile-save');
  const defSel = $('pds-default-profile');
  let busy = false;

  const fmt = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  async function render() {
    let profiles = [];
    try { profiles = await listProfiles(); } catch (err) { console.warn('[pds] profiles', err); }
    const def = lsGet(DEFAULT_KEY, '');
    if (def && !profiles.some(p => p.name === def)) lsSet(DEFAULT_KEY, null);

    list.replaceChildren();
    if (!profiles.length) {
      const p = document.createElement('p');
      p.className = 'pds-empty';
      p.textContent = 'No profiles yet. Set things up, then save them below.';
      list.append(p);
    }
    for (const p of profiles) {
      const row = document.createElement('div');
      row.className = 'pds-profile';
      const info = document.createElement('div');
      info.className = 'pds-profile-info';
      const nm = document.createElement('span');
      nm.className = 'pds-profile-name';
      nm.textContent = p.name;
      if (p.name === lsGet(DEFAULT_KEY, '')) {
        const badge = document.createElement('span');
        badge.className = 'pds-badge';
        badge.textContent = 'default';
        nm.append(' ', badge);
      }
      const when = document.createElement('span');
      when.className = 'pds-profile-when';
      when.textContent = 'Saved ' + fmt(p.saved);
      info.append(nm, when);
      const load = document.createElement('button');
      load.type = 'button';
      load.className = 'pds-pill';
      load.textContent = 'Load';
      load.title = `Apply "${p.name}" to the current model`;
      load.addEventListener('click', () => loadProfile(p.name));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'pds-pill pds-pill-icon';
      del.title = `Delete "${p.name}"`;
      del.setAttribute('aria-label', `Delete ${p.name}`);
      del.textContent = '×';
      del.addEventListener('click', async () => {
        if (!confirm(`Delete the profile "${p.name}"?`)) return;
        await deleteProfile(p.name);
        if (lsGet(DEFAULT_KEY, '') === p.name) lsSet(DEFAULT_KEY, null);
        render();
      });
      row.append(info, load, del);
      list.append(row);
    }

    // Save to: a new profile, or an existing one (which it then updates).
    const keep = target.value;
    target.replaceChildren(new Option('New profile…', ''));
    for (const p of profiles) target.append(new Option('Update: ' + p.name, p.name));
    target.value = profiles.some(p => p.name === keep) ? keep : '';
    syncSaveRow();

    defSel.replaceChildren(new Option('BumpMesh defaults', ''));
    for (const p of profiles) defSel.append(new Option(p.name, p.name));
    defSel.value = lsGet(DEFAULT_KEY, '');
  }

  function syncSaveRow() {
    const updating = !!target.value;
    nameBox.hidden = updating;
    saveBtn.textContent = updating ? 'Update' : 'Save';
    saveBtn.title = updating ? `Replace "${target.value}" with the current settings` : 'Save the current settings as a new profile';
  }
  target.addEventListener('change', () => { syncSaveRow(); if (!target.value) nameBox.focus(); });

  async function save() {
    if (busy) return;
    const updating = !!target.value;
    const name = (updating ? target.value : nameBox.value).trim();
    if (!name) { nameBox.focus(); return; }
    if (!updating && await getProfile(name) && !confirm(`A profile named "${name}" exists. Replace it?`)) return;
    busy = true; saveBtn.disabled = true;
    try {
      const zip = await app.buildSettingsZip({ pds: { profile: name } });
      await putProfile({ name, zip, saved: Date.now() });
      nameBox.value = '';
      target.value = name;
      await render();
      notify(updating ? `Updated "${name}"` : `Saved "${name}"`);
    } catch (err) {
      alert(`Couldn't save the profile: ${err.message}`);
    } finally { busy = false; saveBtn.disabled = false; }
  }
  saveBtn.addEventListener('click', save);
  nameBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });

  defSel.addEventListener('change', () => { lsSet(DEFAULT_KEY, defSel.value || null); render(); });

  async function loadProfile(name) {
    if (busy) return false;
    const p = await getProfile(name);
    if (!p) { render(); return false; }
    busy = true;
    try {
      await app.importProject(new File([p.zip], `${name}.bumpmesh`), { mode: 'settings' });
      notify(`Loaded "${name}"`);
      return true;
    } catch (err) {
      alert(`Couldn't load the profile: ${err.message}`);
      return false;
    } finally { busy = false; }
  }

  // Reset → the default profile, when there is one (main.js's handler resets
  // to the built-in defaults otherwise). Capture phase, so it runs first, and
  // decided synchronously (render() drops a default whose profile is gone).
  $('reset-settings-btn')?.addEventListener('click', async (e) => {
    const def = lsGet(DEFAULT_KEY, '');
    if (!def) return;
    e.stopImmediatePropagation();
    if (!confirm(`Reset all settings to your default profile "${def}"?`)) return;
    app.resetSettingsToDefaults();
    await loadProfile(def);
  }, true);

  render();
  return { render, loadProfile };
}

/** A new session starts with the default profile (once the start-up texture is in). */
async function applyDefaultOnStart(app, profiles, freshSession) {
  const def = lsGet(DEFAULT_KEY, '');
  if (!def || !freshSession || /[?&]open=/.test(location.search)) return;
  for (let i = 0; i < 100 && !(app.hasModel() && app.textureNames().length); i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  await new Promise(r => setTimeout(r, 300));
  await profiles.loadProfile(def);
}

// ── Support content only in the menu ───────────────────────────────────────
function silenceSupportPopups() {
  // main.js skips the export thank-you popup for this flag (per tab).
  try { sessionStorage.setItem('stlt-no-sponsor', '1'); } catch {}
  // What's New opened itself at start-up (main.js showWelcomeIfNeeded runs
  // just before this); it stays available from the menu.
  $('welcome-overlay')?.classList.add('hidden');
}

// ── Floating layout: what the cards cover of the canvas ─────────────────────
function initViewInset() {
  const main = document.querySelector('main');
  const settings = $('settings-panel'), gallery = $('gallery-panel');
  const section = $('viewport-section');
  let raf = 0, followUntil = 0;
  // Measured, not computed: while the cards slide in or out (panel-look.css)
  // their transformed edge is read every frame, so the model glides along.
  const update = () => {
    raf = 0;
    const view = section.getBoundingClientRect();
    let left = view.right;
    const panel = gallery && !gallery.classList.contains('hidden') ? gallery : settings;
    const r = panel.getBoundingClientRect();
    // Stacked below the viewport (portrait phones): nothing covers it.
    if (r.width && r.top < view.bottom - 1 && r.left > view.left) {
      // The cards' left edge (the panel column has a transparent margin).
      const card = panel === settings ? settings.querySelector('.panel-section') : panel;
      left = Math.min(left, (card || panel).getBoundingClientRect().left);
    }
    setViewInset(view.right - left);
    if (performance.now() < followUntil) schedule();
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
  const follow = () => { followUntil = performance.now() + 600; schedule(); };
  new ResizeObserver(schedule).observe(section);
  new MutationObserver(follow).observe(main, { attributes: true, attributeFilter: ['class'] });
  if (gallery) new MutationObserver(follow).observe(gallery, { attributes: true, attributeFilter: ['class'] });
  schedule();
}

// ── Folding cards: a click on a card's title folds it to just the title ────
// The sidebar's cards and the settings menu's cards fold alike; which ones are
// folded is remembered (the menu's keys carry a "menu:" prefix).
const FOLD_KEY = LS + 'folded';
const unfolders = new WeakMap();   // card -> opens it (Beta tags use it)

/** Opens a folded card; true when it was folded (it is now animating open). */
function unfoldCard(card) { return !!(card && unfolders.get(card)?.()); }

function initFolding() {
  let folded;
  try { folded = new Set(JSON.parse(lsGet(FOLD_KEY, '[]'))); } catch { folded = new Set(); }
  const save = () => lsSet(FOLD_KEY, folded.size ? JSON.stringify([...folded]) : null);

  const cards = [
    ...[...document.querySelectorAll('#settings-panel > .panel-section')].map(card => [card, '']),
    ...[...document.querySelectorAll('#pds-settings > .pds-group')].map(card => [card, 'menu:']),
  ];
  for (const [card, prefix] of cards) {
    const h2 = card.querySelector(':scope > h2');
    // Advanced folds already (main.js); the first card has no title.
    if (!h2 || card.classList.contains('advanced-section')) continue;
    const key = prefix + (h2.dataset.i18n || h2.textContent.trim());

    // Everything after the title goes into a body that animates its height
    // (grid rows 1fr <-> 0fr). Nodes are moved, so ids and listeners stay.
    const body = document.createElement('div');
    body.className = 'pds-fold-body';
    const inner = document.createElement('div');
    inner.className = 'pds-fold-inner';
    while (h2.nextSibling) inner.append(h2.nextSibling);
    body.append(inner);
    card.append(body);

    const chev = document.createElement('span');
    chev.className = 'pds-fold-chevron';
    chev.setAttribute('aria-hidden', 'true');
    h2.append(chev);
    card.classList.add('pds-foldable');
    h2.tabIndex = 0;
    h2.setAttribute('role', 'button');

    const set = (fold, animate) => {
      card.classList.toggle('pds-folded', fold);
      h2.setAttribute('aria-expanded', String(!fold));
      inner.inert = fold;
      // Clip only while folded or moving, so slider thumbs and focus rings
      // aren't cut off in an open card.
      if (!animate || fold) { inner.classList.toggle('pds-clip', fold); return; }
      inner.classList.add('pds-clip');
      const done = (e) => {
        if (e && e.target !== body) return;
        body.removeEventListener('transitionend', done);
        if (!card.classList.contains('pds-folded')) inner.classList.remove('pds-clip');
      };
      body.addEventListener('transitionend', done);
      setTimeout(done, 450);   // reduced motion: no transitionend
    };
    const setSaved = (fold) => {
      if (fold) folded.add(key); else folded.delete(key);
      save();
      set(fold, true);
    };
    const toggle = (e) => {
      // the (i) tooltip text in a title is not a reason to fold
      if (e.target.closest('a, button, input')) return;
      setSaved(!card.classList.contains('pds-folded'));
    };
    unfolders.set(card, () => {
      if (!card.classList.contains('pds-folded')) return false;
      setSaved(false);
      return true;
    });
    h2.addEventListener('click', toggle);
    h2.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
    });
    set(folded.has(key), false);
  }
}

// ── Toast ───────────────────────────────────────────────────────────────────
function toast(text) {
  let t = document.querySelector('.pds-toast');
  if (!t) { t = document.createElement('div'); t.className = 'pds-toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// ── Entry point ─────────────────────────────────────────────────────────────
export function initSettingsMenu(app) {
  // Decided before anything autosaves: did this tab have a session already?
  let freshSession = true;
  try { freshSession = !sessionStorage.getItem('bumpmesh-settings'); } catch {}

  silenceSupportPopups();
  initStyle();
  initAppearance();
  initModelColors();
  refreshViewer();   // the 3D view in the saved style's colours
  const profiles = initProfiles(app, toast);
  const menu = initMenu(() => profiles.render());
  initBetaTags(menu);
  initFolding();
  initViewInset();
  applyDefaultOnStart(app, profiles, freshSession).catch(err => console.warn('[pds] default profile', err));
}
