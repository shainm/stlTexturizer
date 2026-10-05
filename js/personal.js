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
 *      · one Export button writes, into a chosen folder:
 *          textured/<name>_<textures>.stl|.3mf
 *          project files/<name>.bumpmesh
 *          Original/<original file>     (copied or moved there)
 *        and, when <name> already exists there, archives the old files into
 *        Archive/<name> <last edit time>/ before replacing them;
 *      · a project or model the launcher was started with (double-clicked
 *        .bumpmesh) opens straight away.
 *    Without the server (opened as a plain web page) the app is unchanged.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { APP_VERSION } from './version.js';
import { setDownloadSink } from './exporter.js';

export const EDITION = 'PDS Edition';
const LS = 'bm-pds-';

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

// ── State: where this job lives ─────────────────────────────────────────────
const state = {
  originalPath: null,   // the model file on disk, when known
  dest: localStorage.getItem(LS + 'dest') || '',
  name: '',
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
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}

function injectStyle() {
  document.head.append(el('style', {}, `
    .pds-modal { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center;
      justify-content: center; z-index: 10000; }
    .pds-card { background: var(--surface); color: var(--text); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 18px 20px; width: min(560px, calc(100vw - 32px));
      box-shadow: 0 12px 40px rgba(0,0,0,.45); font-size: 13px; }
    .pds-card h3 { margin: 0 0 12px; font-size: 15px; }
    .pds-card .row { display: flex; gap: 8px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
    .pds-card label.k { width: 100px; color: var(--text-muted); }
    .pds-card input[type=text] { flex: 1; min-width: 0; background: var(--bg); color: var(--text);
      border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font: inherit; }
    .pds-card .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
    .pds-card .muted { color: var(--text-muted); font-size: 12px; }
    .pds-card .opts label { margin-right: 14px; white-space: nowrap; }
    .pds-card .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
    .pds-btn { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px;
      padding: 6px 12px; cursor: pointer; font: inherit; }
    .pds-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .pds-btn:disabled { opacity: .5; cursor: default; }
    .pds-card ul { margin: 6px 0 0 18px; padding: 0; max-height: 140px; overflow: auto; }
    .pds-colors { display: inline-flex; gap: 10px; align-items: center; margin-left: 8px; }
    .pds-colors label { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; }
    .pds-colors input[type=color] { width: 22px; height: 18px; padding: 0; border: 1px solid var(--border);
      border-radius: 4px; background: none; cursor: pointer; }
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

// ── Preview colours ─────────────────────────────────────────────────────────
function initColours(app) {
  const get = (k, d) => { try { return localStorage.getItem(LS + k) || d; } catch { return d; } };
  const tex = el('input', { type: 'color', value: get('col-tex', '#38adad'), title: 'Textured surfaces' });
  const untex = el('input', { type: 'color', value: get('col-untex', '#d96626'), title: 'Untextured surfaces' });
  const apply = () => {
    try { localStorage.setItem(LS + 'col-tex', tex.value); localStorage.setItem(LS + 'col-untex', untex.value); } catch {}
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

// ── Opening files with a known location ────────────────────────────────────
const MODEL_TYPES = [['3D models', '*.stl *.obj *.3mf *.step *.stp'], ['All files', '*.*']];
const PROJECT_TYPES = [['BumpMesh project', '*.bumpmesh'], ['All files', '*.*']];

async function openPath(app, path) {
  const bytes = await readFile(path);
  const file = new File([bytes], basename(path));
  if (/\.bumpmesh$/i.test(path)) {
    // Where the project's original lives: <dest>\Original\<pds.originalFile>.
    let info = null;
    try { info = JSON.parse(strFromU8(unzipSync(bytes, { filter: f => f.name === 'settings.json' })['settings.json'])).pds; } catch {}
    await app.importProject(file);
    adoptLocation(path);
    state.name = info?.name || stem(basename(path));
    state.originalPath = null;
    if (info?.originalFile) {
      const cand = join(state.dest, SUB.original, info.originalFile);
      if ((await stat([cand]))[0].exists) state.originalPath = cand;
    }
  } else {
    await app.handleModelFile(file);
    state.originalPath = path;
    state.name = stem(basename(path));
    adoptLocation(path);
  }
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
      } catch (err) { alert(err.message); }
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
  if (!app.canExport()) { alert('Load a model and pick a texture first (or wait for the current export to finish).'); return; }
  if (!state.name) state.name = app.modelName();

  const nameIn = el('input', { type: 'text', value: state.name });
  const destBox = el('span', { class: 'path', title: state.dest || '' }, state.dest || 'No folder chosen');
  const pickDest = async () => {
    const { path } = await call('pick-folder', { title: 'Choose the export folder', initial: state.dest || (state.originalPath && dirname(state.originalPath)) });
    if (path) { state.dest = path; destBox.textContent = path; destBox.title = path; }
  };
  const stl = el('input', { type: 'checkbox', checked: localStorage.getItem(LS + 'stl') !== '0' });
  const tmf = el('input', { type: 'checkbox', checked: localStorage.getItem(LS + '3mf') === '1' });
  const proj = el('input', { type: 'checkbox', checked: localStorage.getItem(LS + 'proj') !== '0' });
  const origMode = localStorage.getItem(LS + 'orig') || 'copy';
  const radio = (v, label) => el('label', {}, el('input', { type: 'radio', name: 'pds-orig', value: v, checked: v === origMode }), ' ' + label);
  const origBox = el('span', { class: 'path', title: state.originalPath || '' }, state.originalPath || 'Unknown (opened in the browser)');
  const pickOrig = async () => {
    const { path } = await call('pick-file', { title: 'Locate the original model', types: MODEL_TYPES, initial: state.dest });
    if (path) { state.originalPath = path; origBox.textContent = path; origBox.title = path; }
  };
  const preview = el('div', { class: 'muted' });
  const refresh = () => {
    const n = safe(nameIn.value || 'model'), tl = textureLabel(app);
    preview.textContent = `textured\\${n}_${tl}.${[stl.checked && 'stl', tmf.checked && '3mf'].filter(Boolean).join(' / .') || '…'}`
      + (proj.checked ? `   ·   project files\\${n}.bumpmesh` : '');
  };
  [nameIn, stl, tmf, proj].forEach(x => x.addEventListener('input', refresh));
  refresh();

  const body = el('div', {},
    el('div', { class: 'row' }, el('label', { class: 'k' }, 'Folder'), destBox,
      el('button', { class: 'pds-btn', onclick: pickDest }, 'Browse…')),
    el('div', { class: 'row' }, el('label', { class: 'k' }, 'Name'), nameIn),
    el('div', { class: 'row opts' }, el('label', { class: 'k' }, 'Save'),
      el('label', {}, stl, ' STL'), el('label', {}, tmf, ' 3MF'), el('label', {}, proj, ' Project (settings + selections)')),
    el('div', { class: 'row opts' }, el('label', { class: 'k' }, 'Original'),
      radio('copy', 'Copy to Original'), radio('move', 'Move to Original'), radio('none', 'Leave it')),
    el('div', { class: 'row' }, el('label', { class: 'k' }, ''), origBox,
      el('button', { class: 'pds-btn', onclick: pickOrig }, 'Locate…')),
    el('div', { class: 'row' }, el('label', { class: 'k' }, ''), preview));

  for (;;) {
    const go = await modal('Export', body, [{ label: 'Cancel', value: null }, { label: 'Export', value: 'go', primary: true }]);
    if (!go) return;
    const mode = body.querySelector('input[name="pds-orig"]:checked').value;
    const formats = [stl.checked && 'stl', tmf.checked && '3mf'].filter(Boolean);
    let problem = null;
    if (!state.dest) problem = 'Choose a folder to export into.';
    else if (!formats.length && !proj.checked) problem = 'Pick at least one thing to save.';
    else if (mode !== 'none' && !state.originalPath) problem = 'The original model\'s location is unknown — use Locate…, or choose "Leave it".';
    if (problem) { await modal('Export', el('p', {}, problem), [{ label: 'OK', value: 1, primary: true }]); continue; }
    try {
      localStorage.setItem(LS + 'dest', state.dest);
      localStorage.setItem(LS + 'stl', stl.checked ? '1' : '0');
      localStorage.setItem(LS + '3mf', tmf.checked ? '1' : '0');
      localStorage.setItem(LS + 'proj', proj.checked ? '1' : '0');
      localStorage.setItem(LS + 'orig', mode);
    } catch {}
    state.name = nameIn.value.trim() || app.modelName();
    await runExport(app, { formats, project: proj.checked, originalMode: mode });
    return;
  }
}

async function runExport(app, { formats, project, originalMode }) {
  const name = safe(state.name), tl = textureLabel(app);
  const texturedDir = join(state.dest, SUB.textured);
  const targets = formats.map(f => join(texturedDir, `${name}_${tl}.${f}`));
  const projectPath = join(state.dest, SUB.project, `${name}.bumpmesh`);
  const origName = state.originalPath ? basename(state.originalPath) : null;
  const origTarget = origName ? join(state.dest, SUB.original, origName) : null;
  const origAlreadyThere = !!(origTarget && state.originalPath.toLowerCase() === origTarget.toLowerCase());

  // ── Same name already here? Archive the old files first. ──
  const old = [];
  const [projStat] = await stat([projectPath]);
  if (projStat.exists) old.push(projStat);
  const listing = (await call('list', { dir: texturedDir })).items;
  for (const it of listing) {
    if (!it.isDir && it.name.toLowerCase().startsWith(name.toLowerCase() + '_')) old.push(it);
  }
  for (const it of await stat(targets)) if (it.exists && !old.some(o => o.path === it.path)) old.push(it);
  if (originalMode !== 'none' && origTarget && !origAlreadyThere) {
    const [o] = await stat([origTarget]);
    if (o.exists) old.push(o);
  }
  if (old.length) {
    const when = (projStat.exists ? projStat : old.reduce((a, b) => (b.mtime > a.mtime ? b : a))).mtime * 1000;
    // Unique folder: two archives in the same minute must not collide.
    let archiveDir = join(state.dest, SUB.archive, `${name} ${stamp(when)}`);
    for (let k = 2; (await stat([archiveDir]))[0].exists; k++) {
      archiveDir = join(state.dest, SUB.archive, `${name} ${stamp(when)} (${k})`);
    }
    const ok = await modal(`"${name}" already exists here`,
      el('div', {},
        el('p', {}, `Last edited ${new Date(when).toLocaleString()}. Archive the old files and replace them?`),
        el('ul', {}, old.map(o => el('li', {}, o.path.slice(state.dest.length + 1)))),
        el('p', { class: 'muted' }, `They'll be moved to ${SUB.archive}\\${basename(archiveDir)}\\`)),
      [{ label: 'Cancel', value: null }, { label: 'Archive and replace', value: 1, primary: true }]);
    if (!ok) return;
    for (const o of old) {
      const rel = o.path.slice(state.dest.length + 1);       // e.g. "textured\name_x.stl"
      await call('move', { src: o.path, dst: join(archiveDir, rel) });
    }
  }

  // ── Textured model(s): one pipeline run, files caught instead of downloaded. ──
  if (formats.length) {
    const caught = [];
    setDownloadSink((blob, filename) => caught.push({ blob, filename }));
    try { await app.handleExport(formats); }
    finally { setDownloadSink(null); }
    if (caught.length !== formats.length) return; // failed or cancelled (main.js already said why)
    for (let i = 0; i < formats.length; i++) await writeFile(targets[i], caught[i].blob);
    app.showSponsorOverlay();
  }

  // ── Project (settings, selections, model, custom textures). ──
  if (project) {
    const zip = await app.buildProjectZip({ pds: { name: state.name, originalFile: origName, textures: app.textureNames() } });
    await writeFile(projectPath, new Blob([zip]));
  }

  // ── Original. ──
  if (originalMode !== 'none' && origTarget && !origAlreadyThere) {
    await call(originalMode === 'move' ? 'move' : 'copy', { src: state.originalPath, dst: origTarget });
    if (originalMode === 'move') state.originalPath = origTarget;
  }

  const done = await modal('Exported', el('div', {},
    el('p', {}, `Saved to ${state.dest}`),
    el('ul', {}, [...targets, project && projectPath, originalMode !== 'none' && origTarget]
      .filter(Boolean).map(p => el('li', {}, p.slice(state.dest.length + 1))))),
    [{ label: 'Open folder', value: 'open' }, { label: 'Done', value: null, primary: true }]);
  if (done === 'open') await call('open-folder', { path: state.dest });
}

function initExportButton(app) {
  for (const id of ['export-btn', 'export-3mf-btn', 'export-project-btn']) {
    const b = document.getElementById(id);
    if (b) b.style.display = 'none';
  }
  const btn = el('button', { class: 'export-btn', id: 'pds-export-btn', title: 'Export the textured model, the project and the original into a folder' }, 'Export…');
  btn.addEventListener('click', () => exportDialog(app).catch(err => alert('Export failed: ' + err.message)));
  const row = document.querySelector('.export-buttons');
  row?.append(btn);
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
  catch (err) { alert(`Couldn't open ${path}: ${err.message}`); }
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
  openFromLaunch(app);
}
