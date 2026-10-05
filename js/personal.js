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
 *  - Preview colours for textured / untextured surfaces (remembered).
 *  - With the desktop launcher's local server (launcher/serve.py):
 *      · Load Model / Load project open a native picker, so the file's real
 *        location is known;
 *      · one Export button writes, into a job folder (each item optional):
 *          textured\<name>_<textures>.3mf|.stl
 *          project files\<name>.bumpmesh            settings + selections + model
 *          project files\_shared settings.bumpmesh  settings for every model here
 *          Original\<original file>                 copied or moved there
 *        and, when <name> already exists there, archives the old files into
 *        Archive\<name> <last edit time>\ before replacing them;
 *      · opening a model from a job folder offers its saved project, else the
 *        folder's shared settings;
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
  .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'texture';
const SUB = { textured: 'textured', project: 'project files', original: 'Original', archive: 'Archive' };

function stamp(ms) {
  const d = new Date(ms), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}${z(d.getMinutes())}`;
}

function lsGet(k, d) { try { return localStorage.getItem(LS + k) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(LS + k, v); } catch {} }

// ── State: where this job lives ─────────────────────────────────────────────
const state = {
  originalPath: null,   // the model file on disk, when known
  dest: lsGet('dest', ''),
  name: '',
  align: null,          // { assembly: path, frame: {min,size}, offset: {x,y,z} } for the loaded model
};

/** A model/project opened from <dest>\Original\ or <dest>\project files\ belongs to <dest>. */
function adoptLocation(path) {
  const dir = dirname(path), up = basename(dir).toLowerCase();
  state.dest = (up === SUB.original.toLowerCase() || up === SUB.project.toLowerCase()) ? dirname(dir) : dir;
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
    .pds-modal { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center;
      justify-content: center; z-index: 10000; }
    .pds-card { background: var(--surface); color: var(--text); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 18px 20px; width: min(600px, calc(100vw - 32px));
      box-shadow: 0 12px 40px rgba(0,0,0,.45); font-size: 13px; }
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
    .pds-align { display: flex; gap: 8px; align-items: center; margin-top: 8px; font-size: 12px; }
    .pds-align .muted { color: var(--text-muted); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `));
}

/** Modal with buttons; resolves to the clicked button's value (null on Escape). */
function modal(title, body, buttons) {
  return new Promise((resolve) => {
    const close = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    const card = el('div', { class: 'pds-card', role: 'dialog', 'aria-modal': 'true' },
      el('h3', {}, title), body,
      el('div', { class: 'btns' }, buttons.map(b =>
        el('button', { class: 'pds-btn' + (b.primary ? ' primary' : ''), onclick: () => close(b.value) }, b.label))));
    const overlay = el('div', { class: 'pds-modal' }, card);
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    card.querySelector('.primary')?.focus();
  });
}
const notice = (title, text) => modal(title, el('p', {}, text), [{ label: 'OK', value: 1, primary: true }]);

