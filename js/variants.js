/**
 * Variants: a row of saved setting sets beside the viewport's bottom
 * bar. "+" saves the current settings (texture layers, painted surfaces and
 * all) as a new chip; clicking a chip restores it, so flipping between chips
 * compares versions in the same view; the little x on a chip removes it.
 *
 * A variant is an undo snapshot, so restoring one goes through the same code
 * as Ctrl+Z (and can itself be undone). Loading another model keeps them (minus
 * their painted surfaces, which belong to the old model), so they can be applied
 * to every model of a project; they are saved with projects and shared settings.
 */

const PLUS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 7.5v9M7.5 12h9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const X_SVG = '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></svg>';

/**
 * @param {object} o
 * @param {HTMLElement} o.host   the bar to fill
 * @param {Function} o.t         i18n lookup
 * @param {() => object} o.capture   current state as a snapshot
 * @param {(snap: object) => void} o.apply   restore a snapshot
 * @param {(a: object, b: object) => boolean} o.equal
 * @param {() => boolean} o.hasModel
 * @returns {{ clear: () => void, refresh: () => void }}
 */
export function initVariants({ host, t, capture, apply, equal, hasModel, onChange = () => {} }) {
  let variants = [];      // { id, snap, label, tip }
  let nextId = 1;
  let activeId = null;    // the chip last saved or restored
  let timer = null;

  const describe = (snap) => {
    const names = snap.layers.filter(l => l.visible && l.mapName).map(l => l.mapName);
    const g = snap.layers[snap.active]?.settings || {};
    const bits = [names.join(' + ') || t('variants.noTexture')];
    if (g.textureHeight != null) bits.push(`${t('variants.depth')} ${g.textureHeight}`);
    return { label: names[0] || t('variants.noTexture'), tip: bits.join(' · ') };
  };

  // Settings changed while a chip is active belong to that chip: they are
  // written back when you leave it. Restoring fires change events and loads
  // textures, so right after a restore the live state is not yet the chip's.
  let appliedAt = 0;
  let busy = false;   // a batch (runEach) is cycling through variants
  function keepEdits() {
    const v = variants.find(o => o.id === activeId);
    if (!v || busy || Date.now() - appliedAt < 800) return;
    const now = capture();
    if (equal(v.snap, now)) return;
    const d = describe(now);
    Object.assign(v, { snap: now, tip: d.tip }, v.custom ? {} : { label: d.label });
  }

  // Double-click a chip to rename it; empty goes back to the automatic name.
  let editing = false;
  function rename(v, name) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'variant-rename';
    input.value = v.label;
    input.maxLength = 40;
    input.style.width = `${Math.max(6, Math.min(24, v.label.length + 2))}ch`;
    name.replaceWith(input);
    editing = true;
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      editing = false;
      const text = input.value.trim();
      if (save) {
        if (text) { v.label = text; v.custom = true; }
        else { v.custom = false; v.label = describe(v.snap).label; }
      }
      render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();   // typing here must not trigger app shortcuts
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('dblclick', e => e.stopPropagation());
  }

  function render() {
    if (editing) return;
    onChange();
    host.classList.toggle('hidden', !hasModel());
    host.textContent = '';
    variants.forEach((v, i) => {
      const chip = document.createElement('div');
      const active = v.id === activeId;
      chip.className = 'variant-chip' + (active ? ' active' : '');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'variant-btn';
      btn.title = `${v.tip}\n${t('variants.restoreTip')} · ${t('variants.renameTip')}`;
      const num = document.createElement('b');
      num.textContent = String(i + 1);
      const name = document.createElement('span');
      name.textContent = v.label;
      btn.append(num, name);
      btn.addEventListener('dblclick', () => rename(v, name));
      btn.addEventListener('click', () => {
        if (v.id === activeId) return;
        keepEdits();
        activeId = v.id;
        appliedAt = Date.now();
        apply({ ...v.snap, paint: v.snap.paint ? structuredClone(v.snap.paint) : null });
        render();
      });

      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'variant-x';
      x.innerHTML = X_SVG;
      x.title = t('variants.remove');
      x.setAttribute('aria-label', t('variants.remove'));
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        variants = variants.filter(o => o.id !== v.id);
        if (activeId === v.id) activeId = null;
        render();
      });

      chip.append(btn, x);
      host.append(chip);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'variant-add';
    add.innerHTML = PLUS_SVG;
    add.title = t('variants.add');
    add.setAttribute('aria-label', t('variants.add'));
    add.addEventListener('click', () => {
      const snap = capture();
      appliedAt = 0;
      const v = { id: nextId++, snap, ...describe(snap) };
      variants.push(v);
      activeId = v.id;
      render();
    });
    host.append(add);
  }

  // Edits mark the active chip as modified; settle first so a slider drag isn't a render per tick.
  const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { keepEdits(); render(); }, 350); };

  /** The saved variants in chip order: [{ id, num, label }]. */
  function list() {
    keepEdits();
    return variants.map((v, i) => ({ id: v.id, num: i + 1, label: v.label }));
  }

  /**
   * Restore each variant in turn (ids in the order given) and run `cb(id)` on
   * it, e.g. to export it; `cb` returning false stops. The settings from before
   * (and the chip that was active) come back afterwards, whatever happens.
   */
  async function runEach(ids, cb) {
    keepEdits();
    const before = capture(), beforeActive = activeId;
    const restore = (snap) => apply({ ...snap, paint: snap.paint ? structuredClone(snap.paint) : null });
    busy = true;
    try {
      for (const id of ids) {
        const v = variants.find(o => o.id === id);
        if (!v) continue;
        restore(v.snap);
        await new Promise(r => setTimeout(r, 150));   // let the restore settle
        if (await cb(id) === false) break;
      }
    } finally {
      restore(before);
      activeId = beforeActive;
      appliedAt = Date.now();
      busy = false;
      render();
    }
  }

  /** The chips as plain data (snapshots without their texture objects) for keeping across a reload. */
  function serialize() {
    keepEdits();
    const strip = (snap) => ({ ...snap, layers: snap.layers.map(l => ({ ...l, mapEntry: null })) });
    return {
      active: variants.findIndex(v => v.id === activeId),
      items: variants.map(v => ({ label: v.label, tip: v.tip, custom: !!v.custom, snap: strip(v.snap) })),
    };
  }

  /** Put back what serialize() produced; `fix(snap)` may rebuild a snapshot (async), e.g. to reload its textures. */
  async function restore(data, fix = async (s) => s) {
    if (!data || !Array.isArray(data.items)) return;
    const next = [];
    for (const it of data.items) {
      next.push({ id: nextId++, label: it.label, tip: it.tip, custom: it.custom, snap: await fix(it.snap) });
    }
    variants = next;
    activeId = next[data.active]?.id ?? null;
    appliedAt = Date.now();
    render();
  }

  render();
  return {
    clear() { variants = []; activeId = null; render(); },
    /** A new model is loaded: keep the chips, but painted surfaces belong to the old model's triangles. */
    dropPaint() { keepEdits(); for (const v of variants) v.snap = { ...v.snap, paint: null }; render(); },
    serialize,
    restore,
    refresh,
    list,
    runEach,
  };
}
