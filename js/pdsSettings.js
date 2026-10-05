/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * pdsSettings.js — the PDS edition's settings menu (the gear in the
 * viewport's top right) and the floating layout around it. Called from
 * personal.js initPersonal, with the same `app` internals.
 *
 *  - Appearance: the panel style (data-style on <html>: Tray, the default,
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
 *  - Folding cards: a click on a card's title folds it to just the title
 *    (remembered per card).
 *  - Layout: tells the viewer how much of the canvas the floating cards cover
 *    (setViewInset), so the model centres in what's left.
 */

import { setViewInset, setViewerTheme } from './viewer.js';

const LS = 'bm-pds-';
const ACCENT_KEY = LS + 'accent';          // also read by index.html's pre-paint script
const DEFAULT_KEY = LS + 'default-profile';
const STYLE_KEY = LS + 'style';             // also read by index.html: tray (default) | matte | glass
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
function applyAccent(hex) {
  document.documentElement.style.setProperty('--theme-color', hex);
  refreshViewer();   // Matte tints the 3D view's background with it
}

/** The 3D view's colours come from the CSS (viewer.js cssColor): re-read them. */
function refreshViewer() {
  setViewerTheme(document.documentElement.getAttribute('data-theme') === 'light');
}

function initStyle() {
  const seg = $('pds-style-seg');
  const sync = () => {
    const style = document.documentElement.getAttribute('data-style') || 'tray';
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
    if (style === 'tray') document.documentElement.removeAttribute('data-style');
    else document.documentElement.setAttribute('data-style', style);
    lsSet(STYLE_KEY, style === 'tray' ? null : style);
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
    applyAccent(current);
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
const FOLD_KEY = LS + 'folded';

function initFolding() {
  let folded;
  try { folded = new Set(JSON.parse(lsGet(FOLD_KEY, '[]'))); } catch { folded = new Set(); }
  const save = () => lsSet(FOLD_KEY, folded.size ? JSON.stringify([...folded]) : null);

  for (const card of document.querySelectorAll('#settings-panel > .panel-section')) {
    const h2 = card.querySelector(':scope > h2');
    // Advanced folds already (main.js); the first card has no title.
    if (!h2 || card.classList.contains('advanced-section')) continue;
    const key = h2.dataset.i18n || h2.textContent.trim();

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
    const toggle = (e) => {
      // the (i) tooltip text in a title is not a reason to fold
      if (e.target.closest('a, button, input')) return;
      const fold = !card.classList.contains('pds-folded');
      if (fold) folded.add(key); else folded.delete(key);
      save();
      set(fold, true);
    };
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
  refreshViewer();   // the 3D view in the saved style's colours
  const profiles = initProfiles(app, toast);
  initMenu(() => profiles.render());
  initFolding();
  initViewInset();
  applyDefaultOnStart(app, profiles, freshSession).catch(err => console.warn('[pds] default profile', err));
}
