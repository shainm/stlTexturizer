/**
 * stackView.js — Personal edition: the project's parts stacked along their
 * shared axis, drawn with one variant's texture, to check the joints.
 *
 * Each part sits on the one below it: its seat (lowest point) on that part's
 * rim (seat + pitch, as "Line up parts" detects them; both can be typed per
 * part). Parts can't be moved, only turned around the axis, and only in the
 * steps set in "Line up parts" ("Parts may sit turned in steps of 1/N"): pick
 * a part, then drag its ring — it clicks from step to step like a slicer's
 * rotate tool. Parts can be added any number of times (e.g. several middles),
 * and Shift-dragged up or down the stack to reorder it (they snap back onto
 * the joints) or sideways to turn them step by step. A plain drag always orbits.
 * The textures follow each part's export frame, so what joins here joins in print.
 * "Exported mesh" swaps the live texture preview for the real exported meshes
 * (the full export pipeline, per part), to judge the joints on the 3D result.
 */

import { THREE } from './threeCompat.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { getScene } from './viewer.js';

const STYLE = `
.pds-stack { position: fixed; inset: 0; z-index: 9000; display: grid; grid-template-columns: 300px 1fr;
  background: var(--bg, #14161c); color: var(--text, #ddd); font-size: 12px; }
.pds-stack aside { overflow-y: auto; padding: 12px; border-right: 1px solid var(--border, #333);
  background: var(--surface, #1b1e26); display: flex; flex-direction: column; gap: 10px; }
.pds-stack h3 { margin: 0; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }
.pds-stack h4 { margin: 4px 0 0; font-size: 12px; color: var(--text-muted, #999); font-weight: 600; }
.pds-stack .muted { color: var(--text-muted, #999); margin: 0; }
.pds-stack select, .pds-stack input { font: inherit; font-size: 12px; color: inherit; background: var(--surface2, #222);
  border: 1px solid var(--border, #333); border-radius: 4px; padding: 2px 4px; min-width: 0; }
.pds-stack input { width: 64px; }
.pds-stack-row { display: flex; align-items: center; gap: 4px; padding: 3px 4px; border-radius: 4px; border: 1px solid transparent; cursor: pointer; }
.pds-stack-row.sel { border-color: var(--accent, #4af); background: color-mix(in srgb, var(--accent, #4af) 12%, transparent); }
.pds-stack-row select { flex: 1; }
.pds-stack-add { position: relative; height: 0; z-index: 1; }
.pds-stack-add .hit { position: absolute; left: 0; right: -11px; top: -9px; height: 18px; display: flex; align-items: center; justify-content: flex-end; padding-right: 0; box-sizing: border-box; opacity: 0; transition: opacity .1s; }
.pds-stack-add:hover .hit, .pds-stack-add .hit:focus-within { opacity: 1; }
.pds-stack-add .line { position: absolute; left: 0; right: 9px; top: 50%; margin-top: -1px; border-top: 2px solid var(--surface2, #222); }
.pds-stack-add button { position: relative; box-sizing: border-box; width: 18px; height: 18px; padding: 0; margin: 0; display: flex; align-items: center; justify-content: center; font: inherit; font-size: 14px; line-height: 0; border-radius: 0 50% 50% 50%; transform: rotate(-45deg); border: 0; background: var(--surface2, #222); color: var(--text, #fff); cursor: pointer; }
.pds-stack-add button span { display: block; transform: rotate(45deg); line-height: 1; }
.pds-stack-add .hit:hover .line { border-top-color: var(--accent, #4af); }
.pds-stack-add .hit:hover button { background: var(--accent, #4af); }
.pds-stack-row.empty { border: 1px dashed var(--accent, #4af); cursor: default; }
.pds-stack-row .grip { cursor: grab; color: var(--text-muted, #999); letter-spacing: -2px; padding: 0 2px; user-select: none; }
.pds-stack-row.drag { opacity: 0.4; }
.pds-stack-row.over { border-color: var(--accent, #4af); }
.pds-stack-row .deg { width: 44px; text-align: center; color: var(--text-muted, #999); }
.pds-stack-row button, .pds-stack .x { font: inherit; background: none; border: 0; color: var(--text-muted, #999); cursor: pointer; padding: 0 3px; }
.pds-stack-row button:hover, .pds-stack .x:hover { color: var(--text, #fff); }
.pds-stack-row button:disabled { opacity: 0.3; cursor: default; }
.pds-stack-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 4px; }
.pds-stack-actions .pds-btn { padding: 4px 10px; white-space: nowrap; }
.pds-stack-actions input { width: 80px; }
.pds-stack-datum { display: grid; grid-template-columns: 1fr auto auto; gap: 4px; align-items: center; }
.pds-stack main { position: relative; min-width: 0; }
.pds-stack canvas { display: block; width: 100%; height: 100%; }
`;


function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.filter(k => k != null));
  return e;
}

