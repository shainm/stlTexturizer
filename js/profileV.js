/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * profileV.js — profile arc length for Spherical (Adaptive).
 *
 * The mode maps U = angle around Z and V = distance travelled along the part's
 * profile (its outline in the radius/height plane). On a vertical wall that is
 * height, on a flat top or bottom it is radius, and on a curve it is the true
 * arc length, so the texture stays continuous where a wall flows into a cap
 * (no cross-fade of two different mappings, which ghosts the pattern).
 *
 * Arc length cannot be computed from one point, so it is measured once on the
 * mesh: every vertex gets its shortest profile distance (Dijkstra, edge cost =
 * height travelled, plus radius travelled on near-flat faces, so going around
 * the axis or sideways along a lobed wall is free) from the vertex nearest the axis at the bottom of its connected piece. The
 * values are baked into a 2D grid over (radius, height) that the CPU mapping
 * and the preview shader both sample.
 *
 * Grid cells hold [V mm, weight, 0, 0]. Cells the mesh touches have weight 1;
 * empty cells are filled from their nearest touched cell with weight 1e-3, so a
 * weighted bilinear lookup near a surface ignores empty neighbours, and any
 * lookup still returns something.
 */

import { QuantizedPointMap } from './meshIndex.js';

const MAX_DIM = 1024;
const TARGET_CELLS = 768;       // cells along the longer of radius / height
const FILL_WEIGHT = 1e-3;
const FLAT_LO = 0.85;           // |normal.z| where radius starts to count
const FLAT_HI = 0.98;           // ...and counts fully
const BLUR_RADIUS = 2;          // cells, box blur per pass
const BLUR_PASSES = 2;

/** Separable box blur (zero outside the grid). */
function boxBlur(src, nx, ny, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < ny; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) if (x >= 0 && x < nx) acc += src[y * nx + x];
    for (let x = 0; x < nx; x++) {
      tmp[y * nx + x] = acc * inv;
      const add = x + r + 1, sub = x - r;
      if (add < nx) acc += src[y * nx + add];
      if (sub >= 0) acc -= src[y * nx + sub];
    }
  }
  for (let x = 0; x < nx; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) if (y >= 0 && y < ny) acc += tmp[y * nx + x];
    for (let y = 0; y < ny; y++) {
      out[y * nx + x] = acc * inv;
      const add = y + r + 1, sub = y - r;
      if (add < ny) acc += tmp[add * nx + x];
      if (sub >= 0) acc -= tmp[sub * nx + x];
    }
  }
  return out;
}

/**
 * @param {THREE.BufferGeometry} geometry  indexed or not; positions only
 * @param {{x:number,y:number,z:number}} center  projection axis passes through (x, y)
 * @returns {{ nr:number, nz:number, cell:number, zMin:number, data:Float32Array }|null}
 *   zMin is relative to center.z; data is RGBA per cell.
 */
