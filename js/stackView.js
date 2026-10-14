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
 * and dragged up or down the stack to reorder it (they snap back onto the joints).
 * The textures follow each part's export frame, so what joins here joins in print.
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
.pds-stack-row .deg { width: 44px; text-align: right; color: var(--text-muted, #999); }
.pds-stack-row button, .pds-stack .x { font: inherit; background: none; border: 0; color: var(--text-muted, #999); cursor: pointer; padding: 0 3px; }
.pds-stack-row button:hover, .pds-stack .x:hover { color: var(--text, #fff); }
.pds-stack-row button:disabled { opacity: 0.3; cursor: default; }
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
  // Smooth normals: face normals summed over each welded position.
  const acc = new Map(), key = (i) => `${Math.round(pos[i] * 1e4)},${Math.round(pos[i + 1] * 1e4)},${Math.round(pos[i + 2] * 1e4)}`;
  for (let i = 0; i < pos.length; i += 3) {
    const k = key(i); let a = acc.get(k);
    if (!a) acc.set(k, a = [0, 0, 0]);
    a[0] += fn[i]; a[1] += fn[i + 1]; a[2] += fn[i + 2];
  }
  const sn = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const a = acc.get(key(i)), l = Math.hypot(a[0], a[1], a[2]) || 1;
    sn[i] = a[0] / l; sn[i + 1] = a[1] / l; sn[i + 2] = a[2] / l;
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
 * @param {object} h     { parseSTL, stackDatums, align } — align is "Line up parts"' state (or null)
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
    const datums = remembered || (modular && (align.datums?.[m.id] || (m.id === activeId ? { seat: align.seat, pitch: align.pitch } : null))) || detected;
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
    const snap = variant != null ? app.variants.snapOf(variant) : null;
    for (const p of parts.values()) p.mat = app.stackMaterial(snap, p.geo, frameFor(p), p.mat, testTex);
  }

  // Each item: a group on the axis at its stacked height, turned by its steps.
  let groups = [], bases = [];
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
      const mesh = new THREE.Mesh(p.geo, p.mat);
      mesh.position.set(-p.axis.x, -p.axis.y, 0);
      mesh.userData.item = groups.length;
      g.add(mesh);
      stack.add(g);
      groups.push(g); bases.push(base);
      z = base; prev = p;
    }
    showRing();
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
  const addSel = el('select', {}, ...[...parts.values()].map(p => el('option', { value: p.id }, p.name)));
  const varSel = el('select', { onchange: () => { variant = varSel.value === '' ? null : Number(varSel.value); buildMaterials(); layout(); remember(); } },
    el('option', { value: '' }, 'Current settings'),
    ...variantList.map(v => el('option', { value: v.id }, `${v.num} · ${v.label}`)));
  varSel.value = variant == null ? '' : String(variant);

  const testHint = el('p', { class: 'muted', hidden: true },
    'Thick lines are the tile edges, the arrows point up. Lined up, the lines run straight across every joint. ' +
    'A step in the level lines: up/down is off (joint heights). A step in the upright lines or tilted arrows: around is off (axis or steps).');
  const deg = (it) => steps ? `${+((it.turn * 360) / steps).toFixed(1)}°` : '';
  function renderList() {
    list.textContent = '';
    // Top of the stack first, as it stands.
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const sel = el('select', { onchange: () => { it.model = Number(sel.value); it.turn = 0; layout(); renderList(); remember(); }, onclick: (e) => e.stopPropagation() },
        ...[...parts.values()].map(p => el('option', { value: p.id }, p.name)));
      sel.value = String(it.model);
      const move = (d) => (e) => { e.stopPropagation(); const j = i + d; [items[i], items[j]] = [items[j], items[i]]; if (selected === i) selected = j; layout(); renderList(); remember(); };
      list.append(el('div', { class: 'pds-stack-row' + (i === selected ? ' sel' : ''), onclick: () => select(i === selected ? -1 : i) },
        sel, el('span', { class: 'deg' }, deg(it)),
        el('button', { title: 'Move up', disabled: i === items.length - 1, onclick: move(1) }, '▲'),
        el('button', { title: 'Move down', disabled: i === 0, onclick: move(-1) }, '▼'),
        el('button', { title: 'Remove from the stack', disabled: items.length < 2, onclick: (e) => { e.stopPropagation(); items.splice(i, 1); selected = -1; layout(); renderList(); remember(); } }, '✕')));
    }
  }
  function renderDatums() {
    datumsBox.textContent = '';
    for (const p of parts.values()) {
      const num = (k) => {
        const inp = el('input', { type: 'number', step: '0.01', value: p.datums[k].toFixed(2), title: k === 'seat' ? 'Bottom joint edge (mm, file Z)' : 'Where the next part sits, above the seat (mm)' });
        inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (Number.isFinite(v)) { p.edited = true; p.datums[k] = k === 'pitch' ? Math.max(0, v) : v; buildMaterials(); layout(); remember(); } });
        return inp;
      };
      datumsBox.append(el('span', {}, p.name), num('seat'), num('pitch'));
    }
  }
  function select(i) { selected = i; renderList(); showRing(); }

  const close = () => {
    remember();
    cancelAnimationFrame(raf);
    ro.disconnect();
    document.removeEventListener('keydown', onKey, true);
    controls.dispose();
    for (const p of parts.values()) { p.geo.dispose(); p.mat?.dispose(); }
    testTex?.dispose();
    renderer.dispose();
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    // Arrow keys turn the selected part one step.
    if (steps && selected >= 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest?.('input, select')) {
      e.preventDefault();
      turnTo(items[selected].turn + (e.key === 'ArrowLeft' ? 1 : -1));
    }
  };
  document.addEventListener('keydown', onKey, true);

  const overlay = el('div', { class: 'pds-stack' },
    el('aside', {},
      el('h3', {}, 'Stack view', el('button', { class: 'x', title: 'Close (Esc)', onclick: () => close() }, '✕')),
      el('h4', {}, 'Texture'), varSel,
      el('label', { title: 'Swap the image for a grid with the same size and placement: thick lines are the tile edges' },
        el('input', { type: 'checkbox', onchange: (e) => {
          if (e.target.checked) testTex = testPattern(); else { testTex?.dispose(); testTex = null; }
          buildMaterials(); layout();
          testHint.hidden = !e.target.checked;
        } }), ' Alignment test pattern'),
      testHint,
      el('h4', {}, 'Stack (top first)'), list,
      el('div', { class: 'pds-stack-row', style: 'cursor:default' }, addSel,
        el('button', { class: 'pds-btn', onclick: () => { items.push({ model: Number(addSel.value), turn: 0 }); layout(); renderList(); fit(); remember(); } }, 'Add on top')),
      steps
        ? el('p', { class: 'muted' }, `Drag a part up or down to move it in the stack. Click a part, then drag its ring to turn it — it snaps in steps of ${+(360 / steps).toFixed(2)}° (1/${steps}). ←/→ turn it one step.`)
        : el('p', { class: 'muted' }, modular
          ? 'Turning is off: tick "Parts may sit turned in steps" in Line up parts to turn parts here.'
          : 'Parts are not lined up for modular stacking (Line up parts), so the textures may not meet at the joints and parts cannot be turned.'),
      el('h4', {}, 'Joints per part: seat · next part at (mm above it)'), datumsBox,
      el('p', { class: 'muted' }, 'The whole part is textured here (painted masks are not shown).')),
    el('main', {}, canvas));
  document.body.append(overlay);

  // ── Turning ──
  function turnTo(turn) {
    const it = items[selected];
    it.turn = ((turn % steps) + steps) % steps;
    groups[selected].rotation.z = it.turn * stepRad;
    if (ring.userData.pivot) ring.userData.pivot.rotation.z = it.turn * stepRad;
    renderList();
    remember();
  }
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const setRay = (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  };
  const angleAt = () => {
    const pl = new THREE.Plane(new THREE.Vector3(0, 0, 1), -ring.position.z), pt = new THREE.Vector3();
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
    const hit = ray.intersectObjects(stack.children, true)[0];
    if (hit) {
      const z = heightAt(), i = hit.object.userData.item;
      if (z == null) return;
      move = { item: items[i], grabZ: z - bases[i], x: e.clientX, y: e.clientY, moving: false, sel: items[selected] };
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
    if (move) {
      if (!move.moving && Math.hypot(e.clientX - move.x, e.clientY - move.y) < 4) return;
      move.moving = true;
      canvas.style.cursor = 'ns-resize';
      ring.visible = false;
      const z = heightAt();
      if (z != null) dragPart(z);
      return;
    }
    if (drag) {
      const a = angleAt();
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
      : ray.intersectObjects(stack.children, true).length ? 'move' : '';
  });
  canvas.addEventListener('pointerup', (e) => {
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