/** A part's mesh with the attributes the preview shader reads (no paint: fully textured). */
function partGeometry(pos) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();   // non-indexed → face normals
  const n = pos.length / 3, fn = geo.attributes.normal.array;
  // Smooth normals, as the app's own preview has them: at each welded vertex, the
  // (area-weighted) average of the faces there that are within 30° of this corner's
  // face. Hard edges and clips stay crisp; round walls shade smoothly. (Averaging
  // every face smeared the shading across the part's sharp edges.)
  const COS = Math.cos(Math.PI / 6);
  const key = (i) => `${Math.round(pos[i] * 1e4)},${Math.round(pos[i + 1] * 1e4)},${Math.round(pos[i + 2] * 1e4)}`;
  const groups = new Map();   // welded position → corner indices (first coordinate offset of each corner)
  const area = new Float32Array(n);
  for (let c = 0; c < n; c += 3) {
    const o = c * 3;
    const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
    const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
    const a = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
    area[c] = area[c + 1] = area[c + 2] = a;
    for (let v = 0; v < 3; v++) {
      const k = key(o + v * 3);
      const g = groups.get(k);
      if (g) g.push(c + v); else groups.set(k, [c + v]);
    }
  }
  const sn = new Float32Array(pos.length);
  for (const g of groups.values()) {
    for (const ci of g) {
      const fx = fn[ci * 3], fy = fn[ci * 3 + 1], fz = fn[ci * 3 + 2];
      let sx = 0, sy = 0, sz = 0;
      for (const cj of g) {
        const nx = fn[cj * 3], ny = fn[cj * 3 + 1], nz = fn[cj * 3 + 2];
        if (fx * nx + fy * ny + fz * nz < COS) continue;
        const w = area[cj];
        sx += nx * w; sy += ny * w; sz += nz * w;
      }
      const l = Math.hypot(sx, sy, sz);
      sn[ci * 3] = l > 1e-12 ? sx / l : fx; sn[ci * 3 + 1] = l > 1e-12 ? sy / l : fy; sn[ci * 3 + 2] = l > 1e-12 ? sz / l : fz;
    }
  }
  geo.setAttribute('faceNormal', new THREE.BufferAttribute(fn.slice(), 3));
  geo.setAttribute('smoothNormal', new THREE.BufferAttribute(sn, 3));
  geo.setAttribute('layerMask', new THREE.BufferAttribute(new Float32Array(n * 4).fill(1), 4));
  geo.setAttribute('layerFalloff', new THREE.BufferAttribute(new Float32Array(n * 4).fill(1), 4));
  geo.setAttribute('boundaryMaskTypeAttr', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
  return geo;
}

/**
 * Alignment test pattern (a height map: white = raised). Each tile gets a thick
 * border — the texture's seams — a thin centre cross and an arrow pointing up
 * (+V). Where parts line up, the borders run straight on across every joint.
 */
function testPattern() {
  const N = 512, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
  g.fillStyle = '#fff';
  const b = 22;   // half the border: the other half is on the next tile
  g.fillRect(0, 0, N, b); g.fillRect(0, N - b, N, b); g.fillRect(0, 0, b, N); g.fillRect(N - b, 0, b, N);
  g.fillStyle = '#999';
  g.fillRect(N / 2 - 4, 0, 8, N); g.fillRect(0, N / 2 - 4, N, 8);
  g.fillStyle = '#fff';   // arrow in the upper-left quarter, pointing up the tile
  g.beginPath();
  g.moveTo(N * 0.25, N * 0.08); g.lineTo(N * 0.40, N * 0.24); g.lineTo(N * 0.30, N * 0.24); g.lineTo(N * 0.30, N * 0.42);
  g.lineTo(N * 0.20, N * 0.42); g.lineTo(N * 0.20, N * 0.24); g.lineTo(N * 0.10, N * 0.24); g.closePath();
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function xyBounds(pos) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    x0 = Math.min(x0, pos[i]); x1 = Math.max(x1, pos[i]);
    y0 = Math.min(y0, pos[i + 1]); y1 = Math.max(y1, pos[i + 1]);
    z0 = Math.min(z0, pos[i + 2]); z1 = Math.max(z1, pos[i + 2]);
  }
  return { min: { x: x0, y: y0, z: z0 }, size: { x: x1 - x0, y: y1 - y0, z: z1 - z0 } };
}

/**
 * @param {object} app   personal.js's app bridge (models, variants, stackMaterial)
 * @param {object} h     { parseSTL, stackDatums, align, setDatums } — align is "Line up parts"' state (or null);
 *   setDatums(modelId, { seat, pitch }) puts joint edges typed here into it, so export uses them too
 */
