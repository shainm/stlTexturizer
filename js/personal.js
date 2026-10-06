/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * personal.js — the PDS edition's additions, kept out of main.js so upstream
 * updates merge cleanly. main.js calls initPersonal(app) once with the few
 * internals used here.
 *
 *  - Version label marks this edition.
 *  - Preview colours for textured / untextured surfaces, tied to the theme
 *    colour (a hand-picked one holds until the theme colour changes).
 *  - The settings menu (gear, js/pdsSettings.js): theme colour, dark/light,
 *    language, settings profiles + the default one, and the support links,
 *    which appear nowhere else (no support popups or banners).
 *  - 3D Print Settings (in index.html / main.js, since it is a saved
 *    setting): tops/bottoms get printZScale x the texture height of walls
 *    (displacement.js printZFactor, mirrored in the preview shader).
 *  - With the desktop launcher's local server (launcher/serve.py):
 *      · Load Model / Load project open a native picker, so the file's real
 *        location is known;
 *      · one Export button writes, into a job folder (each item optional):
 *          Textured\<name>_<textures>.3mf|.stl
 *          Texture Settings\<name> [<textures>] <made>.bumpmesh   a VARIATION: settings
 *                                                      + selections + model
 *          Texture Settings\_shared settings.bumpmesh  settings for every model here
 *          Original\<original file>                    copied or moved there
 *        Saving a loaded variation with changed settings/selections writes a
 *        new variation (named by its textures and when it was first made);
 *        unchanged, it refreshes the loaded one. A textured file with the same
 *        name is archived into Archive\<name> <last edit time>\ before replacing;
 *      · opening a model from a job folder offers its saved variation (a
 *        dropdown, newest first, when there are several), else the folder's
 *        shared settings;
 *      · "Align texture to assembly": finds this part inside an assembly STL
 *        and lays the texture out in the assembly's frame, so separately
 *        printed parts (a stacking planter) continue each other's texture;
 *      · a project the launcher was started with (double-clicked .bumpmesh)
 *        opens straight away.
 *    Without the server (opened as a plain web page) the app is unchanged.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { APP_VERSION } from './version.js';
import { setDownloadSink } from './exporter.js';
import { THREE } from './threeCompat.js';
import { getCamera, getRenderer, getCurrentMesh, setDiagEdges, requestRender } from './viewer.js';
import { initSettingsMenu, modelColors, currentThemeColor, materialColors, modelColorMode } from './pdsSettings.js';
import { onLogoIcon } from './themedLogo.js';

export const EDITION = 'PDS Edition';
const LS = 'bm-pds-';
const SHARED_FILE = '_shared settings.bumpmesh';

// ── Local server (launcher/serve.py) ────────────────────────────────────────
let _token = null;

async function connect() {
  try {
    const r = await fetch('/api/token', { cache: 'no-store' });
    if (!r.ok) return false;
    _token = (await r.json()).token;
    return !!_token;
  } catch { return false; }
}

async function call(route, args = {}) {
  const r = await fetch('/api/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BM-Token': _token },
    body: JSON.stringify(args),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `${route} failed`);
  return j;
}