// ── Preview colours ─────────────────────────────────────────────────────────
function initColours(app) {
  const tex = el('input', { type: 'color', value: lsGet('col-tex', '#38adad'), title: 'Textured surfaces' });
  const untex = el('input', { type: 'color', value: lsGet('col-untex', '#d96626'), title: 'Untextured surfaces' });
  const apply = () => {
    lsSet('col-tex', tex.value); lsSet('col-untex', untex.value);
    app.setPreviewColors(tex.value, untex.value);
  };
  tex.addEventListener('input', apply);
  untex.addEventListener('input', apply);
  const box = el('span', { class: 'pds-colors' },
    el('label', { title: 'Preview colour of textured surfaces' }, tex, 'Textured'),
    el('label', { title: 'Preview colour of untextured surfaces' }, untex, 'Untextured'));
  document.getElementById('section-toggle')?.closest('label')?.after(box);
  apply();
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
 * when their heights overlap), then lower each part, bottom up, straight down
 * until it rests on the parts below. Contact is found on height maps (0.5 mm
 * cells): the lower stack's top surface against the part's underside, so tabs
 * going up into slots are fine. Returns each part's z range (as exploded) and
 * the z shift that stacks it.
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
  // Height maps over the XY footprint.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < asm.length; i += 3) { x0 = Math.min(x0, asm[i]); x1 = Math.max(x1, asm[i]); y0 = Math.min(y0, asm[i + 1]); y1 = Math.max(y1, asm[i + 1]); }
  const C = 0.5, W = Math.ceil((x1 - x0) / C) + 1, H = Math.ceil((y1 - y0) / C) + 1;
  const raster = (tris, shift, top) => {
    const m = new Float32Array(W * H).fill(top ? -Infinity : Infinity);
    for (const t of tris) {
      const p = t * 9;
      const e = Math.max(Math.hypot(asm[p + 3] - asm[p], asm[p + 4] - asm[p + 1]), Math.hypot(asm[p + 6] - asm[p], asm[p + 7] - asm[p + 1]), Math.hypot(asm[p + 6] - asm[p + 3], asm[p + 7] - asm[p + 4]));
      const n = Math.max(1, Math.ceil(e / (C * 0.5)));
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
        const a = i / n, b = j / n, c = 1 - a - b;
        const x = asm[p] * c + asm[p + 3] * a + asm[p + 6] * b, y = asm[p + 1] * c + asm[p + 4] * a + asm[p + 7] * b;
        const z = asm[p + 2] * c + asm[p + 5] * a + asm[p + 8] * b + shift;
        const k = Math.round((y - y0) / C) * W + Math.round((x - x0) / C);
        if (top ? z > m[k] : z < m[k]) m[k] = z;
      }
    }
    return m;
  };
  groups[0].shift = 0;
  let stackTop = raster(groups[0].tris, 0, true);
  for (let g = 1; g < groups.length; g++) {
    const bot = raster(groups[g].tris, 0, false);
    let gap = Infinity;
    for (let k = 0; k < bot.length; k++) if (bot[k] !== Infinity && stackTop[k] !== -Infinity) gap = Math.min(gap, bot[k] - stackTop[k]);
    groups[g].shift = gap === Infinity ? 0 : -gap;
    const top = raster(groups[g].tris, groups[g].shift, true);
    for (let k = 0; k < top.length; k++) if (top[k] > stackTop[k]) stackTop[k] = top[k];
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
  state.align = { assembly: assemblyPath, frame, offset, height: pz + offset.z, stacked: groups.length > 1, zOverride };
  app.setTextureFrame(frame);
  updateAlignStatus();
  return true;
}

function clearAlign(app) {
  state.align = null;
  app.setTextureFrame(null);
  updateAlignStatus();
}

let _alignStatus = null;
function updateAlignStatus() {
  if (!_alignStatus) return;
  const a = state.align;
  _alignStatus.textContent = a
    ? `Aligned to ${basename(a.assembly)} — sits at ${a.height.toFixed(2)} mm${a.stacked ? ' (stacked)' : ''}`
    : 'Texture laid out on this model alone';
  _alignStatus.title = a ? a.assembly : '';
}

function initAlignControl(app) {
  const anchor = document.getElementById('mapping-mode')?.closest('.form-row') || document.getElementById('mapping-mode')?.parentElement;
  if (!anchor) return;
  _alignStatus = el('span', { class: 'muted' });
  const btn = el('button', { class: 'pds-btn', title: 'Lay the texture out in an assembly\'s frame so parts printed separately line up' }, 'Align to assembly…');
  btn.addEventListener('click', () => alignDialog(app).catch(err => notice('Align texture', err.message)));
  anchor.after(el('div', { class: 'pds-align' }, btn, _alignStatus));
  updateAlignStatus();
}