export function openStackView(app, h) {
  if (document.querySelector('.pds-stack')) return;
  if (!document.getElementById('pds-stack-style')) document.head.append(el('style', { id: 'pds-stack-style' }, STYLE));
  const align = h.align;
  const modular = align?.mode === 'modular';
  const steps = modular && align.rotate ? Math.max(1, align.positions | 0) : 0;
  const stepRad = steps ? 2 * Math.PI / steps : 0;

  // ── Parts (one per project model) ──
  // How it was stacked last time (saved with the project): { variantNum, items: [{ model, turn }], datums: { [modelId]: { seat, pitch } } }
  const saved = app.stackLayout.get();
  const models = app.models.list();
  const activeId = app.models.activeId();
  const parts = new Map();
  let sharedXY = align?.xy || null;   // one axis for every part: the line-up's, else the first part's
  for (const m of models) {
    const raw = app.models.stl(m.id);
    if (!raw) continue;
    const pos = h.parseSTL(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
    const own = xyBounds(pos);
    const xy = sharedXY ??= own;   // the same XY frame "Line up parts" textures with
    const axis = { x: xy.min.x + xy.size.x / 2, y: xy.min.y + xy.size.y / 2 };
    const detected = h.stackDatums(pos, axis);
    const remembered = saved?.datums?.[m.id];
    // Lined up: the line-up's own edges for the part (what export uses); else what was typed here.
    const datums = (modular && (align.datums?.[m.id] || (m.id === activeId ? { seat: align.seat, pitch: align.pitch } : null))) || remembered || detected;
    let rMax = 0;
    for (let i = 0; i < pos.length; i += 3) rMax = Math.max(rMax, Math.hypot(pos[i] - axis.x, pos[i + 1] - axis.y));
    parts.set(m.id, { id: m.id, name: m.name, pos, own, xy, axis, rMax, datums: { ...datums }, edited: !!remembered, geo: partGeometry(pos), mat: null });
  }
  if (!parts.size) return;

  let items = (saved?.items || []).filter(it => parts.has(it.model)).map(it => ({ ...it }));
  if (!items.length) items = [...parts.keys()].map(id => ({ model: id, turn: 0 }));   // bottom first
  const variantList = app.variants.list();
  // The variant is kept by its chip number (ids change when a project is reopened); 0 = current settings.
  let variant = saved?.variantNum === 0 ? null
    : (variantList.find(v => v.num === saved?.variantNum) || variantList[0])?.id ?? null;
  let selected = -1;
  const remember = () => {
    app.stackLayout.set({
      variantNum: variant == null ? 0 : (variantList.find(v => v.id === variant)?.num ?? 0),
      items: items.map(it => ({ ...it })), datums: Object.fromEntries([...parts.values()].filter(p => p.edited).map(p => [p.id, { ...p.datums }])) });
  };

  // ── Scene ──
  const canvas = el('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  const scene = new THREE.Scene();
  const bg = getScene()?.background;
  scene.background = bg && bg.isColor ? bg.clone() : new THREE.Color(0x14161c);
  const camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  const stack = new THREE.Group();
  scene.add(stack);
  // For the exported meshes (the shader preview lights itself).
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3328, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(1, 0.4, 1.2);
  camera.add(key);
  const exactMat = new THREE.MeshStandardMaterial({ color: 0xb98a5a, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide });
  let exactOn = false, closed = false;
  let exactBox = null, exactStatus = null, testBox = null;   // built with the sidebar

  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd400 });
  const ringHot = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const tickMat = new THREE.MeshBasicMaterial({ color: 0xffd400 });
  const ring = new THREE.Group();
  scene.add(ring);
  let ringMesh = null;

  function frameFor(p) {
    if (!modular) return { min: p.own.min, size: p.own.size };
    return {
      min: { x: p.xy.min.x, y: p.xy.min.y, z: p.datums.seat },
      size: { x: p.xy.size.x, y: p.xy.size.y, z: Math.max(p.datums.pitch, 1) },
      modular: { pitch: p.datums.pitch, positions: steps || 1 },
    };
  }
  let testTex = null;   // the alignment test pattern, while it's switched on
  function buildMaterials() {
    const snap = snapNow();
    for (const p of parts.values()) p.mat = app.stackMaterial(snap, p.geo, frameFor(p), p.mat, testTex, p.id);
    // The exported meshes were made with the old joints / texture: drop them.
    for (const p of parts.values()) { p.exactGeo?.dispose(); p.exactGeo = null; }
    if (exactOn) {
      exactOn = false;
      app.stackMesh.cancel();
      if (exactBox) exactBox.checked = false;
      if (exactStatus) exactStatus.textContent = 'The texture or joints changed — tick again to rebuild the exported meshes.';
    }
  }

  // Build every stacked part's exported mesh (one at a time, as an export does).
  async function buildExact() {
    const snap = snapNow();
    const used = [...new Set(items.map(it => it.model))].map(id => parts.get(id));
    try {
      for (let k = 0; k < used.length; k++) {
        const p = used[k];
        if (p.exactGeo) continue;
        const r = await app.stackMesh.build(p.id, snap, p.geo, frameFor(p),
          (f, label) => { if (exactStatus && !closed) exactStatus.textContent = `${p.name} (${k + 1}/${used.length}): ${label} ${Math.round(f * 100)}%`; });
        if (!r || closed || !exactOn) return false;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
        if (r.normals) geo.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3)); else geo.computeVertexNormals();
        p.exactGeo = geo;
      }
      if (exactStatus) exactStatus.textContent = 'Showing the exported meshes (no masks colouring, one colour).';
      return true;
    } catch (err) {
      if (exactStatus && !closed) exactStatus.textContent = `Could not build: ${err.message}`;
      return false;
    }
  }

  // Each item: a group on the axis at its stacked height, turned by its steps.
  let groups = [], bases = [];
  // Joint rings, drawn through the parts: yellow where a part's bottom joint
  // (seat) is, cyan where it says the next part sits. Each pair meets by
  // construction; what they show is whether that is where the parts touch.
  const joints = new THREE.Group();
  scene.add(joints);
  const seatLine = new THREE.LineBasicMaterial({ color: 0xffd400, depthTest: false, transparent: true });
  const topLine = new THREE.LineBasicMaterial({ color: 0x33ddff, depthTest: false, transparent: true });
  const radiusAt = (p, z) => {   // the part's outer radius at height z (file coordinates)
    let r = 0;
    for (let i = 0; i < p.pos.length; i += 3) {
      if (Math.abs(p.pos[i + 2] - z) < 0.6) r = Math.max(r, Math.hypot(p.pos[i] - p.axis.x, p.pos[i + 1] - p.axis.y));
    }
    return r || p.rMax;
  };
  const circle = (r, z, mat) => {
    const pts = [];
    for (let k = 0; k < 128; k++) { const a = k / 128 * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, z)); }
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat);
    line.renderOrder = 10;
    return line;
  };
  function showJoints() {
    for (const c of joints.children) c.geometry.dispose();
    joints.clear();
    if (!jointsOn) return;
    items.forEach((it, i) => {
      const p = parts.get(it.model), d = p.datums;
      joints.add(circle(radiusAt(p, d.seat) + 0.4, bases[i] + d.seat, seatLine));
      if (i < items.length - 1) joints.add(circle(radiusAt(p, d.seat + d.pitch) + 0.8, bases[i] + d.seat + d.pitch, topLine));
    });
  }
  let jointsOn = false;

  function layout() {
    stack.clear();
    groups = []; bases = [];
    let z = 0, prev = null;
    for (const it of items) {
      const p = parts.get(it.model);
      const base = prev ? z + prev.datums.seat + prev.datums.pitch - p.datums.seat : 0;
      const g = new THREE.Group();
      g.position.set(0, 0, base);
      g.rotation.z = it.turn * stepRad;
      const exact = exactOn && p.exactGeo;
      const mesh = new THREE.Mesh(exact ? p.exactGeo : p.geo, exact ? exactMat : p.mat);
      mesh.position.set(-p.axis.x, -p.axis.y, 0);
      mesh.userData.item = groups.length;
      g.add(mesh);
      stack.add(g);
      groups.push(g); bases.push(base);
      z = base; prev = p;
    }
    showRing();
    showJoints();
  }

  function showRing() {
    ring.clear();
    ringMesh = null;
    if (!steps || selected < 0 || !items[selected]) return;
    const p = parts.get(items[selected].model);
    const R = p.rMax + Math.max(4, p.rMax * 0.12), tube = Math.max(0.5, R * 0.012);
    ringMesh = new THREE.Mesh(new THREE.TorusGeometry(R, tube * 2.5, 8, 160), ringMat);   // fat, easy to grab
    ring.add(ringMesh);
    for (let k = 0; k < steps; k++) {
      const a = k * stepRad, tick = new THREE.Mesh(new THREE.SphereGeometry(tube * 4, 12, 8), tickMat);
      tick.position.set(Math.cos(a) * R, Math.sin(a) * R, 0);
      ring.add(tick);
    }
    // The part's own marker: where its step 0 now points.
    const mark = new THREE.Mesh(new THREE.ConeGeometry(tube * 5, tube * 14, 12), ringHot);
    mark.rotation.z = Math.PI / 2;
    mark.position.set(R + tube * 12, 0, 0);
    const pivot = new THREE.Group();
    pivot.add(mark);
    pivot.rotation.z = items[selected].turn * stepRad;
    ring.add(pivot);
    ring.userData.pivot = pivot;
    ring.position.set(0, 0, bases[selected] + p.datums.seat + p.datums.pitch / 2);
  }

  function fit() {
    let top = 0, r = 1;
    items.forEach((it, i) => { const p = parts.get(it.model); top = Math.max(top, bases[i] + p.own.min.z + p.own.size.z); r = Math.max(r, p.rMax); });
    const lo = parts.get(items[0]?.model)?.own.min.z ?? 0;
    const mid = (lo + top) / 2, span = Math.max(top - lo, 2 * r);
    controls.target.set(0, 0, mid);
    camera.position.set(span * 1.6, -span * 1.6, mid + span * 0.9);
    camera.near = span / 100; camera.far = span * 100;
    camera.updateProjectionMatrix();
    controls.update();
  }

  // ── Sidebar ──
  const list = el('div');
  const datumsBox = el('div', { class: 'pds-stack-datum' });
  let scaleVTry = null;   // a tile height (mm) being tried here on every layer; null = the settings' own
  const tileText = el('p', { class: 'muted' });
  const tileList = el('p', { class: 'muted', style: 'white-space:pre-line' });
  const tileInput = el('input', { type: 'number', step: '0.1', min: '0.1', title: 'Texture tile height (Scale V, mm) used in this view' });
  const tileSuggest = el('button', { class: 'pds-btn' }, 'Use suggestion');
  const tileReset = el('button', { class: 'pds-btn', title: 'Back to the Scale V in the settings' }, 'Reset');
  const tileApply = el('button', { class: 'pds-btn', title: 'Set Scale V in the settings to this value (the active layer)' }, 'Apply to settings');
  const tileHint = el('div', {}, tileText, tileList, el('div', { class: 'pds-stack-actions' }, tileInput, tileSuggest, tileReset, tileApply));
  const snapNow = () => {
    const base = variant != null ? app.variants.snapOf(variant) : null;
    return scaleVTry && h.withScaleV ? h.withScaleV(base, scaleVTry) : base;
  };
  let tileBest = null;
  let addAt = null;   // an empty slot being filled: the items index the new part will take (null = none open)
  const varSel = el('select', { onchange: () => { variant = varSel.value === '' ? null : Number(varSel.value); buildMaterials(); layout(); remember(); } },
    el('option', { value: '' }, 'Current settings'),
    ...variantList.map(v => el('option', { value: v.id }, `${v.num} · ${v.label}`)));
  varSel.value = variant == null ? '' : String(variant);

  const testHint = el('p', { class: 'muted', hidden: true },
    'Thick lines are the tile edges, the arrows point up. Lined up, the lines run straight across every joint. ' +
    'A step in the level lines: up/down is off (joint heights). A step in the upright lines or tilted arrows: around is off (axis or steps).');
  const deg = (it) => steps ? `${+((it.turn * 360) / steps).toFixed(1)}°` : '';
  // A line between two parts (or above / below the stack) with a + at its right: opens an empty slot there.
  function addLine(at) {
    if (addAt === at) {
      const pick = el('select', { onclick: (e) => e.stopPropagation(), onchange: () => {
        const model = Number(pick.value);
        addAt = null;
        items.splice(at, 0, { model, turn: 0 });
        selected = -1;
        layout(); renderList(); fit(); remember();
      } }, el('option', { value: '' }, 'Choose a part…'), ...[...parts.values()].map(p => el('option', { value: p.id }, p.name)));
      pick.value = '';
      return el('div', { class: 'pds-stack-row empty' }, el('span', { class: 'grip' }, '+'), pick,
        el('button', { title: 'Cancel', onclick: (e) => { e.stopPropagation(); addAt = null; renderList(); } }, '✕'));
    }
    return el('div', { class: 'pds-stack-add' }, el('div', { class: 'hit', title: 'Add a part here' }, el('span', { class: 'line' }),
      el('button', { onclick: (e) => { e.stopPropagation(); addAt = at; renderList(); } }, el('span', {}, '+'))));
  }
  function renderList() {
    list.textContent = '';
    // Top of the stack first, as it stands, with an add line above it, between parts and below it.
    list.append(addLine(items.length));
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const sel = el('select', { onchange: () => { it.model = Number(sel.value); it.turn = 0; layout(); renderList(); remember(); }, onclick: (e) => e.stopPropagation() },
        ...[...parts.values()].map(p => el('option', { value: p.id }, p.name)));
      sel.value = String(it.model);
      // Drag a row by its grip to reorder the stack; it drops into the place it is released over.
      const grip = el('span', { class: 'grip', title: 'Drag to move this part up or down the stack' }, '⋮⋮');
      const row = el('div', { class: 'pds-stack-row' + (i === selected ? ' sel' : ''), onclick: () => select(i === selected ? -1 : i) },
        grip, sel,
        steps ? el('button', { title: 'Turn one step left', onclick: (e) => { e.stopPropagation(); turnTo(it.turn - 1, i); } }, '◀') : null,
        el('span', { class: 'deg' }, deg(it)),
        steps ? el('button', { title: 'Turn one step right', onclick: (e) => { e.stopPropagation(); turnTo(it.turn + 1, i); } }, '▶') : null,
        el('button', { title: 'Remove from the stack', disabled: items.length < 2, onclick: (e) => { e.stopPropagation(); items.splice(i, 1); selected = -1; layout(); renderList(); remember(); } }, '✕'));
      grip.addEventListener('mousedown', () => { row.draggable = true; });
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; row.classList.add('drag'); });
      row.addEventListener('dragend', () => { row.draggable = false; row.classList.remove('drag'); });
      row.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('over'); });
      row.addEventListener('dragleave', () => row.classList.remove('over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('over');
        const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (!Number.isInteger(from) || from === i || !items[from]) return;
        const selItem = selected >= 0 ? items[selected] : null;
        items.splice(i, 0, items.splice(from, 1)[0]);
        selected = selItem ? items.indexOf(selItem) : -1;
        layout(); renderList(); remember();
      });
      list.append(row);
      list.append(addLine(i));
    }
  }
  function renderDatums() {
    datumsBox.textContent = '';
    for (const p of parts.values()) {
      const num = (k) => {
        const inp = el('input', { type: 'number', step: '0.01', value: p.datums[k].toFixed(2), title: k === 'seat' ? 'Bottom joint edge (mm, file Z)' : 'Where the next part sits, above the seat (mm)' });
        inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (Number.isFinite(v)) { p.edited = true; p.datums[k] = k === 'pitch' ? Math.max(0, v) : v; h.setDatums?.(p.id, { ...p.datums }); buildMaterials(); layout(); remember(); } });
        return inp;
      };
      datumsBox.append(el('span', {}, p.name), num('seat'), num('pitch'));
    }
    renderTileHint();
  }
  // The texture is fitted to each part's pitch in whole repeats (so joints always meet), which
  // leaves a slightly different tile height per part. Show them, and the Scale V that evens them out.
  function renderTileHint() {
    const sv = scaleVTry || h.scaleV?.();
    const pitches = [...parts.values()].map(p => p.datums.pitch).filter(v => v > 0);
    tileHint.style.display = (!(sv > 0) || !pitches.length) ? 'none' : '';
    if (tileHint.style.display) return;
    // Whole repeats per pitch (what keeps the joints meeting); unevenness = tallest vs shortest, relative to their mean.
    const tiles = (s) => pitches.map(pt => pt / Math.max(1, Math.round(pt / s)));
    const spread = (s) => { const t = tiles(s); return (Math.max(...t) - Math.min(...t)) / (t.reduce((a, b) => a + b, 0) / t.length); };
    // Search tile heights from a sixth of the tallest pitch up to the tallest pitch; take the most even, and of the
    // equally even ones the tallest tile (the fewest repeats).
    const hi = Math.max(...pitches), lo = hi / 6;
    let best = null, bestSpread = Infinity;
    for (let s = hi; s >= lo; s *= 0.995) { const sp = spread(s); if (sp < bestSpread - 0.005) { best = s; bestSpread = sp; } }
    tileBest = best ? +best.toFixed(1) : null;
    const fmt = (a) => a.map(v => v.toFixed(1)).join(' / ');
    const now = spread(sv);
    tileText.textContent = `Texture height per part at Scale V ${+sv.toFixed(2)} mm: ${fmt(tiles(sv))} mm (${Math.round(now * 100)}% uneven).`
      + (tileBest && bestSpread < now - 0.02 ? ` Scale V ${tileBest} would give ${fmt(tiles(tileBest))} mm (${Math.round(spread(tileBest) * 100)}% uneven) — joints still meet. Parts of different height can't be made exactly equal.` : ' Already about as even as these part heights allow.');
    // Each part's real tile, width × height (mm), and how much taller (+) / shorter (−) than wide it is
    // against the Scale U : Scale V you set — 0% means the texture is not stretched either way.
    const tileLines = (base) => [...parts.values()].map((p) => {
      const r = h.tileSizes?.(base, frameFor(p));
      return r ? `${p.name}: ${r.w.toFixed(1)} × ${r.h.toFixed(1)} mm, ${r.stretch >= 0 ? '+' : '−'}${Math.abs(Math.round(r.stretch * 100))}% height vs width` : null;
    }).filter(Boolean);
    const baseSnap = variant != null ? app.variants.snapOf(variant) : null;
    const nowLines = tileLines(snapNow());
    const bestLines = tileBest && h.withScaleV && tileBest !== scaleVTry ? tileLines(h.withScaleV(baseSnap, tileBest)) : [];
    tileList.textContent = nowLines.length
      ? 'Now:\n' + nowLines.join('\n') + (bestLines.length ? `\nWith Scale V ${tileBest}:\n` + bestLines.join('\n') : '')
      : '';
    tileInput.value = +sv.toFixed(2);
    tileSuggest.disabled = !tileBest || Math.abs(tileBest - sv) < 0.05;
    tileReset.disabled = !scaleVTry;
    tileApply.disabled = !scaleVTry;
  }
  function select(i) { selected = i; renderList(); showRing(); }
  const tryScaleV = (v) => {
    scaleVTry = Number.isFinite(v) && v > 0 ? v : null;
    buildMaterials(); renderTileHint();
  };
  tileInput.addEventListener('change', () => tryScaleV(parseFloat(tileInput.value)));
  tileSuggest.addEventListener('click', () => { if (tileBest) tryScaleV(tileBest); });
  tileReset.addEventListener('click', () => tryScaleV(null));
  tileApply.addEventListener('click', () => {
    if (!scaleVTry) return;
    h.setScaleV?.(scaleVTry);
    scaleVTry = null;
    buildMaterials(); renderTileHint();
  });

  const close = () => {
    closed = true;
    app.stackMesh.cancel();
    remember();
    cancelAnimationFrame(raf);
    ro.disconnect();
    document.removeEventListener('keydown', onKey, true);
    controls.dispose();
    for (const p of parts.values()) { p.geo.dispose(); p.mat?.dispose(); }
    testTex?.dispose();
    for (const p of parts.values()) p.exactGeo?.dispose();
    exactMat.dispose();
    renderer.dispose();
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    // Arrow keys turn the selected part one step.
    if (steps && selected >= 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest?.('input, select')) {
      e.preventDefault();
      turnTo(items[selected].turn + (e.key === 'ArrowRight' ? 1 : -1));
    }
  };
  document.addEventListener('keydown', onKey, true);

  const overlay = el('div', { class: 'pds-stack' },
    el('aside', {},
      el('h3', {}, 'Stack view', el('button', { class: 'x', title: 'Close (Esc)', onclick: () => close() }, '✕')),
      el('h4', {}, 'Texture'), varSel,
      el('label', { title: 'Swap the image for a grid with the same size and placement: thick lines are the tile edges' },
        testBox = el('input', { type: 'checkbox', onchange: (e) => {
          // The pattern replaces the texture image; the exported meshes are made from the real one: one or the other.
          if (e.target.checked && exactOn) {
            exactOn = false;
            app.stackMesh.cancel();
            exactBox.checked = false;
            exactStatus.textContent = '';
          }
          if (e.target.checked) testTex = testPattern(); else { testTex?.dispose(); testTex = null; }
          buildMaterials(); layout();
          testHint.hidden = !e.target.checked;
        } }), ' Alignment test pattern'),
      testHint,
      el('label', { title: 'Run the real export on each stacked part and show those meshes: slow (about as long as exporting each part), but shows the actual 3D result across the joints. Rebuilds when the texture or joints change.' },
        exactBox = el('input', { type: 'checkbox', onchange: async (e) => {
          if (!e.target.checked) { exactOn = false; app.stackMesh.cancel(); exactStatus.textContent = ''; layout(); return; }
          if (testTex) {   // see the alignment test pattern's switch: one or the other
            testTex.dispose(); testTex = null;
            testBox.checked = false;
            testHint.hidden = true;
            buildMaterials();
          }
          exactOn = true;
          exactStatus.textContent = 'Building…';
          if (await buildExact()) layout();
          else if (!closed && !exactOn) { /* switched off meanwhile */ }
          else if (!closed) { exactOn = false; exactBox.checked = false; }
        } }), ' Exported mesh preview (slow)'),
      exactStatus = el('p', { class: 'muted' }),
      el('label', { title: 'Yellow: each part\'s bottom joint. Cyan: where it says the next part sits. Drawn through the parts.' },
        el('input', { type: 'checkbox', onchange: (e) => { jointsOn = e.target.checked; showJoints(); } }), ' Show joint rings'),
      el('h4', {}, 'Stack (top first)'), list,
      steps
        ? el('p', { class: 'muted' }, `Shift+drag a part: up/down moves it in the stack, sideways turns it in steps. Or click a part and drag its ring to turn it — it snaps in steps of ${+(360 / steps).toFixed(2)}° (1/${steps}). ←/→ turn it one step.`)
        : el('p', { class: 'muted' }, modular
          ? 'Turning is off: tick "Parts may sit turned in steps" in Line up parts to turn parts here.'
          : 'Parts are not lined up for modular stacking (Line up parts), so the textures may not meet at the joints and parts cannot be turned.'),
      el('h4', {}, 'Joints per part: seat · next part at (mm above it)'), datumsBox, tileHint,
      el('p', { class: 'muted' }, 'Set these to where the parts really touch: if a part sits down inside the one below (on a ledge, not the rim), the lower part\'s "next part at" is that ledge. The cyan ring must lie on it.'),
      el('p', { class: 'muted' }, 'Painted masks show per whole face: strokes finer than a face are blended onto its corners.')),
    el('main', {}, canvas));
  document.body.append(overlay);

  // ── Turning ──
  function turnTo(turn, idx = selected) {
    const it = items[idx];
    it.turn = ((turn % steps) + steps) % steps;
    groups[idx].rotation.z = it.turn * stepRad;
    if (idx === selected && ring.userData.pivot) ring.userData.pivot.rotation.z = it.turn * stepRad;
    renderList();
    remember();
  }
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const setRay = (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  };
  const angleAt = (z = ring.position.z) => {
    const pl = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), pt = new THREE.Vector3();
    return ray.ray.intersectPlane(pl, pt) ? Math.atan2(pt.y, pt.x) : null;
  };
  // Moving a part along the stack: it follows the pointer up and down (on a
  // vertical plane through the axis, facing the camera); passing another
  // part's middle swaps their places, and letting go seats it on the joints.
  const centerOf = (i) => { const o = parts.get(items[i].model).own; return bases[i] + o.min.z + o.size.z / 2; };
  const heightAt = () => {
    const n = camera.getWorldDirection(new THREE.Vector3()).setZ(0);
    if (n.lengthSq() < 1e-6) n.set(1, 0, 0);
    const pt = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), new THREE.Vector3()), pt) ? pt.z : null;
  };
  let move = null;   // { item, grabZ (pointer height − part base at grab), x, y, moving, sel (the selected item) }
  function dragPart(z) {
    const it = move.item, i = items.indexOf(it);
    const own = parts.get(it.model).own;
    const center = z - move.grabZ + own.min.z + own.size.z / 2;
    const others = items.filter(o => o !== it);
    const centers = items.map((_, j) => centerOf(j)).filter((_, j) => j !== i);
    const k = centers.filter(c => c < center).length;
    if (k !== i) {
      items = [...others.slice(0, k), it, ...others.slice(k)];
      if (move.sel) selected = items.indexOf(move.sel);
      layout();
      renderList();
    }
    groups[items.indexOf(it)].position.z = z - move.grabZ;
  }

  let drag = null, down = null;
  let pending = null;   // Shift-pressed on a part, direction not yet known: { i, x, y, z (grab height), grabZ }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    setRay(e);
    if (ringMesh && ray.intersectObject(ringMesh, false).length) {
      const a = angleAt();
      if (a == null) return;
      drag = { start: a, turn: items[selected].turn };
      controls.enabled = false;
      ringMesh.material = ringHot;
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopImmediatePropagation();   // the orbit controls never see it
      return;
    }
    // Shift on a part: snap it (turn or move, by the first direction dragged). Without Shift: orbit.
    const hit = e.shiftKey && ray.intersectObjects(stack.children, true)[0];
    if (hit) {
      const z = heightAt(), i = hit.object.userData.item;
      if (z == null) return;
      pending = { i, x: e.clientX, y: e.clientY, z: hit.point.z, grabZ: z - bases[i] };
      controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopImmediatePropagation();   // the orbit controls never see it
      return;
    }
    down = { x: e.clientX, y: e.clientY };
  }, true);   // capture: runs before the orbit controls' own handler
  canvas.addEventListener('pointermove', (e) => {
    setRay(e);
    if (pending) {
      const dx = e.clientX - pending.x, dy = e.clientY - pending.y;
      if (Math.hypot(dx, dy) < 6) return;
      const p = pending;
      pending = null;
      if (steps && Math.abs(dx) > Math.abs(dy)) {   // sideways: turn it, around the height it was grabbed at
        select(p.i);
        const a = angleAt(p.z);
        if (a != null) drag = { start: a, turn: items[p.i].turn, z: p.z }; else controls.enabled = true;
        if (ringMesh) ringMesh.material = ringHot;
      } else move = { item: items[p.i], grabZ: p.grabZ, moving: false, sel: items[selected] };
    }
    if (move) {
      move.moving = true;
      canvas.style.cursor = 'ns-resize';
      ring.visible = false;
      const z = heightAt();
      if (z != null) dragPart(z);
      return;
    }
    if (drag) {
      const a = angleAt(drag.z);
      if (a == null) return;
      let d = a - drag.start;
      d = Math.atan2(Math.sin(d), Math.cos(d));   // shortest way round
      const k = Math.round(d / stepRad);
      if (((drag.turn + k) % steps + steps) % steps !== items[selected].turn) turnTo(drag.turn + k);
      // Past half a turn, carry on from here so it keeps going round.
      if (Math.abs(d) > Math.PI * 0.75) { drag.start = a; drag.turn = items[selected].turn; }
      return;
    }
    if (!down) canvas.style.cursor = ringMesh && ray.intersectObject(ringMesh, false).length ? 'grab'
      : e.shiftKey && ray.intersectObjects(stack.children, true).length ? 'move' : '';
  });
  canvas.addEventListener('pointerup', (e) => {
    if (pending) {   // Shift-click without dragging: just pick it
      const i = pending.i;
      pending = null;
      controls.enabled = true;
      select(i === selected ? -1 : i);
      return;
    }
    if (move) {
      const { item, moving, sel } = move;
      move = null;
      controls.enabled = true;
      ring.visible = true;
      canvas.style.cursor = '';
      if (moving) {
        selected = sel ? items.indexOf(sel) : -1;
        layout();   // seat everything on its joints again
        renderList();
        remember();
      } else select(items.indexOf(item) === selected ? -1 : items.indexOf(item));   // a click picks the part
      return;
    }
    if (drag) {
      drag = null;
      controls.enabled = true;
      if (ringMesh) ringMesh.material = ringMat;
      return;
    }
    // A click (not an orbit drag) picks the part under the pointer.
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) {
      setRay(e);
      const hit = ray.intersectObjects(stack.children, true)[0];
      select(hit ? hit.object.userData.item : -1);
    }
    down = null;
  });

  const resize = () => {
    const w = canvas.clientWidth, hgt = canvas.clientHeight;
    if (!w || !hgt) return;
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  let raf = 0;
  const loop = () => { raf = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); };

  buildMaterials();
  layout();
  renderList();
  renderDatums();
  resize();
  fit();
  loop();
}