export function buildProfile(geometry, center) {
  const pos = geometry.attributes.position;
  if (!pos) return null;
  const index = geometry.index ? geometry.index.array : null;
  const corners = index ? index.length : pos.count;
  const triCount = Math.floor(corners / 3);
  if (triCount === 0) return null;

  // Weld vertices and record (rho, z) per unique vertex.
  const map = new QuantizedPointMap(1e4, Math.min(corners, 1 << 22));
  const ids = new Int32Array(corners);
  let rhoArr = new Float32Array(Math.min(corners, 1 << 20));
  let zArr   = new Float32Array(rhoArr.length);
  let xArr   = new Float32Array(rhoArr.length);
  let yArr   = new Float32Array(rhoArr.length);
  let nv = 0;
  const grow = (a) => { const b = new Float32Array(a.length * 2); b.set(a); return b; };
  for (let c = 0; c < corners; c++) {
    const i = index ? index[c] : c;
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const id = map.getOrSet(x, y, z, nv);
    if (map.inserted) {
      if (nv >= rhoArr.length) { rhoArr = grow(rhoArr); zArr = grow(zArr); xArr = grow(xArr); yArr = grow(yArr); }
      xArr[nv] = x - center.x;
      yArr[nv] = y - center.y;
      rhoArr[nv] = Math.hypot(xArr[nv], yArr[nv]);
      zArr[nv]   = z - center.z;
      nv++;
    }
    ids[c] = id;
  }

  // CSR adjacency over triangle edges.
  const deg = new Int32Array(nv + 1);
  for (let t = 0; t < triCount; t++) {
    const a = ids[t * 3], b = ids[t * 3 + 1], c = ids[t * 3 + 2];
    deg[a] += 2; deg[b] += 2; deg[c] += 2;
  }
  const start = new Int32Array(nv + 1);
  for (let v = 0; v < nv; v++) start[v + 1] = start[v] + deg[v];
  const fillPos = start.slice(0, nv);
  const adj = new Int32Array(start[nv]);
  const cost = new Float32Array(start[nv]);
  for (let t = 0; t < triCount; t++) {
    const a = ids[t * 3], b = ids[t * 3 + 1], c = ids[t * 3 + 2];
    // Cost = height travelled, plus radius travelled only on near-flat faces.
    // True arc length makes a lobe's slanted flank longer than the wall beside
    // it, so lines of constant V bend up over every lobe and a rotated texture
    // wiggles. Height alone keeps them level on walls and slants (a lobe's
    // sideways radius change is free); radius counts only where the face is
    // flat enough that height says nothing (brims, tops, bottoms), and the
    // fade between the two keeps V continuous where a wall flows into a cap.
    const e1x = xArr[b] - xArr[a], e1y = yArr[b] - yArr[a], e1z = zArr[b] - zArr[a];
    const e2x = xArr[c] - xArr[a], e2y = yArr[c] - yArr[a], e2z = zArr[c] - zArr[a];
    const nzv = (e1x * e2y - e1y * e2x) /
      (Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x) || 1);
    const hRaw = Math.min(1, Math.max(0, (Math.abs(nzv) - FLAT_LO) / (FLAT_HI - FLAT_LO)));
    const h = hRaw * hRaw * (3 - 2 * hRaw);
    const w = (p, q) => Math.abs(zArr[q] - zArr[p]) + h * Math.abs(rhoArr[q] - rhoArr[p]);
    let k;
    k = fillPos[a]++; adj[k] = b; cost[k] = w(a, b);
    k = fillPos[a]++; adj[k] = c; cost[k] = w(a, c);
    k = fillPos[b]++; adj[k] = a; cost[k] = w(b, a);
    k = fillPos[b]++; adj[k] = c; cost[k] = w(b, c);
    k = fillPos[c]++; adj[k] = a; cost[k] = w(c, a);
    k = fillPos[c]++; adj[k] = b; cost[k] = w(c, b);
  }

  let rhoMax = 1e-6, zMin = Infinity, zMax = -Infinity;
  for (let v = 0; v < nv; v++) {
    if (rhoArr[v] > rhoMax) rhoMax = rhoArr[v];
    if (zArr[v] < zMin) zMin = zArr[v];
    if (zArr[v] > zMax) zMax = zArr[v];
  }

  // Seeds: per connected piece, the lowest vertex among those nearest the axis.
  const comp = new Int32Array(nv).fill(-1);
  const seeds = [];
  const stack = new Int32Array(nv);
  const rhoTol = rhoMax * 1e-3;
  for (let s = 0; s < nv; s++) {
    if (comp[s] !== -1) continue;
    let sp = 0, count = 0;
    let minRho = Infinity;
    const members = [];
    stack[sp++] = s; comp[s] = s;
    while (sp) {
      const v = stack[--sp];
      members.push(v);
      if (rhoArr[v] < minRho) minRho = rhoArr[v];
      for (let e = start[v]; e < start[v + 1]; e++) {
        const w = adj[e];
        if (comp[w] === -1) { comp[w] = s; stack[sp++] = w; }
      }
      count++;
    }
    let best = -1;
    for (const v of members) {
      if (rhoArr[v] > minRho + rhoTol) continue;
      if (best === -1 || zArr[v] < zArr[best]) best = v;
    }
    seeds.push(best);
  }

  // Multi-source Dijkstra; edge cost is the length in the (rho, z) plane.
  const dist = new Float32Array(nv).fill(Infinity);
  const heapV = new Int32Array(start[nv] + seeds.length + 1);
  const heapD = new Float32Array(heapV.length);
  let hn = 0;
  const push = (v, d) => {
    let i = hn++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapD[p] <= d) break;
      heapD[i] = heapD[p]; heapV[i] = heapV[p]; i = p;
    }
    heapD[i] = d; heapV[i] = v;
  };
  const pop = () => {
    const v = heapV[0];
    const d = heapD[--hn];
    const lv = heapV[hn];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= hn) break;
      if (c + 1 < hn && heapD[c + 1] < heapD[c]) c++;
      if (heapD[c] >= d) break;
      heapD[i] = heapD[c]; heapV[i] = heapV[c]; i = c;
    }
    heapD[i] = d; heapV[i] = lv;
    return v;
  };
  for (const s of seeds) { dist[s] = 0; push(s, 0); }
  while (hn) {
    const v = pop();
    const dv = dist[v];
    for (let e = start[v]; e < start[v + 1]; e++) {
      const w = adj[e];
      const nd = dv + cost[e];
      if (nd < dist[w]) { dist[w] = nd; if (hn < heapV.length) push(w, nd); }
    }
  }

  // Bake into a (rho, z) grid by drawing every triangle edge with V interpolated
  // along it (vertices alone leave big flat faces empty).
  const span = Math.max(rhoMax, zMax - zMin, 1e-6);
  const cell = span / TARGET_CELLS;
  const nr = Math.min(MAX_DIM, Math.floor(rhoMax / cell) + 2);
  const nz = Math.min(MAX_DIM, Math.floor((zMax - zMin) / cell) + 2);
  const sum = new Float32Array(nr * nz);
  const cnt = new Uint16Array(nr * nz);
  const plot = (rho, z, d) => {
    const ix = Math.min(nr - 1, Math.max(0, Math.floor(rho / cell)));
    const iy = Math.min(nz - 1, Math.max(0, Math.floor((z - zMin) / cell)));
    const k = iy * nr + ix;
    sum[k] += d; if (cnt[k] < 65535) cnt[k]++;
  };
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = ids[t * 3 + e], b = ids[t * 3 + (e + 1) % 3];
      const len = Math.hypot(rhoArr[b] - rhoArr[a], zArr[b] - zArr[a]);
      const steps = Math.max(1, Math.ceil(len / cell * 2));
      for (let s = 0; s <= steps; s++) {
        const f = s / steps;
        plot(rhoArr[a] + (rhoArr[b] - rhoArr[a]) * f,
             zArr[a]   + (zArr[b]   - zArr[a])   * f,
             dist[a]   + (dist[b]   - dist[a])   * f);
      }
    }
  }

  // Smooth the grid. Where the part is not a perfect solid of revolution,
  // different angles land in the same cell with slightly different V, so raw
  // cells disagree with their neighbours and the texture speckles. A small
  // weighted blur (V·coverage and coverage blurred together) makes V a
  // continuous function of (rho, z): the pattern stays connected, and the
  // angle-to-angle differences become a smooth, invisible distortion.
  let A = new Float32Array(nr * nz), B = new Float32Array(nr * nz);
  for (let k = 0; k < nr * nz; k++) if (cnt[k] > 0) { A[k] = sum[k] / cnt[k]; B[k] = 1; }
  for (let pass = 0; pass < BLUR_PASSES; pass++) {
    A = boxBlur(A, nr, nz, BLUR_RADIUS); B = boxBlur(B, nr, nz, BLUR_RADIUS);
  }

  const data = new Float32Array(nr * nz * 4);
  const queue = new Int32Array(nr * nz);
  let qh = 0, qt = 0;
  for (let k = 0; k < nr * nz; k++) {
    if (B[k] > 0.02) {
      data[k * 4] = A[k] / B[k]; data[k * 4 + 1] = Math.min(1, B[k]);
      queue[qt++] = k;
    }
  }
  while (qh < qt) { // nearest-touched-cell fill, breadth first
    const k = queue[qh++];
    const ix = k % nr, iy = (k - ix) / nr;
    const val = data[k * 4];
    const nb = [ix > 0 ? k - 1 : -1, ix < nr - 1 ? k + 1 : -1, iy > 0 ? k - nr : -1, iy < nz - 1 ? k + nr : -1];
    for (const n of nb) {
      if (n < 0 || data[n * 4 + 1] !== 0) continue;
      data[n * 4] = val; data[n * 4 + 1] = FILL_WEIGHT;
      queue[qt++] = n;
    }
  }
  return { nr, nz, cell, zMin, data };
}

/** Weighted bilinear lookup; mirrors the GLSL `profileV`. rho and z (relative to the centre) in mm. */
export function sampleProfile(p, rho, z) {
  const { nr, nz, cell, zMin, data } = p;
  const fx = Math.min(nr - 1, Math.max(0, rho / cell - 0.5));
  const fy = Math.min(nz - 1, Math.max(0, (z - zMin) / cell - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(nr - 1, x0 + 1), y1 = Math.min(nz - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  let sv = 0, sw = 0;
  const tap = (x, y, w) => {
    const k = (y * nr + x) * 4;
    const ww = w * data[k + 1];
    sv += data[k] * ww; sw += ww;
  };
  tap(x0, y0, (1 - tx) * (1 - ty));
  tap(x1, y0, tx * (1 - ty));
  tap(x0, y1, (1 - tx) * ty);
  tap(x1, y1, tx * ty);
  return sw > 0 ? sv / sw : 0;
}