async function alignDialog(app) {
  const body = el('div', {},
    el('p', {}, 'Pick the assembly STL (all parts in their assembled positions). The texture is then laid out in the assembly\'s space, so this part continues the texture of the parts around it.'),
    el('p', { class: 'muted' }, 'Use the same texture settings on every part — the folder\'s shared settings do that — and align each one. Parts must sit in the assembly unrotated.'),
    state.align ? el('p', {}, `Now: ${state.align.assembly}`) : null);
  const choice = await modal('Align texture to assembly', body, [
    { label: 'Cancel', value: null },
    state.align ? { label: 'Remove alignment', value: 'clear' } : null,
    { label: 'Choose assembly…', value: 'pick', primary: true },
  ].filter(Boolean));
  if (choice === 'clear') return clearAlign(app);
  if (choice !== 'pick') return;
  const { path } = await call('pick-file', { title: 'Choose the assembly STL', types: [['STL', '*.stl'], ['All files', '*.*']],
    initial: state.align?.assembly || (state.dest && join(state.dest, SUB.original)) || state.dest });
  if (!path || !(await alignTo(app, path))) return;
  const h = el('input', { type: 'text', value: state.align.height.toFixed(2), style: 'max-width:90px;flex:none' });
  const ok = await modal('Align texture', el('div', {},
    el('p', {}, state.align.stacked
      ? 'The assembly is exploded, so its parts were stacked: each one lowered straight down until it rests on the part below.'
      : 'Found this part in the assembly.'),
    el('div', { class: 'row' }, el('label', {}, "This part's bottom sits at "), h, el('span', {}, ' mm in the stack')),
    el('p', { class: 'muted' }, 'If it really seats lower or higher (e.g. a twist lock), type the height. Every part of the assembly needs the same texture settings and its own alignment.')),
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
  if (!a?.assembly) return;
  if (isOwnProject && a.frame) {
    state.align = a;
    app.setTextureFrame(a.frame);
    updateAlignStatus();
    return;
  }
  // Shared settings: the frame is per part — find this part in the assembly.
  if ((await exists(a.assembly)).exists) await alignTo(app, a.assembly, { quiet: true });
}

async function openProject(app, path) {
  const bytes = await readFile(path);
  const info = pdsInfo(bytes);
  await app.importProject(new File([bytes], basename(path)), { mode: 'all' }); // opening a project = its model too
  adoptLocation(path);
  state.name = info?.name || stem(basename(path));
  state.originalPath = null;
  state.align = null;
  updateAlignStatus();
  if (info?.originalFile) {
    const cand = join(state.dest, SUB.original, info.originalFile);
    if ((await exists(cand)).exists) state.originalPath = cand;
  }
  await restoreAlign(app, info, true);
}

async function openModel(app, path) {
  await app.handleModelFile(new File([await readFile(path)], basename(path)));
  state.originalPath = path;
  state.name = stem(basename(path));
  state.align = null;
  updateAlignStatus();
  adoptLocation(path);

  // Recognise the job folder: this model's own project, else shared settings.
  const own = join(state.dest, SUB.project, `${safe(state.name)}.bumpmesh`);
  const shared = join(state.dest, SUB.project, SHARED_FILE);
  const [o, s] = await stat([own, shared]);
  if (o.exists) {
    const c = await modal('Saved project found',
      el('p', {}, `${basename(own)} (saved ${new Date(o.mtime * 1000).toLocaleString()}) has this model's settings and selections. Open it?`),
      [{ label: 'Just the model', value: null }, { label: 'Open project', value: 1, primary: true }]);
    if (c) return openProject(app, own);
  } else if (s.exists) {
    const bytes = await readFile(shared);
    const info = pdsInfo(bytes);
    const c = await modal('Shared settings in this folder',
      el('p', {}, `Apply the folder's shared settings${info?.from ? ` (from ${info.from}` : ' ('}saved ${new Date(s.mtime * 1000).toLocaleString()})${info?.align?.assembly ? ', aligned to ' + basename(info.align.assembly) : ''}?`),
      [{ label: 'Not now', value: null }, { label: 'Apply', value: 1, primary: true }]);
    if (c) {
      await app.importProject(new File([bytes], SHARED_FILE)); // no model inside → settings only
      await restoreAlign(app, info, false);
    }
  }
}

const openPath = (app, path) => (/\.bumpmesh$/i.test(path) ? openProject(app, path) : openModel(app, path));

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

async function exportDialog(app) {
  if (!app.canExport()) { await notice('Export', 'Load a model and pick a texture first (or wait for the current export to finish).'); return; }
  if (!state.name) state.name = app.modelName();

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
    proj: item(doProj, 'Project (settings + selections)'),
    shared: item(doShared, 'Shared settings for this folder'),
    orig: item(doOrig, 'Original model', origModes),
  };
  const origPathRow = el('div', { class: 'item sub' }, origBox, el('button', { class: 'pds-btn', onclick: pickOrig }, 'Locate…'));
  const where = el('div', { class: 'muted' });
  const fmtNow = () => fmtBox.querySelector('input:checked').value;
  function refresh() {
    const n = safe(nameIn.value || 'model');
    rows.model.classList.toggle('off', !doModel.checked);
    rows.orig.classList.toggle('off', !doOrig.checked);
    origPathRow.classList.toggle('off', !doOrig.checked);
    const lines = [
      doModel.checked && `${SUB.textured}\\${n}_${textureLabel(app)}.${fmtNow()}`,
      doProj.checked && `${SUB.project}\\${n}.bumpmesh`,
      doShared.checked && `${SUB.project}\\${SHARED_FILE}`,
      doOrig.checked && state.originalPath && `${SUB.original}\\${basename(state.originalPath)}`,
    ].filter(Boolean);
    where.replaceChildren(el('div', {}, lines.length ? 'Writes:' : 'Nothing selected'), el('ul', {}, lines.map(l => el('li', {}, l))));
  }
  for (const x of [nameIn, doModel, doProj, doShared, doOrig]) x.addEventListener('input', refresh);
  fmtBox.addEventListener('change', refresh);
  refresh();

  const body = el('div', {},
    el('div', { class: 'row' }, el('label', { class: 'k' }, 'Folder'), destBox, el('button', { class: 'pds-btn', onclick: pickDest }, 'Browse…')),
    el('div', { class: 'row' }, el('label', { class: 'k' }, 'Name'), nameIn),
    el('hr'),
    rows.model, rows.proj, rows.shared, rows.orig, origPathRow,
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
    };
    let problem = null;
    if (!state.dest) problem = 'Choose a folder to export into.';
    else if (!opts.format && !opts.project && !opts.shared && opts.originalMode === 'none') problem = 'Tick at least one thing to export.';
    else if (opts.originalMode !== 'none' && !state.originalPath) problem = 'The original model\'s location is unknown — use Locate…, or untick "Original model".';
    if (problem) { await notice('Export', problem); continue; }
    lsSet('dest', state.dest);
    lsSet('do-model', doModel.checked ? '1' : '0'); lsSet('do-proj', doProj.checked ? '1' : '0');
    lsSet('do-shared', doShared.checked ? '1' : '0'); lsSet('do-orig', doOrig.checked ? '1' : '0');
    lsSet('format', fmtNow());
    if (doOrig.checked) lsSet('orig-mode', opts.originalMode);
    state.name = nameIn.value.trim() || app.modelName();
    await runExport(app, opts);
    return;
  }
}