async function readFile(path) {
  const r = await fetch('/api/read?path=' + encodeURIComponent(path), { headers: { 'X-BM-Token': _token } });
  if (!r.ok) throw new Error(`Can't read ${path}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function writeFile(path, blob) {
  const r = await fetch('/api/write?path=' + encodeURIComponent(path), {
    method: 'PUT', headers: { 'X-BM-Token': _token }, body: blob,
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `Can't write ${path}`);
}

const stat = async (paths) => (await call('stat', { paths })).items;
const exists = async (path) => (await stat([path]))[0];

// ── Paths and names ─────────────────────────────────────────────────────────
const sep = '\\';
const join = (...p) => p.filter(Boolean).join(sep).replace(/[\\/]+/g, sep);
const dirname = (p) => p.replace(/[\\/][^\\/]*$/, '');
const basename = (p) => p.replace(/^.*[\\/]/, '');
const stem = (n) => n.replace(/\.[^.]+$/, '');
const safe = (s) => String(s).replace(/\.(png|jpe?g|webp|bmp|gif|tiff?)$/i, '')
  .replace(/[<>:"/\\|?*\x00-\x1f\s-]+/g, '_').replace(/^_|_$/g, '')
  .replace(/(^|_)(\p{L})/gu, (_, p, c) => p + c.toUpperCase()) || 'Texture';
/** The model's own folder inside the export folder: the same capitalised name, with spaces (not nested again when the export folder already is it). */
const jobDir = (name) => (safe(basename(state.dest)) === safe(name) ? state.dest : join(state.dest, safe(name).replace(/_/g, ' ')));
const SUB = { textured: 'Textured', project: 'Texture Settings', original: 'Original', archive: 'Archive' };
// Earlier exports named the settings folder "project files"; still read from it.
const LEGACY_PROJECT = 'project files';

function stamp(ms) {
  const d = new Date(ms), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}${z(d.getMinutes())}`;
}

// ── Variations ──────────────────────────────────────────────────────────────
// A model's project is saved as a VARIATION: "<name> [<textures>] <created>.bumpmesh".
// <created> is when the variation was first made and never changes. Saving a
// loaded variation with changed settings or selections starts a new variation
// (the loaded one stays as it was); saving it unchanged just refreshes it.
// Plain "<name>.bumpmesh" files from before variations count as variations too
// (created = file time, textures from the file's own list).
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const variationRe = (name) => new RegExp(
  `^${esc(name)}(?: \\[(.+)\\] (\\d{4})-(\\d\\d)-(\\d\\d) (\\d\\d)(\\d\\d)(?: \\(\\d+\\))?)?\\.bumpmesh$`, 'i');

/** { textures, created (ms) | null } for a variation file name of this model, else null. */
function parseVariation(name, fileName) {
  const m = fileName.match(variationRe(safe(name)));
  if (!m) return null;
  return { textures: m[1] || null, created: m[2] ? new Date(+m[2], m[3] - 1, +m[4], +m[5], +m[6]).getTime() : null };
}

const variationFile = (name, textures, ms) => `${safe(name)} [${textures}] ${stamp(ms)}.bumpmesh`;

/** The model's variations in the job folder, newest first. */
async function listVariations(name) {
  const out = [];
  for (const sub of [SUB.project, LEGACY_PROJECT]) {
    let items = [];
    try { items = (await call('list', { dir: join(state.dest, sub) })).items; } catch { continue; }
    for (const it of items) {
      const v = !it.isDir && parseVariation(name, it.name);
      if (v) out.push({ path: it.path, textures: v.textures, created: v.created ?? it.mtime * 1000 });
    }
  }
  return out.sort((a, b) => b.created - a.created);
}

/** Pick one when there are several; the newest is preselected. null = none chosen. */
async function chooseVariation(vars) {
  const sel = el('select', { style: 'width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font:inherit' },
    vars.map(v => el('option', { value: v.path }, `${v.textures || 'earlier save'} — made ${new Date(v.created).toLocaleString()}`)));
  const c = await modal('Choose a variation',
    el('div', {}, el('p', {}, `This model has ${vars.length} saved variations (different textures or settings). Open which one?`), sel),
    [{ label: 'Just the model', value: null }, { label: 'Open variation', value: 1, primary: true }]);
  return c ? sel.value : null;
}

/** Cheap string hash (FNV-1a) so a fingerprint stays small. */
function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16) + ':' + s.length;
}

/** Settings + selections as they stand now (nothing about where or when it is saved). */
async function fingerprint(app) {
  const files = unzipSync(await app.buildProjectZip({}));
  const s = JSON.parse(strFromU8(files['settings.json']));
  delete s.pds;
  // Paint, the project's other models (and their paint) and the variant tabs all count as changes.
  const text = (f) => (files[f] ? strFromU8(files[f]) : '');
  return hashString(JSON.stringify(s) + '|' + text('paint.json') + '|' + text('models.json') + '|' + text('variants.json'));
}

/**
 * A variation was just loaded: remember it and, once the load has settled,
 * what its settings looked like, so Export can tell whether they changed.
 */
function rememberVariation(app, path, created) {
  const v = { path, created, fp: null };
  state.variant = v;
  state.variantReady = (async () => {
    await new Promise(r => setTimeout(r, 1500));
    const fp = await fingerprint(app);
    if (state.variant === v) v.fp = fp;
  })().catch(() => {});
}

function lsGet(k, d) { try { return localStorage.getItem(LS + k) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(LS + k, v); } catch {} }

// ── State: where this job lives ─────────────────────────────────────────────
const state = {
  originalPath: null,   // the model file on disk, when known
  dest: lsGet('dest', ''),
  name: '',
  align: null,          // { assembly: path, frame: {min,size}, offset: {x,y,z} } for the loaded model
  variant: null,        // the loaded/saved variation: { path, created (ms), fp (settings fingerprint) }
  variantReady: null,
};

/** A model/project opened from <dest>\Original\ or <dest>\Texture Settings\ belongs to <dest>. */
function adoptLocation(path) {
  const dir = dirname(path), up = basename(dir).toLowerCase();
  const job = [SUB.original, SUB.project, LEGACY_PROJECT].some(n => n.toLowerCase() === up);
  state.dest = job ? dirname(dir) : dir;
}

// ── UI helpers ──────────────────────────────────────────────────────────────
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled') e[k] = !!v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}

function injectStyle() {
  document.head.append(el('style', {}, `
    .pds-dim { opacity: .45; }
    /* Popups sit beside the sidebar like the settings menu: no dimming, so the
       part stays in view. The overlay blocks clicks, unless the popup is "live"
       (the 3D view stays usable underneath, e.g. to orbit while lining up). */
    .pds-modal { position: fixed; inset: 0; z-index: 10000; }
    .pds-modal.live { pointer-events: none; }
    .pds-card { position: fixed; top: 58px; right: 12px; max-height: calc(100vh - 70px); overflow-y: auto;
      pointer-events: auto; scrollbar-width: thin;
      background: var(--panel-bg, var(--surface)); color: var(--text);
      border: 1px solid var(--panel-border, var(--border));
      -webkit-backdrop-filter: var(--panel-blur, none); backdrop-filter: var(--panel-blur, none);
      border-radius: var(--panel-radius, var(--radius)); padding: 14px 16px; width: min(440px, calc(100vw - 24px));
      box-shadow: var(--panel-shadow, 0 12px 40px rgba(0,0,0,.45)); font-size: 13px; }
    .pds-card h3 { margin: 0 0 12px; font-size: 15px; }
    .pds-card .row { display: flex; gap: 8px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
    .pds-card label.k { width: 70px; color: var(--text-muted); }
    .pds-card .item { display: flex; gap: 8px; align-items: center; margin: 6px 0; flex-wrap: wrap; }
    .pds-card .item > label:first-child { min-width: 210px; }
    .pds-card .item.off > :not(:first-child) { opacity: .45; pointer-events: none; }
    .pds-card .sub { margin-left: 26px; }
    .pds-card input[type=text] { flex: 1; min-width: 0; background: var(--bg); color: var(--text);
      border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font: inherit; }
    .pds-card .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
    .pds-card .muted { color: var(--text-muted); font-size: 12px; }
    .pds-card .opts label { margin-right: 12px; white-space: nowrap; }
    .pds-card .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
    .pds-card hr { border: 0; border-top: 1px solid var(--border); margin: 12px 0; }
    .pds-btn { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px;
      padding: 6px 12px; cursor: pointer; font: inherit; }
    .pds-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .pds-btn:disabled { opacity: .5; cursor: default; }
    .pds-card ul { margin: 6px 0 0 18px; padding: 0; max-height: 160px; overflow: auto; }
    .pds-colors { display: inline-flex; gap: 10px; align-items: center; margin-left: 8px; }
    .pds-colors label { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; }
    .pds-colors input[type=color] { width: 22px; height: 18px; padding: 0; border: 1px solid var(--border);
      border-radius: 4px; background: none; cursor: pointer; }
    .pds-pick { position: fixed; top: 64px; left: 50%; transform: translateX(-50%); z-index: 10001;
      background: var(--accent); color: #fff; padding: 8px 14px; border-radius: 8px; font-size: 13px;
      box-shadow: 0 6px 20px rgba(0,0,0,.4); pointer-events: none; }
    .pds-align { display: flex; gap: 8px; align-items: center; margin-top: 8px; font-size: 12px; }
    .pds-align .muted { color: var(--text-muted); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `));
}

/** Modal with buttons; resolves to the clicked button's value (null on Escape). */
function modal(title, body, buttons, { live = false } = {}) {
  return new Promise((resolve) => {
    const close = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    const card = el('div', { class: 'pds-card', role: 'dialog', 'aria-modal': 'true' },
      el('h3', {}, title), body,
      el('div', { class: 'btns' }, buttons.map(b =>
        el('button', { class: 'pds-btn' + (b.primary ? ' primary' : ''), onclick: () => close(b.value) }, b.label))));
    const overlay = el('div', { class: 'pds-modal' + (live ? ' live' : '') }, card);
    // Beside the sidebar when it is showing, else at the window's edge.
    const sp = document.getElementById('settings-panel'), r = sp && sp.getBoundingClientRect();
    card.style.right = ((r && r.width > 0 && r.left < window.innerWidth ? window.innerWidth - r.left : 0) + 12) + 'px';
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    card.querySelector('.primary')?.focus();
  });
}
/** "Resume your last session?" beside the sidebar; resolves true to resume. */
export async function askResume(name, when, thumb) {
  const body = el('div', {},
    thumb && el('img', { src: thumb, alt: name,
      style: 'display:block;width:100%;border-radius:6px;border:1px solid var(--border);margin:0 0 10px' }),
    el('p', { style: 'margin:0 0 4px' }, name),
    el('p', { class: 'muted', style: 'margin:0' }, `Saved ${when}`));
  return (await modal('Resume your last session?', body, [
    { label: 'Start fresh', value: false },
    { label: 'Resume', value: true, primary: true },
  ], { live: true })) === true;
}
const notice = (title, text) => modal(title, el('p', {}, text), [{ label: 'OK', value: 1, primary: true }]);

// ── Preview colours ─────────────────────────────────────────────────────────
// Tied to the theme colour (pdsSettings.js modelColors), or with Model colours
// > Material to the active texture's material (materialColors: a high and a
// low colour). Picking one by hand overrides it until the theme colour
// changes, which ties both again; in Material mode the texture sets the
// textured colour.
function initColours(app) {
  const tex = el('input', { type: 'color' });
  const untex = el('input', { type: 'color' });
  const texLabel = el('label', {}, tex, 'Textured');
  const custom = () => { try { return JSON.parse(lsGet('col-custom', 'null')); } catch { return null; } };
  const tip = ' (follows the theme colour; pick one to override it until the theme colour changes)';
  const show = () => {
    const theme = currentThemeColor();
    const auto = modelColors(theme), c = custom();
    const own = c && c.theme === theme ? c : null;
    const mat = modelColorMode() === 'material' ? materialColors(app.activeTexture(), theme) : null;
    tex.disabled = !!mat;
    texLabel.title = mat ? `Set by the texture: ${mat.name} (Settings > Model colours)` : 'Preview colour of textured surfaces' + tip;
    tex.value = mat ? mat.high : own?.tex || auto.textured;
    untex.value = own?.untex || auto.untextured;
    app.setPreviewColors(tex.value, untex.value, mat ? mat.low : null);
    requestRender();   // the view only redraws on request
  };
  const pick = () => {
    const c = custom();
    lsSet('col-custom', JSON.stringify({ theme: currentThemeColor(),
      tex: tex.disabled ? (c?.tex || null) : tex.value, untex: untex.value }));
    show();
  };
  tex.addEventListener('input', pick);
  untex.addEventListener('input', pick);
  window.addEventListener('pds-theme-color', () => {
    try { localStorage.removeItem(LS + 'col-custom'); } catch {}
    show();
  });
  window.addEventListener('pds-model-colors', show);
  // Material mode follows the active layer's texture; there is no event for a
  // texture change, so look twice a second (a string compare when nothing changed).
  let last = '';
  setInterval(() => {
    if (modelColorMode() !== 'material') { last = ''; return; }
    const key = JSON.stringify(app.activeTexture());
    if (key !== last) { last = key; show(); }
  }, 500);
  const box = el('span', { class: 'pds-colors' },
    texLabel,
    el('label', { title: 'Preview colour of untextured surfaces' + tip }, untex, 'Untextured'));
  document.getElementById('section-toggle')?.closest('label')?.after(box);
  // the colours picked before they followed the theme
  try { localStorage.removeItem(LS + 'col-tex'); localStorage.removeItem(LS + 'col-untex'); } catch {}
  show();
}

// ── STL reading (binary or ASCII) ──────────────────────────────────────────
function parseSTL(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === bytes.length) {
      const pos = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
      return pos;
    }
  }
  const text = strFromU8(bytes);
  const out = [];
  for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) out.push(+m[1], +m[2], +m[3]);
  if (!out.length) throw new Error('Not an STL file');
  return new Float32Array(out);
}

// ── Assembly alignment ─────────────────────────────────────────────────────
/**
 * Find where the part sits inside the assembly (translation only, same
 * orientation): every assembly vertex is tried as the image of one reference
 * part vertex, and the translation that puts the most sampled part vertices
 * onto assembly vertices (0.05 mm grid) wins.
 * @returns {{ offset:{x,y,z}, match:number, frame:{min,size} } | null}
 */
function locateInAssembly(part, asm) {
  const G = 20; // 1 / 0.05 mm
  const key = (x, y, z) => `${Math.round(x * G)},${Math.round(y * G)},${Math.round(z * G)}`;
  const aset = new Set();
  const aUnique = [];
  let amin = [Infinity, Infinity, Infinity], amax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < asm.length; i += 3) {
    const k = key(asm[i], asm[i + 1], asm[i + 2]);
    if (!aset.has(k)) { aset.add(k); aUnique.push(i); }
    for (let c = 0; c < 3; c++) { amin[c] = Math.min(amin[c], asm[i + c]); amax[c] = Math.max(amax[c], asm[i + c]); }
  }
  // Spread-out sample of distinct part vertices.
  const seen = new Set(), pv = [];
  for (let i = 0; i < part.length; i += 3) {
    const k = key(part[i], part[i + 1], part[i + 2]);
    if (!seen.has(k)) { seen.add(k); pv.push([part[i], part[i + 1], part[i + 2]]); }
  }
  const step = Math.max(1, Math.floor(pv.length / 300));
  const sample = pv.filter((_, i) => i % step === 0);
  const quick = sample.filter((_, i) => i % Math.max(1, Math.floor(sample.length / 10)) === 0);
  const p0 = sample[0];
  const hits = (list, tx, ty, tz) => { let h = 0; for (const [x, y, z] of list) if (aset.has(key(x + tx, y + ty, z + tz))) h++; return h; };
  let best = null, ties = 0;
  for (const i of aUnique) {
    const tx = asm[i] - p0[0], ty = asm[i + 1] - p0[1], tz = asm[i + 2] - p0[2];
    if (hits(quick, tx, ty, tz) < quick.length * 0.4) continue;
    const h = hits(sample, tx, ty, tz) / sample.length;
    if (!best || h > best.match + 1e-9) { best = { match: h, offset: { x: tx, y: ty, z: tz } }; ties = 0; }
    else if (Math.abs(h - best.match) < 1e-9) ties++;
  }
  if (!best || best.match < 0.4) return null;
  const o = best.offset;
  best.ties = ties;
  best.frame = {
    min: { x: amin[0] - o.x, y: amin[1] - o.y, z: amin[2] - o.z },
    size: { x: amax[0] - amin[0], y: amax[1] - amin[1], z: amax[2] - amin[2] },
  };
  return best;
}

/**
 * Stack an exploded assembly: split it into parts (connected shells, merged
 * when their heights overlap), then set each part, bottom up, on the one
 * below at that part's rim (stackDatums). Returns each part's z range (as
 * exploded) and the z shift that stacks it.
 */
function stackAssembly(asm) {
  const G = 20, key = (i) => `${Math.round(asm[i] * G)},${Math.round(asm[i + 1] * G)},${Math.round(asm[i + 2] * G)}`;
  const nV = asm.length / 3, id = new Int32Array(nV), ids = new Map();
  for (let v = 0; v < nV; v++) { const k = key(v * 3); let x = ids.get(k); if (x === undefined) ids.set(k, x = ids.size); id[v] = x; }
  const parent = new Int32Array(ids.size).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (let t = 0; t < nV / 3; t++) { const a = find(id[t * 3]), b = find(id[t * 3 + 1]), c = find(id[t * 3 + 2]); parent[b] = a; parent[find(c)] = a; }
  // Shells with their z range, then groups of z-overlapping shells (= parts).
  const shells = new Map();
  for (let t = 0; t < nV / 3; t++) {
    const r = find(id[t * 3]);
    let s = shells.get(r); if (!s) shells.set(r, s = { tris: [], zmin: Infinity, zmax: -Infinity });
    s.tris.push(t);
    for (let c = 0; c < 3; c++) { const z = asm[t * 9 + c * 3 + 2]; if (z < s.zmin) s.zmin = z; if (z > s.zmax) s.zmax = z; }
  }
  const sorted = [...shells.values()].sort((a, b) => a.zmin - b.zmin);
  const groups = [];
  for (const s of sorted) {
    const g = groups[groups.length - 1];
    if (g && s.zmin < g.zmax - 1e-3) { g.tris.push(...s.tris); g.zmax = Math.max(g.zmax, s.zmax); }
    else groups.push({ tris: [...s.tris], zmin: s.zmin, zmax: s.zmax });
  }
  if (groups.length < 2) return { groups: groups.map(g => ({ zmin: g.zmin, zmax: g.zmax, shift: 0 })) };
  // Each part rests where the one below's top runs all the way round (its
  // seat + pitch, stackDatums) — tabs and slots don't hold it up.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < asm.length; i += 3) { x0 = Math.min(x0, asm[i]); x1 = Math.max(x1, asm[i]); y0 = Math.min(y0, asm[i + 1]); y1 = Math.max(y1, asm[i + 1]); }
  const axis = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  for (const g of groups) {
    const pos = new Float32Array(g.tris.length * 9);
    g.tris.forEach((t, k) => pos.set(asm.subarray(t * 9, t * 9 + 9), k * 9));
    g.pitch = stackDatums(pos, axis).pitch;
  }
  groups[0].shift = 0;
  for (let g = 1; g < groups.length; g++) {
    const below = groups[g - 1];
    groups[g].shift = (below.zmin + below.shift + below.pitch) - groups[g].zmin;
  }
  return { groups: groups.map(g => ({ zmin: g.zmin, zmax: g.zmax, shift: g.shift })) };
}

const _asmCache = new Map(); // path → { asm, stack }

/**
 * Align the loaded model's texture to an assembly. The part is located in the
 * assembly; an exploded assembly (parts spaced apart) is stacked first, so the
 * texture lines up as assembled. `zOverride` (mm) replaces the part's height
 * in the stack when the automatic stacking seats it wrong.
 */
/**
 * Modular stacking datums of a part (file coordinates): its seat (lowest z,
 * where it rests on the part below) and how far above the seat the next part
 * rests: the part's top all the way around — the median over 72 sectors
 * around the axis of each sector's highest point, so tabs (a minority of
 * sectors) and small notches don't count.
 * @returns {{ seat:number, pitch:number }}
 */
function stackDatums(pos, axis) {
  let seat = Infinity;
  const top = new Float64Array(72).fill(-Infinity);
  for (let i = 0; i < pos.length; i += 3) {
    seat = Math.min(seat, pos[i + 2]);
    const s = (Math.floor((Math.atan2(pos[i + 1] - axis.y, pos[i] - axis.x) + Math.PI) / (2 * Math.PI) * 72) + 72) % 72;
    if (pos[i + 2] > top[s]) top[s] = pos[i + 2];
  }
  const vals = [...top].filter(Number.isFinite).sort((a, b) => a - b);
  const rim = vals.length ? vals[Math.floor(vals.length / 2)] : seat;
  return { seat, pitch: Math.max(0, rim - seat) };
}

/** Tabs rising above the rim: runs of sectors whose top is >= 1 mm above it. */
function countTabs(pos, axis, seat, pitch) {
  const top = new Float64Array(72).fill(-Infinity);
  for (let i = 0; i < pos.length; i += 3) {
    const s = (Math.floor((Math.atan2(pos[i + 1] - axis.y, pos[i] - axis.x) + Math.PI) / (2 * Math.PI) * 72) + 72) % 72;
    if (pos[i + 2] > top[s]) top[s] = pos[i + 2];
  }
  const up = [...top].map(z => z > seat + pitch + 1);
  let runs = 0;
  for (let k = 0; k < 72; k++) if (up[k] && !up[(k + 71) % 72]) runs++;
  return runs;
}

// ── Joint edges: sharp edges, picking, rings ───────────────────────────────
/**
 * Sharp edges of the model (dihedral > 30°, or open), as segments in FILE
 * coordinates [x0,y0,z0,x1,y1,z1, ...]. Cached per model.
 */
let _sharpCache = { key: null, segs: null };
function sharpEdges(pos) {
  const key = pos.length + ':' + pos[0] + ':' + pos[pos.length - 1];
  if (_sharpCache.key === key) return _sharpCache.segs;
  const G = 1e4, vk = (i) => `${Math.round(pos[i] * G)},${Math.round(pos[i + 1] * G)},${Math.round(pos[i + 2] * G)}`;
  const nT = pos.length / 9, fn = new Float64Array(nT * 3), edges = new Map();
  for (let t = 0; t < nT; t++) {
    const p = t * 9;
    const ux = pos[p + 3] - pos[p], uy = pos[p + 4] - pos[p + 1], uz = pos[p + 5] - pos[p + 2];
    const vx = pos[p + 6] - pos[p], vy = pos[p + 7] - pos[p + 1], vz = pos[p + 8] - pos[p + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
    fn[t * 3] = nx / l; fn[t * 3 + 1] = ny / l; fn[t * 3 + 2] = nz / l;
    for (let e = 0; e < 3; e++) {
      const a = p + e * 3, b = p + ((e + 1) % 3) * 3, ka = vk(a), kb = vk(b);
      const k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      let r = edges.get(k); if (!r) edges.set(k, r = { a, b, tris: [] });
      r.tris.push(t);
    }
  }
  const cos30 = Math.cos(30 * Math.PI / 180), segs = [];
  for (const r of edges.values()) {
    let sharp = r.tris.length !== 2;
    if (!sharp) { const [t0, t1] = r.tris; sharp = fn[t0 * 3] * fn[t1 * 3] + fn[t0 * 3 + 1] * fn[t1 * 3 + 1] + fn[t0 * 3 + 2] * fn[t1 * 3 + 2] < cos30; }
    if (sharp) segs.push(pos[r.a], pos[r.a + 1], pos[r.a + 2], pos[r.b], pos[r.b + 1], pos[r.b + 2]);
  }
  _sharpCache = { key, segs: new Float32Array(segs) };
  return _sharpCache.segs;
}

/** Sharp edges lying level at height z (file coords), for the ring display. */
function ringAt(segs, z, tol = 0.05) {
  const out = [];
  for (let i = 0; i < segs.length; i += 6) {
    if (Math.abs(segs[i + 2] - z) <= tol && Math.abs(segs[i + 5] - z) <= tol) for (let k = 0; k < 6; k++) out.push(segs[i + k]);
  }
  return out;
}

/** Show the joint rings (seat and next-part heights) on the model. */
function showJointRings(app, seat, top) {
  const pos = app.modelFilePositions();
  if (!pos) return;
  const segs = sharpEdges(pos), t = app.poseTrans();
  const ring = [...ringAt(segs, seat), ...(top != null ? ringAt(segs, top) : [])];
  for (let i = 0; i < ring.length; i += 3) { ring[i] += t.x; ring[i + 1] += t.y; ring[i + 2] += t.z; }
  setDiagEdges(ring.length ? new Float32Array(ring) : null, 0xffd400);
}
const hideJointRings = () => setDiagEdges(null);

/**
 * Let the user click a joint edge on the model. Resolves to the height (file
 * z) of the nearest level sharp edge within 5 mm of the click, else the
 * clicked point's height; null on Escape.
 */
function pickEdgeHeight(app, prompt) {
  return new Promise((resolve) => {
    const canvas = getRenderer().domElement;
    const banner = el('div', { class: 'pds-pick' }, prompt + '  (Esc to cancel)');
    document.body.append(banner);
    const finish = (v) => {
      canvas.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      banner.remove();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
    const onDown = (e) => {
      if (e.button !== 0) return; // right/middle drag still orbit/pan
      e.preventDefault(); e.stopImmediatePropagation();
      const mesh = getCurrentMesh(), rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, getCamera());
      const hit = mesh && ray.intersectObject(mesh, false)[0];
      if (!hit) return; // missed the model: keep waiting
      const local = mesh.worldToLocal(hit.point.clone()), t = app.poseTrans();
      const p = { x: local.x - t.x, y: local.y - t.y, z: local.z - t.z };
      // Snap to the nearest level sharp edge.
      const segs = sharpEdges(app.modelFilePositions());
      let best = 25, z = p.z; // 5 mm squared
      for (let i = 0; i < segs.length; i += 6) {
        if (Math.abs(segs[i + 2] - segs[i + 5]) > 0.05) continue;
        const ax = segs[i], ay = segs[i + 1], bx = segs[i + 3], by = segs[i + 4], az = segs[i + 2];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        const w = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / L2)) : 0;
        const d2 = (ax + w * dx - p.x) ** 2 + (ay + w * dy - p.y) ** 2 + (az - p.z) ** 2;
        if (d2 < best) { best = d2; z = az; }
      }
      finish(z);
    };
    canvas.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  });
}

// ── Modular alignment ──────────────────────────────────────────────────────
/**
 * Lay the texture out for modular stacking: anchored at this part's seat, the
 * tile height fitted to its pitch (mapping.js), around an axis shared by all
 * parts (`xy`, file coordinates — parts must be exported in the same XY
 * frame). `opts` overrides the detected seat/pitch.
 */
function fileXY(app) {
  const b = app.modelFileBounds();
  return { min: { x: b.min.x, y: b.min.y }, size: { x: b.size.x, y: b.size.y } };
}

function alignModular(app, cfg, opts = {}) {
  if (app.poseRotated()) return false;
  const pos = app.modelFilePositions();
  if (!pos) return false;
  const xy = cfg.xy || fileXY(app);
  const axis = { x: xy.min.x + xy.size.x / 2, y: xy.min.y + xy.size.y / 2 };
  const d = stackDatums(pos, axis);
  const seat = opts.seat ?? d.seat, pitch = opts.pitch ?? d.pitch;
  const positions = cfg.positions || countTabs(pos, axis, d.seat, d.pitch) || 3;
  const frame = {
    min: { x: xy.min.x, y: xy.min.y, z: seat },
    size: { x: xy.size.x, y: xy.size.y, z: Math.max(pitch, 1) },
    modular: { pitch, positions: cfg.rotate ? positions : 1 },
  };
  state.align = { mode: 'modular', frame, seat, pitch, xy, rotate: !!cfg.rotate, positions };
  app.setTextureFrame(frame);
  updateAlignStatus();
  return true;
}

async function alignTo(app, assemblyPath, { quiet = false, zOverride = null } = {}) {
  if (app.poseRotated()) {
    if (!quiet) await notice('Align texture', 'The model is rotated in the app. Alignment needs the model in its file orientation — reset the rotation, then align.');
    return false;
  }
  const part = app.modelFilePositions();
  if (!part) return false;
  let cached = _asmCache.get(assemblyPath);
  if (!cached) {
    const asm = parseSTL(await readFile(assemblyPath));
    cached = { asm, stack: stackAssembly(asm) };
    _asmCache.set(assemblyPath, cached);
  }
  const found = locateInAssembly(part, cached.asm);
  if (!found) {
    if (!quiet) await notice('Align texture', `This model wasn't found in ${basename(assemblyPath)}. The assembly must contain it unrotated, at the same scale.`);
    return false;
  }
  // Stacked position: the part's group in the exploded assembly says how far
  // it drops; the frame spans the stacked assembly.
  const groups = cached.stack.groups;
  let pz = Infinity; for (let i = 2; i < part.length; i += 3) pz = Math.min(pz, part[i]);
  const partZ = pz + found.offset.z;
  const grp = groups.find(g => partZ >= g.zmin - 0.05 && partZ <= g.zmax + 0.05) || { shift: 0 };
  const offset = { ...found.offset, z: zOverride != null ? zOverride - pz : found.offset.z + grp.shift };
  const zmin = Math.min(...groups.map(g => g.zmin + g.shift)), zmax = Math.max(...groups.map(g => g.zmax + g.shift));
  const asmMin = { x: found.frame.min.x + found.offset.x, y: found.frame.min.y + found.offset.y };
  const frame = {
    min: { x: asmMin.x - offset.x, y: asmMin.y - offset.y, z: zmin - offset.z },
    size: { x: found.frame.size.x, y: found.frame.size.y, z: zmax - zmin },
  };
  state.align = { mode: 'assembly', assembly: assemblyPath, frame, offset, height: pz + offset.z, stacked: groups.length > 1, zOverride };
  app.setTextureFrame(frame);
  updateAlignStatus();
  return true;
}

function clearAlign(app) {
  state.align = null;
  hideJointRings();
  app.setTextureFrame(null);
  updateAlignStatus();
}

let _alignStatus = null;
function updateAlignStatus() {
  if (!_alignStatus) return;
  const a = state.align;
  _alignStatus.textContent = !a ? 'Texture laid out on this model alone'
    : a.mode === 'modular' ? `Modular: next part at ${a.pitch.toFixed(2)} mm${a.rotate ? `, ${a.positions} positions` : ''}`
    : `Aligned to ${basename(a.assembly)} — sits at ${a.height.toFixed(2)} mm${a.stacked ? ' (stacked)' : ''}`;
  _alignStatus.title = a?.assembly || '';
}

function initAlignControl(app) {
  const anchor = document.getElementById('mapping-mode')?.closest('.form-row') || document.getElementById('mapping-mode')?.parentElement;
  if (!anchor) return;
  _alignStatus = el('span', { class: 'muted' });
  const btn = el('button', { class: 'pds-btn', title: 'Line the texture up across parts printed separately (modular stacking or one assembly)' }, 'Line up parts…');
  btn.addEventListener('click', () => alignDialog(app).catch(err => notice('Align texture', err.message)));
  anchor.after(el('div', { class: 'pds-align' }, btn, _alignStatus));
  updateAlignStatus();
}

async function alignDialog(app) {
  const a = state.align;
  const pos = app.modelFilePositions();
  if (!pos) { await notice('Line up parts', 'The model is rotated in the app. Lining up needs it in its file orientation — reset the rotation first.'); return; }
  // Detected values for this part (shared axis if one is set).
  const xy = a?.xy || fileXY(app);
  const axis = { x: xy.min.x + xy.size.x / 2, y: xy.min.y + xy.size.y / 2 };
  const d = stackDatums(pos, axis);
  const tabs = countTabs(pos, axis, d.seat, d.pitch);
  const num = (v) => el('input', { type: 'text', value: v.toFixed(2), style: 'max-width:80px;flex:none' });
  const seatIn = num(a?.mode === 'modular' ? a.seat : d.seat);
  const pitchIn = num(a?.mode === 'modular' ? a.pitch : d.pitch);
  const rotate = el('input', { type: 'checkbox', checked: a?.mode === 'modular' ? a.rotate : false });
  const posIn = el('input', { type: 'text', value: String(a?.positions || tabs || 3), style: 'max-width:40px;flex:none' });
  const modeVal = a?.mode === 'assembly' ? 'assembly' : 'modular';
  const radio = (v, label) => el('label', {}, el('input', { type: 'radio', name: 'pds-align-mode', value: v, checked: v === modeVal }), ' ' + label);
  const cyl = document.getElementById('mapping-mode')?.value === '3';
  const body = el('div', {},
    el('div', { class: 'row opts' }, radio('modular', 'Modular — any combination of parts'), radio('assembly', 'One assembly file')),
    el('hr'),
    el('p', {}, "Modular: each part's texture starts at its seat and fits a whole number of repeats up to where the next part rests, so every joint matches whatever the order. Give every part the same texture settings (the folder's shared settings) and line each one up."),
    el('div', { class: 'row' }, el('label', {}, 'Bottom joint edge at'), seatIn, el('span', {}, 'mm'),
      el('button', { class: 'pds-btn', onclick: (e) => pickInto(e, 'bottom') }, 'Pick edge…')),
    el('div', { class: 'row' }, el('label', {}, 'Top joint edge'), pitchIn, el('span', {}, 'mm above it'),
      el('button', { class: 'pds-btn', onclick: (e) => pickInto(e, 'top') }, 'Pick edge…')),
    el('p', { class: 'muted' }, 'The joint edges are the level edges where this part meets the parts below and above (shown in yellow). Pick them on the model if the detected ones are wrong.'),
    el('p', { class: 'muted' }, `Detected: next part at ${d.pitch.toFixed(2)} mm${tabs ? `, ${tabs} tabs` : ''}. On the top piece this is where a cap would sit.`),
    el('div', { class: 'row' }, el('label', {}, rotate, ' Parts may sit rotated by one tab position —'), posIn, el('span', {}, 'positions')),
    !cyl ? el('p', { class: 'muted' }, 'Rotation only works with Cylindrical projection (Mode).') : null,
    el('p', { class: 'muted' }, 'All parts must be exported around the same axis (same XY coordinates), as CAD exports of one assembly are.'),
    el('hr'),
    el('p', { class: 'muted' }, 'One assembly file: lines the texture up exactly as the parts sit in an assembly STL (an exploded one is stacked first).'),
    a ? el('p', { class: 'muted' }, `Now: ${_alignStatus?.textContent || ''}`) : null);
  const rings = () => {
    const seat = parseFloat(seatIn.value), pitch = parseFloat(pitchIn.value);
    if (Number.isFinite(seat)) showJointRings(app, seat, Number.isFinite(pitch) && pitch > 0 ? seat + pitch : null);
  };
  // Hide the dialog, let the user click an edge, put the height in the field.
  async function pickInto(e, which) {
    const overlay = e.target.closest('.pds-modal');
    overlay.style.display = 'none';
    const z = await pickEdgeHeight(app, which === 'bottom'
      ? 'Click the edge where this part sits on the part below'
      : 'Click the edge where the next part sits on this one');
    overlay.style.display = '';
    if (z == null) return;
    const seat = parseFloat(seatIn.value);
    if (which === 'bottom') {
      const top = Number.isFinite(seat) ? seat + (parseFloat(pitchIn.value) || 0) : null;
      seatIn.value = z.toFixed(2);
      if (top != null) pitchIn.value = Math.max(0, top - z).toFixed(2);
    } else pitchIn.value = Math.max(0, z - (Number.isFinite(seat) ? seat : 0)).toFixed(2);
    rings();
  }
  seatIn.addEventListener('change', rings);
  pitchIn.addEventListener('change', rings);
  rings();
  const choice = await modal('Line up parts', body, [
    { label: 'Cancel', value: null },
    a ? { label: 'Remove', value: 'clear' } : null,
    { label: 'Apply', value: 'apply', primary: true },
  ].filter(Boolean), { live: true }); // keep the view orbit-able to check the joint rings
  hideJointRings(); // the rings are only shown while this dialog is open
  if (choice === 'clear') return clearAlign(app);
  if (choice !== 'apply') return;
  const mode = body.querySelector('input[name="pds-align-mode"]:checked').value;
  if (mode === 'modular') {
    const seat = parseFloat(seatIn.value), pitch = parseFloat(pitchIn.value);
    alignModular(app, { xy, rotate: rotate.checked, positions: Math.max(1, parseInt(posIn.value, 10) || 1) },
      { seat: Number.isFinite(seat) ? seat : undefined, pitch: Number.isFinite(pitch) ? pitch : undefined });
    return;
  }
  const { path } = await call('pick-file', { title: 'Choose the assembly STL', types: [['STL', '*.stl'], ['All files', '*.*']],
    initial: a?.assembly || state.dest });
  if (!path || !(await alignTo(app, path))) return;
  const h = el('input', { type: 'text', value: state.align.height.toFixed(2), style: 'max-width:90px;flex:none' });
  const ok = await modal('Line up parts', el('div', {},
    el('p', {}, state.align.stacked
      ? 'The assembly is exploded, so its parts were stacked: each one set on the rim of the part below.'
      : 'Found this part in the assembly.'),
    el('div', { class: 'row' }, el('label', {}, "This part's bottom sits at "), h, el('span', {}, ' mm in the stack')),
    el('p', { class: 'muted' }, 'If it really seats lower or higher, type the height.')),
    [{ label: 'OK', value: 1, primary: true }]);
  const v = parseFloat(h.value);
  if (ok && Number.isFinite(v) && Math.abs(v - state.align.height) > 1e-3) await alignTo(app, path, { zOverride: v });
}

// ── Opening files with a known location ────────────────────────────────────
const MODEL_TYPES = [['3D models', '*.stl *.obj *.3mf *.step *.stp'], ['All files', '*.*']];
const PROJECT_TYPES = [['BumpMesh project', '*.bumpmesh'], ['All files', '*.*']];

function pdsInfo(bytes) {
  try { return JSON.parse(strFromU8(unzipSync(bytes, { filter: f => f.name === 'settings.json' })['settings.json'])).pds || null; }
  catch { return null; }
}

/** Re-apply alignment saved with a project / shared settings. */
async function restoreAlign(app, info, isOwnProject) {
  const a = info?.align;
  if (!a) return;
  if (isOwnProject && a.frame) {
    state.align = a;
    app.setTextureFrame(a.frame);
    updateAlignStatus();
    return;
  }
  // Shared settings: the frame is per part — work it out for this one.
  if (a.mode === 'modular') alignModular(app, a);
  else if (a.assembly && (await exists(a.assembly)).exists) await alignTo(app, a.assembly, { quiet: true });
}

async function openProject(app, path) {
  const bytes = await readFile(path);
  await app.importProject(new File([bytes], basename(path)), { mode: 'all' }); // opening a project = its model too
  await projectLocated(app, path, bytes);
}

/** A project (already loaded) lives at `path`: take over its job folder, original and line-up. */
async function projectLocated(app, path, bytes) {
  const info = pdsInfo(bytes || await readFile(path));
  adoptLocation(path);
  state.name = info?.name || stem(basename(path));
  state.originalPath = null;
  state.align = null;
  hideJointRings();
  updateAlignStatus();
  const [ps] = await stat([path]);
  rememberVariation(app, path, parseVariation(state.name, basename(path))?.created ?? (ps?.mtime || Date.now() / 1000) * 1000);
  if (info?.originalFile) {
    const cand = join(state.dest, SUB.original, info.originalFile);
    if ((await exists(cand)).exists) state.originalPath = cand;
  }
  await restoreAlign(app, info, true);
}

async function openModel(app, path) {
  await app.handleModelFile(new File([await readFile(path)], basename(path)));
  await modelLocated(app, path);
}

/** A model (already loaded) lives at `path`: remember it, recognise its job folder. */
async function modelLocated(app, path) {
  state.originalPath = path;
  state.name = stem(basename(path));
  state.align = null;
  state.variant = null;
  hideJointRings();
  updateAlignStatus();
  adoptLocation(path);

  // Recognise the job folder: this model's variations, else shared settings.
  const pick = async (file) => {
    const [n, l] = await stat([join(state.dest, SUB.project, file), join(state.dest, LEGACY_PROJECT, file)]);
    return n.exists ? n : l;
  };
  const vars = await listVariations(state.name), s = await pick(SHARED_FILE);
  const shared = s.path;
  if (vars.length) {
    // One variation: just offer it. Several: ask which (newest preselected).
    const own = vars.length === 1
      ? ((await modal('Saved project found',
          el('p', {}, `${basename(vars[0].path)} (made ${new Date(vars[0].created).toLocaleString()}) has this model's settings and selections. Open it?`),
          [{ label: 'Just the model', value: null }, { label: 'Open project', value: 1, primary: true }])) ? vars[0].path : null)
      : await chooseVariation(vars);
    if (own) return openProject(app, own);
  } else if (s.exists) {
    const bytes = await readFile(shared);
    const info = pdsInfo(bytes);
    const c = await modal('Shared settings in this folder',
      el('p', {}, `Apply the folder's shared settings${info?.from ? ` (from ${info.from}, ` : ' ('}saved ${new Date(s.mtime * 1000).toLocaleString()})${info?.align?.mode === 'modular' ? ', lined up for modular stacking' : info?.align?.assembly ? ', aligned to ' + basename(info.align.assembly) : ''}?`),
      [{ label: 'Not now', value: null }, { label: 'Apply', value: 1, primary: true }]);
    if (c) {
      await app.importProject(new File([bytes], SHARED_FILE)); // no model inside → settings only
      await restoreAlign(app, info, false);
    }
  }
}

const openPath = (app, path) => (/\.bumpmesh$/i.test(path) ? openProject(app, path) : openModel(app, path));

/**
 * Files dragged in: the browser gives only name, size and date, so ask the
 * local server where such a file is (open Explorer windows, recent folders).
 * Waits for main.js to finish loading the drop, then carries on as if it had
 * been opened from that location.
 */
function watchDrops(app) {
  document.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    const f = files.find(x => /\.bumpmesh$/i.test(x.name)) || files.find(x => /\.(stl|obj|3mf|step|stp)$/i.test(x.name));
    if (!f) return;
    // Dropped on "Add to project": it joins the open project, which keeps its own folder and name.
    if (e.target.closest?.('[data-drop="add"]') && !/\.bumpmesh$/i.test(f.name)) return;
    const isProject = /\.bumpmesh$/i.test(f.name);
    (async () => {
      const dirs = [state.dest, state.originalPath && dirname(state.originalPath), lsGet('dest', '')].filter(Boolean);
      let path = null;
      try { path = (await call('locate', { name: f.name, size: f.size, mtime: f.lastModified, dirs })).path; } catch {}
      // Wait until the dropped file is the loaded one (STEP may sit in its import dialog).
      const want = stem(f.name);
      for (let i = 0; i < 600 && !isProject && app.modelName() !== want; i++) await new Promise(r => setTimeout(r, 100));
      if (isProject) await new Promise(r => setTimeout(r, 1500));
      if (!path) {
        state.originalPath = null;
        state.name = isProject ? stem(f.name) : want;
        state.align = null; state.variant = null; hideJointRings(); updateAlignStatus();
        return;
      }
      if (isProject) await projectLocated(app, path);
      else if (app.modelName() === want) await modelLocated(app, path);
    })().catch(err => console.warn('[PDS] locating the dropped file failed:', err));
  }, true);
}

function interceptPickers(app) {
  const hook = (selector, title, types) => {
    document.addEventListener('click', async (e) => {
      const lbl = e.target.closest(selector);
      if (!lbl) return;
      e.preventDefault(); e.stopImmediatePropagation();
      try {
        const { path } = await call('pick-file', { title, types, initial: state.originalPath || state.dest });
        if (path) await openPath(app, path);
      } catch (err) { notice('Open', err.message); }
    }, true);
  };
  hook('label[for="stl-file-input"]', 'Open model', MODEL_TYPES);
  hook('label[for="import-project-input"]', 'Open project', PROJECT_TYPES);
}

// ── Export ──────────────────────────────────────────────────────────────────
function textureLabel(app) {
  const names = [...new Set(app.textureNames().map(safe))];
  return names.length ? names.join('+') : 'textured';
}

// ── Vary Setting: several versions of one export ──────────────────────────────────────────
// One setting is stepped through a list of values, one model file per value
// ("<name>_<textures>_smooth5.stl"), e.g. to compare print times. The sliders
// are driven like a click, so every handler runs exactly as for a user drag.
const VARY = {
  smoothing: { label: 'Texture smoothing', slider: 'texture-smoothing', tag: 'smooth', dflt: '0, 4, 8' },
  height:    { label: 'Texture height (mm)', slider: 'amplitude', tag: 'height', dflt: '0.3, 0.5, 0.8' },
  res:       { label: 'Resolution (mm)', slider: 'refine-length', tag: 'res', dflt: '0.5, 0.75, 1' },
  tris:      { label: 'Output triangles', slider: 'max-triangles', tag: 'tris', dflt: '250000, 500000, 750000', name: v => `${Math.round(v / 1000)}k` },
};
const varyNum = (key, v) => (VARY[key].name ? VARY[key].name(v) : String(v).replace('.', 'p'));
/** Valid, distinct values from "0, 4 8" within the slider's range and snapped to its step (at most 12). */
function parseVaryValues(text, key) {
  const s = document.getElementById(VARY[key].slider);
  const lo = parseFloat(s.min), hi = parseFloat(s.max), step = parseFloat(s.step);
  const snap = (v) => (step > 0 ? +(lo + Math.round((v - lo) / step) * step).toFixed(6) : v);
  return [...new Set(String(text).split(/[\s,;]+/).map(parseFloat).filter(Number.isFinite).map(v => snap(Math.min(hi, Math.max(lo, v)))))].slice(0, 12);
}
/** File names (no extension) for the ticked variants: "<name>_<variant name>", numbered when two share a name. */
function variantStems(vs, name) {
  const seen = new Map();
  return vs.map((v) => {
    const s = `${name}_${safe(v.label)}`;
    const c = (seen.get(s) || 0) + 1;
    seen.set(s, c);
    return c > 1 ? `${s}_${c}` : s;
  });
}
/**
 * File names (no extension) of the model files an export writes, one per ticked variant × value of the
 * varied setting (either may be absent): [{ variantId, value, stem }]. Variants alone are
 * "<name>_<variant>", values alone "<name>_<textures>_<tag><value>", both "<name>_<variant>_<tag><value>".
 */
function exportStems(variants, vary, name, tl) {
  const base = variants.length ? variantStems(variants, name) : [`${name}_${tl}`];
  const vlist = variants.length ? variants : [null];
  const values = vary ? vary.values : [null];
  return vlist.flatMap((v, i) => values.map(value => ({
    variantId: v ? v.id : undefined,
    value,
    stem: value == null ? base[i] : `${base[i]}_${VARY[vary.key].tag}${varyNum(vary.key, value)}`,
    // Each variant / varied value gets its own folder under Textured, e.g. "Textured\Bricks\Smooth 5\".
    dir: join(v ? base[i].slice(name.length + 1).replace(/_/g, ' ') : '',
      value == null ? '' : `${VARY[vary.key].tag[0].toUpperCase()}${VARY[vary.key].tag.slice(1)} ${varyNum(vary.key, value)}`),
  })));
}
function setVary(key, value) {
  const s = document.getElementById(VARY[key].slider);
  s.value = value;
  s.dispatchEvent(new Event('input', { bubbles: true }));
}

async function exportDialog(app) {
  if (!app.canExport()) { await notice('Export', 'Load a model and pick a texture first (or wait for the current export to finish).'); return; }
  if (!state.name) state.name = app.modelName();
  await state.variantReady;
  const fpNow = await fingerprint(app);
  // A loaded variation saved unchanged is refreshed; anything else is a new variation.
  const projectFile = (name) => (state.variant && state.variant.fp === fpNow && parseVariation(name, basename(state.variant.path)))
    ? basename(state.variant.path) : variationFile(name, textureLabel(app), Date.now());

  const nameIn = el('input', { type: 'text', value: state.name });
  const destBox = el('span', { class: 'path', title: state.dest || '' }, state.dest || 'No folder chosen');
  const pickDest = async () => {
    const { path } = await call('pick-folder', { title: 'Choose the export folder', initial: state.dest || (state.originalPath && dirname(state.originalPath)) });
    if (path) { state.dest = path; destBox.textContent = path; destBox.title = path; refresh(); }
  };
  const chk = (k, d) => el('input', { type: 'checkbox', checked: lsGet(k, d) === '1' });
  const radio = (group, v, label, cur) => el('label', {}, el('input', { type: 'radio', name: group, value: v, checked: v === cur }), ' ' + label);

  const doModel = chk('do-model', '1'), doProj = chk('do-proj', '1'), doShared = chk('do-shared', '1'), doOrig = chk('do-orig', '1');
  if (!state.originalPath) doOrig.checked = false; // nothing to copy until it's located
  const fmt = lsGet('format', '3mf');
  const fmtBox = el('span', { class: 'opts' }, radio('pds-fmt', '3mf', '3MF', fmt), radio('pds-fmt', 'stl', 'STL', fmt));
  const origMode = lsGet('orig-mode', 'copy');
  const origModes = el('span', { class: 'opts' }, radio('pds-orig', 'copy', 'Copy', origMode), radio('pds-orig', 'move', 'Move', origMode));
  const origBox = el('span', { class: 'path', title: state.originalPath || '' }, state.originalPath || 'Location unknown — use Locate…');
  const pickOrig = async () => {
    const { path } = await call('pick-file', { title: 'Locate the original model', types: MODEL_TYPES, initial: state.dest });
    if (path) { state.originalPath = path; origBox.textContent = path; origBox.title = path; doOrig.checked = true; refresh(); }
  };
  const item = (box, label, ...rest) => el('div', { class: 'item' }, el('label', {}, box, ' ' + label), ...rest);
  const rows = {
    model: item(doModel, 'Textured model', fmtBox),
    proj: item(doProj, state.variant && state.variant.fp && state.variant.fp !== fpNow ? 'Project (changed: saved as a new variation)' : 'Project (settings + selections)'),
    shared: item(doShared, 'Shared settings for this folder'),
    orig: item(doOrig, 'Original model', origModes),
  };
  const origPathRow = el('div', { class: 'item sub' }, origBox, el('button', { class: 'pds-btn', onclick: pickOrig }, 'Locate…'));
  // Vary Setting: one setting stepped through a list of values.
  const doVary = chk('do-vary', '0');
  const varyKey = el('select', {}, Object.entries(VARY).map(([k, v]) => el('option', { value: k, selected: k === (VARY[lsGet('vary-key', '')] ? lsGet('vary-key', '') : 'smoothing') }, v.label)));
  const varyText = el('input', { type: 'text', value: lsGet('vary-values-' + varyKey.value, VARY[varyKey.value].dflt), size: 14, title: 'Values separated by commas, e.g. 0, 4, 8' });
  const varyRow = el('div', { class: 'item sub' }, varyKey, ' ', varyText);
  // Variants (the chips beside the bottom bar): one model file per ticked variant.
  const vlist = app.variants ? app.variants.list() : [];
  const vchks = vlist.map(v => ({ v, box: el('input', { type: 'checkbox', checked: true }) }));
  const variantsNow = () => (doModel.checked ? vchks.filter(x => x.box.checked).map(x => x.v) : []);
  const variantRows = vlist.length ? [
    el('div', { class: 'item sub muted' }, 'Variants (none ticked = the current settings):'),
    ...vchks.map(({ v, box }) => el('div', { class: 'item sub' }, el('label', {}, box, ` ${v.num} · ${v.label}`))),
  ] : [];
  // Models of the project: every ticked one is exported in turn (none ticked = the loaded one).
  const mlist = app.models ? app.models.list() : [];
  const startId = mlist.length ? app.models.activeId() : null;
  const mchks = mlist.length > 1 ? mlist.map(m => ({ m, box: el('input', { type: 'checkbox', checked: true }) })) : [];
  const modelsNow = () => (doModel.checked ? mchks.filter(x => x.box.checked).map(x => x.m) : []);
  const modelRows = mchks.length ? [
    el('div', { class: 'item sub muted' }, 'Models (none ticked = the loaded model):'),
    ...mchks.map(({ m, box }) => el('div', { class: 'item sub' }, el('label', {}, box, ` ${m.name}`))),
  ] : [];
  const varyNow = () => (doVary.checked && doModel.checked ? parseVaryValues(varyText.value, varyKey.value) : null);
  rows.vary = item(doVary, 'Vary Setting');
  const warn = el('div', { class: 'item sub' });
  varyKey.addEventListener('change', () => { varyText.value = lsGet('vary-values-' + varyKey.value, VARY[varyKey.value].dflt); refresh(); });
  const where = el('div', { class: 'muted' });
  const fmtNow = () => fmtBox.querySelector('input:checked').value;
  function refresh() {
    const n = safe(nameIn.value.trim() || app.modelName() || 'model');
    const jd = state.dest ? jobDir(n).slice(state.dest.length + 1) : n; // '' when the export folder is already the model's
    rows.model.classList.toggle('off', !doModel.checked);
    rows.orig.classList.toggle('off', !doOrig.checked);
    origPathRow.classList.toggle('off', !doOrig.checked);
    const vs = variantsNow();
    rows.vary.classList.toggle('off', !doModel.checked);
    varyRow.classList.toggle('off', !doVary.checked || !doModel.checked);
    const vv = varyNow();
    const varyOpt = vv && vv.length ? { key: varyKey.value, values: vv } : null;
    const ms = modelsNow();
    // The loaded model uses the Name field, the others their own names.
    const exporting = !doModel.checked ? [] : ms.length > 1 || (ms.length && ms[0].id !== startId)
      ? ms.map(m => ({ name: m.id === startId ? n : safe(m.name) })) : [{ name: n }];
    const modelLines = exporting.flatMap(({ name }) => {
      const dir = state.dest ? jobDir(name).slice(state.dest.length + 1) : name;
      // Each run's model sits in its own folder under Textured, with the project that made it.
      return exportStems(vs, varyOpt, name, textureLabel(app)).flatMap(s => {
        const d = `${dir ? dir + '\\' : ''}${SUB.textured}\\${s.dir ? s.dir + '\\' : ''}`;
        return [`${d}${s.stem}.${fmtNow()}`, doProj.checked && s.dir && `${d}${s.stem}.bumpmesh`].filter(Boolean);
      });
    });
    const pre = jd ? jd + '\\' : '';
    // Models × variants × values multiply the files; say so before it happens.
    const factors = [exporting.length > 1 && ['models', exporting.length], vs.length && ['variants', vs.length], vv && vv.length && ['values', vv.length]].filter(Boolean);
    warn.textContent = factors.length > 1
      ? `${factors.map(f => `${f[1]} ${f[0]}`).join(' × ')} = ${modelLines.filter(l => !l.endsWith('.bumpmesh')).length} model files.` : '';
    warn.classList.toggle('hidden', !warn.textContent);
    const lines = [
      ...modelLines,
      doProj.checked && `${pre}${SUB.project}\\${projectFile(n)}`,
      doShared.checked && `${pre}${SUB.project}\\${SHARED_FILE}`,
      doOrig.checked && state.originalPath && `${pre}${SUB.original}\\${basename(state.originalPath)}`,
    ].filter(Boolean);
    where.replaceChildren(el('div', {}, lines.length ? 'Writes:' : 'Nothing selected'), el('ul', {}, lines.map(l => el('li', {}, l))));
  }
  for (const x of [nameIn, doModel, doProj, doShared, doOrig, doVary, varyText, ...vchks.map(c => c.box), ...mchks.map(c => c.box)]) x.addEventListener('input', refresh);
  fmtBox.addEventListener('change', refresh);
  refresh();

  const body = el('div', {},
    el('div', { class: 'row' }, el('label', { class: 'k' }, 'Folder'), destBox, el('button', { class: 'pds-btn', onclick: pickDest }, 'Browse…')),
    el('div', { class: 'row' }, el('label', { class: 'k' }, 'Name'), nameIn),
    el('hr'),
    rows.model, ...modelRows, ...variantRows, rows.vary, varyRow, warn, rows.proj, rows.shared, rows.orig, origPathRow,
    el('hr'),
    where);

  for (;;) {
    const go = await modal('Export', body, [{ label: 'Cancel', value: null }, { label: 'Export', value: 'go', primary: true }]);
    if (!go) return;
    const opts = {
      format: doModel.checked ? fmtNow() : null,
      project: doProj.checked,
      shared: doShared.checked,
      originalMode: doOrig.checked ? origModes.querySelector('input:checked').value : 'none',
      vary: null,
      variants: variantsNow(),
    };
    const vv = varyNow();
    if (vv && vv.length) opts.vary = { key: varyKey.value, values: vv };
    let problem = null;
    if (doVary.checked && doModel.checked && !vv.length) problem = 'Enter at least one value for the setting to vary (e.g. 0, 4, 8).';
    else if (!state.dest) problem = 'Choose a folder to export into.';
    else if (!opts.format && !opts.project && !opts.shared && opts.originalMode === 'none') problem = 'Tick at least one thing to export.';
    else if (opts.originalMode !== 'none' && !state.originalPath) problem = 'The original model\'s location is unknown — use Locate…, or untick "Original model".';
    if (problem) { await notice('Export', problem); continue; }
    const picked = modelsNow();
    const counts = [picked.length > 1 && picked.length, opts.variants.length, opts.vary && opts.vary.values.length].filter(Boolean);
    if (counts.length > 1) {
      const count = counts.reduce((a, b) => a * b, 1);
      const ok = await modal('Many files', el('p', {}, `${counts.join(' × ')} = ${count} model files (${[picked.length > 1 && 'models', opts.variants.length && 'variants', opts.vary && `values of "${VARY[opts.vary.key].label}"`].filter(Boolean).join(' × ')}), and every one is a full texturing run. Continue?`),
        [{ label: 'Back', value: null }, { label: `Export ${count} files`, value: 1, primary: true }]);
      if (!ok) continue;
    }
    lsSet('dest', state.dest);
    lsSet('do-model', doModel.checked ? '1' : '0'); lsSet('do-proj', doProj.checked ? '1' : '0');
    lsSet('do-shared', doShared.checked ? '1' : '0'); lsSet('do-orig', doOrig.checked ? '1' : '0');
    lsSet('format', fmtNow());
    lsSet('do-vary', doVary.checked ? '1' : '0'); lsSet('vary-key', varyKey.value); lsSet('vary-values-' + varyKey.value, varyText.value);
    if (doOrig.checked) lsSet('orig-mode', opts.originalMode);
    state.name = nameIn.value.trim() || app.modelName();
    const others = picked.filter(m => m.id !== startId);
    if (!others.length) {
      // The loaded model only (ticked, or none ticked), unless another single one is chosen below.
      await runExport(app, opts, fpNow);
      return;
    }
    // Other models of the project: each is loaded in turn and exported under its own name
    // (textured files only), then the loaded model again with the project / shared / original.
    const mine = state.name, sink = [];
    let ok = true;
    try {
      for (const m of others) {
        if (!(ok = await app.models.swapTo(m.id))) break;
        state.name = m.name;
        if (!(ok = await runExport(app, { ...opts, project: false, shared: false, originalMode: 'none' }, fpNow, sink))) break;
      }
    } finally {
      state.name = mine;
      await app.models.swapTo(startId);
    }
    if (ok) {
      const withMine = picked.some(m => m.id === startId);
      await runExport(app, withMine ? opts : { ...opts, format: null }, fpNow, sink);
    }
    if (sink.length) {
      app.showSponsorOverlay();
      const done = await modal('Exported', el('div', {},
        el('p', {}, `Saved to ${state.dest}`),
        el('ul', {}, sink.map(p => el('li', {}, p.slice(state.dest.length + 1))))),
        [{ label: 'Open folder', value: 'open' }, { label: 'Done', value: null, primary: true }]);
      if (done === 'open') await call('open-folder', { path: state.dest });
    }
    return;
  }
}

/**
 * Bring a job folder from before the rename up to date: "project files" →
 * "Texture Settings", "textured" → "Textured" (a case-only rename goes
 * through a temporary name; Windows paths ignore case).
 */
async function migrateFolders(dest) {
  const names = (await call('list', { dir: dest })).items.filter(i => i.isDir).map(i => i.name);
  if (names.includes(LEGACY_PROJECT) && !names.some(n => n.toLowerCase() === SUB.project.toLowerCase())) {
    await call('move', { src: join(dest, LEGACY_PROJECT), dst: join(dest, SUB.project) });
  }
  for (const target of [SUB.textured, SUB.original]) {
    const cur = names.find(n => n.toLowerCase() === target.toLowerCase());
    if (cur && cur !== target) {
      const tmp = join(dest, `${target}.renaming`);
      await call('move', { src: join(dest, cur), dst: tmp });
      await call('move', { src: tmp, dst: join(dest, target) });
    }
  }
}

/** Writes one model's export; false = cancelled or failed. With `sink` (an array) the written paths are added to it and no summary is shown. */
async function runExport(app, { format, project, shared, originalMode, vary, variants = [] }, fp, sink = null) {
  const job = jobDir(state.name);
  try { await migrateFolders(job); } catch {} // a new model folder has nothing to migrate
  const name = safe(state.name), tl = textureLabel(app);
  const texturedDir = join(job, SUB.textured);
  // One model file, or one per ticked variant and/or per value of the setting being varied.
  const runs = !format ? [] : exportStems(variants, vary, name, tl).map(s => ({ variantId: s.variantId, value: s.value, target: join(texturedDir, s.dir, `${s.stem}.${format}`), dir: s.dir }));
  // Project = a variation: the loaded one refreshed when nothing changed, else a new one.
  const cur = state.variant;
  const refresh = !!(cur && cur.fp === fp && parseVariation(name, basename(cur.path)));
  let projectPath = null, created = Date.now();
  if (project && refresh) { projectPath = join(job, SUB.project, basename(cur.path)); created = cur.created; }
  else if (project) {
    const base = variationFile(name, tl, created).replace(/\.bumpmesh$/, '');
    projectPath = join(job, SUB.project, `${base}.bumpmesh`);
    // Two variations in the same minute must not collide.
    for (let k = 2; (await exists(projectPath)).exists; k++) projectPath = join(job, SUB.project, `${base} (${k}).bumpmesh`);
  }
  const sharedPath = join(job, SUB.project, SHARED_FILE);
  const origName = state.originalPath ? basename(state.originalPath) : null;
  const origTarget = origName ? join(job, SUB.original, origName) : null;
  const origAlreadyThere = !!(origTarget && state.originalPath.toLowerCase() === origTarget.toLowerCase());
  const doOrig = originalMode !== 'none' && origTarget && !origAlreadyThere;

  // ── Same name already here? Archive the old files first. ──
  // (Projects never get replaced: they are variations. A textured file is only
  // replaced when its name — model + textures — is the same.)
  const old = [];
  for (const r of runs) { const t = await exists(r.target); if (t.exists) old.push(t); }
  if (doOrig) { const o = await exists(origTarget); if (o.exists) old.push(o); }
  if (old.length) {
    const when = old.reduce((a, b) => (b.mtime > a.mtime ? b : a)).mtime * 1000;
    const ok = await modal(`"${name}" already exists here`,
      el('div', {},
        el('p', {}, `Last edited ${new Date(when).toLocaleString()}. Archive the old files and replace them?`),
        el('ul', {}, old.map(o => el('li', {}, o.path.slice(job.length + 1)))),
        el('p', { class: 'muted' }, `They'll be moved to ${SUB.archive}\\${name} ${stamp(when)}\\`)),
      [{ label: 'Cancel', value: null }, { label: 'Archive and replace', value: 1, primary: true }]);
    if (!ok) return false;
    // Unique folder: two archives in the same minute must not collide.
    let archiveDir = join(job, SUB.archive, `${name} ${stamp(when)}`);
    for (let k = 2; (await exists(archiveDir)).exists; k++) archiveDir = join(job, SUB.archive, `${name} ${stamp(when)} (${k})`);
    for (const o of old) await call('move', { src: o.path, dst: join(archiveDir, o.path.slice(job.length + 1)) });
  }

  const written = [];
  // ── Textured model: files caught instead of downloaded. ──
  if (runs.length) {
    const slider = vary && document.getElementById(VARY[vary.key].slider);
    // Export the live settings into one file; false = failed or cancelled.
    const exportRun = async (r) => {
      const caught = [];
      setDownloadSink((blob, filename) => caught.push({ blob, filename }));
      try { await app.handleExport([format]); }
      finally { setDownloadSink(null); }
      if (caught.length !== 1) { // failed or cancelled (main.js already said why)
        if (written.length) await notice('Export stopped', `Only ${written.length} of ${runs.length} versions were written.`);
        return false;
      }
      await writeFile(r.target, caught[0].blob);
      written.push(r.target);
      // Alongside it, the project with the settings that made it (a folder per run only).
      if (project && r.dir) {
        const zip = await app.buildProjectZip({ pds: { name: state.name, originalFile: origName, textures: app.textureNames(), align: state.align ? { ...state.align } : null } });
        const p = r.target.replace(/\.[^.\\]+$/, '.bumpmesh');
        await writeFile(p, new Blob([zip]));
        written.push(p);
      }
      return true;
    };
    // Export a set of runs under the current settings, stepping the varied slider through its
    // values; the slider is put back afterwards, so the project below saves the settings as they were.
    const runSet = async (rs) => {
      const before = slider && slider.value;
      try {
        for (const r of rs) {
          if (vary) setVary(vary.key, r.value);
          if (!(await exportRun(r))) return false;
        }
        return true;
      } finally {
        if (slider) setVary(vary.key, before);
      }
    };
    let ok = true;
    if (variants.length) {
      // Each variant is restored in turn; the settings from before come back afterwards.
      await app.variants.runEach(variants.map(v => v.id), async (id) => (ok = await runSet(runs.filter(r => r.variantId === id))));
    } else {
      ok = await runSet(runs);
    }
    if (!ok) return false;
    if (!sink) app.showSponsorOverlay();
  }

  const align = state.align ? { ...state.align } : null;
  // What other parts reuse: the mode and its shared parts (axis, rotation,
  // assembly), not this part's own datums.
  const sharedAlign = !align ? null : align.mode === 'modular'
    ? { mode: 'modular', xy: align.xy, rotate: align.rotate, positions: align.positions }
    : { mode: 'assembly', assembly: align.assembly };
  // ── Project (settings, selections, model, custom textures). ──
  if (project) {
    const zip = await app.buildProjectZip({ pds: { name: state.name, originalFile: origName, textures: app.textureNames(), align } });
    await writeFile(projectPath, new Blob([zip]));
    written.push(projectPath);
    state.variant = { path: projectPath, created, fp };
    state.variantReady = null;
  }
  // ── Shared settings for the folder (no model, no selections). ──
  if (shared) {
    const zip = await app.buildSettingsZip({ pds: { from: state.name, textures: app.textureNames(), align: sharedAlign } });
    await writeFile(sharedPath, new Blob([zip]));
    written.push(sharedPath);
  }
  // ── Original. ──
  if (doOrig) {
    await call(originalMode === 'move' ? 'move' : 'copy', { src: state.originalPath, dst: origTarget });
    if (originalMode === 'move') state.originalPath = origTarget;
    written.push(origTarget);
  }

  if (sink) { sink.push(...written); return true; }
  const done = await modal('Exported', el('div', {},
    el('p', {}, `Saved to ${job}`),
    el('ul', {}, written.map(p => el('li', {}, p.slice(job.length + 1))))),
    [{ label: 'Open folder', value: 'open' }, { label: 'Done', value: null, primary: true }]);
  if (done === 'open') await call('open-folder', { path: job });
  return true;
}

function initExportButton(app) {
  for (const id of ['export-btn', 'export-3mf-btn', 'export-project-btn']) {
    const b = document.getElementById(id);
    if (b) b.style.display = 'none';
  }
  const btn = el('button', { class: 'export-btn', id: 'pds-export-btn', title: 'Export the textured model, the project, shared settings and the original into a folder' }, 'Export…');
  btn.addEventListener('click', () => exportDialog(app).catch(err => notice('Export failed', err.message)));
  // Right after Preview Export (inside the export buttons row).
  const preview = document.getElementById('preview-export-btn');
  if (preview) preview.after(btn); else document.querySelector('.export-buttons')?.append(btn);
  // Follow the hidden STL button's enabled state.
  const src = document.getElementById('export-btn');
  const sync = () => { btn.disabled = !!src?.disabled; };
  if (src) new MutationObserver(sync).observe(src, { attributes: true, attributeFilter: ['disabled'] });
  sync();
}

// ── Opened with a file (double-clicked .bumpmesh / model) ───────────────────
async function openFromLaunch(app) {
  const m = location.search.match(/[?&]open=([^&]*)/);
  if (!m) return;
  // escape()-encoded by launch.vbs (VBScript has no encodeURIComponent).
  const path = unescape(m[1]);
  history.replaceState(null, '', location.pathname);
  // Let the start-up model and textures settle before replacing them.
  for (let i = 0; i < 50 && !app.hasModel(); i++) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 800));
  try { await openPath(app, path); }
  catch (err) { notice('Open', `Couldn't open ${path}: ${err.message}`); }
}

// ── Entry point ─────────────────────────────────────────────────────────────
export async function initPersonal(app) {
  const v = document.getElementById('app-version');
  if (v) v.textContent = `v${APP_VERSION} · ${EDITION}`;
  injectStyle();
  initColours(app);
  initSettingsMenu(app);
  if (!(await connect())) return; // plain web page: no local file features
  onLogoIcon((frames) => call('app-icon', { frames }));   // launcher/icon.ico in the theme colour
  interceptPickers(app);
  watchDrops(app);
  initExportButton(app);
  initAlignControl(app);
  openFromLaunch(app);
}

// For tests (debug harness): pure helpers.
export const _test = { locateInAssembly, stackAssembly, stackDatums, countTabs, sharpEdges, ringAt, parseSTL, safe };