async function runExport(app, { format, project, shared, originalMode }) {
  const name = safe(state.name), tl = textureLabel(app);
  const texturedDir = join(state.dest, SUB.textured);
  const target = format ? join(texturedDir, `${name}_${tl}.${format}`) : null;
  const projectPath = join(state.dest, SUB.project, `${name}.bumpmesh`);
  const sharedPath = join(state.dest, SUB.project, SHARED_FILE);
  const origName = state.originalPath ? basename(state.originalPath) : null;
  const origTarget = origName ? join(state.dest, SUB.original, origName) : null;
  const origAlreadyThere = !!(origTarget && state.originalPath.toLowerCase() === origTarget.toLowerCase());
  const doOrig = originalMode !== 'none' && origTarget && !origAlreadyThere;

  // ── Same name already here? Archive the old files first. ──
  const old = [];
  const [projStat] = await stat([projectPath]);
  if (project && projStat.exists) old.push(projStat);
  if (format) {
    for (const it of (await call('list', { dir: texturedDir })).items) {
      if (!it.isDir && it.name.toLowerCase().startsWith(name.toLowerCase() + '_')) old.push(it);
    }
  }
  if (doOrig) { const o = await exists(origTarget); if (o.exists) old.push(o); }
  if (old.length) {
    const when = (projStat.exists ? projStat : old.reduce((a, b) => (b.mtime > a.mtime ? b : a))).mtime * 1000;
    const ok = await modal(`"${name}" already exists here`,
      el('div', {},
        el('p', {}, `Last edited ${new Date(when).toLocaleString()}. Archive the old files and replace them?`),
        el('ul', {}, old.map(o => el('li', {}, o.path.slice(state.dest.length + 1)))),
        el('p', { class: 'muted' }, `They'll be moved to ${SUB.archive}\\${name} ${stamp(when)}\\`)),
      [{ label: 'Cancel', value: null }, { label: 'Archive and replace', value: 1, primary: true }]);
    if (!ok) return;
    // Unique folder: two archives in the same minute must not collide.
    let archiveDir = join(state.dest, SUB.archive, `${name} ${stamp(when)}`);
    for (let k = 2; (await exists(archiveDir)).exists; k++) archiveDir = join(state.dest, SUB.archive, `${name} ${stamp(when)} (${k})`);
    for (const o of old) await call('move', { src: o.path, dst: join(archiveDir, o.path.slice(state.dest.length + 1)) });
  }

  const written = [];
  // ── Textured model: files caught instead of downloaded. ──
  if (format) {
    const caught = [];
    setDownloadSink((blob, filename) => caught.push({ blob, filename }));
    try { await app.handleExport([format]); }
    finally { setDownloadSink(null); }
    if (caught.length !== 1) return; // failed or cancelled (main.js already said why)
    await writeFile(target, caught[0].blob);
    written.push(target);
    app.showSponsorOverlay();
  }

  const align = state.align ? { assembly: state.align.assembly, frame: state.align.frame, offset: state.align.offset } : null;
  // ── Project (settings, selections, model, custom textures). ──
  if (project) {
    const zip = await app.buildProjectZip({ pds: { name: state.name, originalFile: origName, textures: app.textureNames(), align } });
    await writeFile(projectPath, new Blob([zip]));
    written.push(projectPath);
  }
  // ── Shared settings for the folder (no model, no selections). ──
  if (shared) {
    const zip = await app.buildSettingsZip({ pds: { from: state.name, textures: app.textureNames(), align: align && { assembly: align.assembly } } });
    await writeFile(sharedPath, new Blob([zip]));
    written.push(sharedPath);
  }
  // ── Original. ──
  if (doOrig) {
    await call(originalMode === 'move' ? 'move' : 'copy', { src: state.originalPath, dst: origTarget });
    if (originalMode === 'move') state.originalPath = origTarget;
    written.push(origTarget);
  }

  const done = await modal('Exported', el('div', {},
    el('p', {}, `Saved to ${state.dest}`),
    el('ul', {}, written.map(p => el('li', {}, p.slice(state.dest.length + 1))))),
    [{ label: 'Open folder', value: 'open' }, { label: 'Done', value: null, primary: true }]);
  if (done === 'open') await call('open-folder', { path: state.dest });
}

function initExportButton(app) {
  for (const id of ['export-btn', 'export-3mf-btn', 'export-project-btn']) {
    const b = document.getElementById(id);
    if (b) b.style.display = 'none';
  }
  const btn = el('button', { class: 'export-btn', id: 'pds-export-btn', title: 'Export the textured model, the project, shared settings and the original into a folder' }, 'Export…');
  btn.addEventListener('click', () => exportDialog(app).catch(err => notice('Export failed', err.message)));
  document.querySelector('.export-buttons')?.append(btn);
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
  if (!(await connect())) return; // plain web page: no local file features
  interceptPickers(app);
  initExportButton(app);
  initAlignControl(app);
  openFromLaunch(app);
}

// For tests (debug harness): pure helpers.
export const _test = { locateInAssembly, stackAssembly, parseSTL, safe };
