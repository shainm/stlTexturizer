/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * colorBake.js — Personal: which triangles of an exported mesh are textured and
 * which are not, so the preview colours can be baked into a 3MF.
 *
 * The export pipeline reorders and merges triangles, so nothing tells which
 * output triangle came from which source face. Instead every output triangle
 * takes the class of the NEAREST source face (displacement is bounded, so the
 * parent is the closest surface), found through a uniform grid over the source.
 */

const GRID = 64;   // cells along the longest axis

/** Squared distance from point p to triangle (a,b,c) — Ericson, Real-Time Collision Detection. */
function distSqPointTri(px, py, pz, p, o) {
  const ax = p[o], ay = p[o + 1], az = p[o + 2];
  const abx = p[o + 3] - ax, aby = p[o + 4] - ay, abz = p[o + 5] - az;
  const acx = p[o + 6] - ax, acy = p[o + 7] - ay, acz = p[o + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u, v;
  if (d1 <= 0 && d2 <= 0) { u = 0; v = 0; }
  else {
    const bpx = px - p[o + 3], bpy = py - p[o + 4], bpz = pz - p[o + 5];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { u = 1; v = 0; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { u = d1 / (d1 - d3); v = 0; }
      else {
        const cpx = px - p[o + 6], cpy = py - p[o + 7], cpz = pz - p[o + 8];
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { u = 0; v = 1; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { u = 0; v = d2 / (d2 - d6); }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { v = (d4 - d3) / ((d4 - d3) + (d5 - d6)); u = 1 - v; }
            else { const den = 1 / (va + vb + vc); u = vb * den; v = vc * den; }
          }
        }
      }
    }
  }
  const qx = ax + abx * u + acx * v - px, qy = ay + aby * u + acy * v - py, qz = az + abz * u + acz * v - pz;
  return qx * qx + qy * qy + qz * qz;
}

/**
 * @param {Float32Array} srcPos      source triangle soup (the pipeline's input positions)
 * @param {Float32Array} faceWeights per source corner, 1 = untextured (3 per face)
 * @param {Float32Array} outPos      exported triangle soup, same space as srcPos
 * @param {number} reach             farthest the texture moves a surface (mm)
 * @param {() => boolean} [shouldAbort]
 * @returns {Promise<Uint8Array|null>} per output triangle: 0 textured, 1 untextured;
 *   null when there is nothing to tell apart (all one class) or on abort
 */
export async function classifyUntextured(srcPos, faceWeights, outPos, reach, shouldAbort = () => false) {
  const nSrc = (srcPos.length / 9) | 0, nOut = (outPos.length / 9) | 0;
  if (!faceWeights || faceWeights.length < nSrc * 3) return null;
  const untex = new Uint8Array(nSrc);
  let nUntex = 0;
  for (let t = 0; t < nSrc; t++) {
    const w = faceWeights[t * 3] + faceWeights[t * 3 + 1] + faceWeights[t * 3 + 2];
    if (w > 1.5) { untex[t] = 1; nUntex++; }
  }
  if (nUntex === 0 || nUntex === nSrc) return null;

  // Grid over the source bounds, padded by the reach.
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < srcPos.length; i += 3) {
    const x = srcPos[i], y = srcPos[i + 1], z = srcPos[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const pad = Math.max(reach, 1e-3);
  minX -= pad; minY -= pad; minZ -= pad; maxX += pad; maxY += pad; maxZ += pad;
  const cell = Math.max(maxX - minX, maxY - minY, maxZ - minZ) / GRID;
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell)), ny = Math.max(1, Math.ceil((maxY - minY) / cell)), nz = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  const cx = (v) => Math.min(nx - 1, Math.max(0, ((v - minX) / cell) | 0));
  const cy = (v) => Math.min(ny - 1, Math.max(0, ((v - minY) / cell) | 0));
  const cz = (v) => Math.min(nz - 1, Math.max(0, ((v - minZ) / cell) | 0));

  // Face lists per cell (CSR): a face is in every cell its bounds, grown by the reach, touch.
  const counts = new Uint32Array(nx * ny * nz + 1);
  const span = (t, f) => {
    const o = t * 9;
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity, e = Infinity, g = -Infinity;
    for (let k = 0; k < 3; k++) {
      const x = srcPos[o + k * 3], y = srcPos[o + k * 3 + 1], z = srcPos[o + k * 3 + 2];
      if (x < a) a = x; if (x > b) b = x; if (y < c) c = y; if (y > d) d = y; if (z < e) e = z; if (z > g) g = z;
    }
    f(cx(a - reach), cx(b + reach), cy(c - reach), cy(d + reach), cz(e - reach), cz(g + reach));
  };
  for (let t = 0; t < nSrc; t++) {
    span(t, (x0, x1, y0, y1, z0, z1) => {
      for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) counts[((z * ny + y) * nx + x) + 1]++;
    });
  }
  for (let i = 0; i < counts.length - 1; i++) counts[i + 1] += counts[i];
  const faces = new Uint32Array(counts[counts.length - 1]);
  const fill = new Uint32Array(nx * ny * nz);
  for (let t = 0; t < nSrc; t++) {
    span(t, (x0, x1, y0, y1, z0, z1) => {
      for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const c = (z * ny + y) * nx + x;
        faces[counts[c] + fill[c]++] = t;
      }
    });
  }

  const out = new Uint8Array(nOut);
  for (let i = 0; i < nOut; i++) {
    if ((i & 0xffff) === 0xffff) {
      await new Promise(r => setTimeout(r, 0));
      if (shouldAbort()) return null;
    }
    const o = i * 9;
    const px = (outPos[o] + outPos[o + 3] + outPos[o + 6]) / 3;
    const py = (outPos[o + 1] + outPos[o + 4] + outPos[o + 7]) / 3;
    const pz = (outPos[o + 2] + outPos[o + 5] + outPos[o + 8]) / 3;
    const c = (cz(pz) * ny + cy(py)) * nx + cx(px);
    let best = Infinity, cls = 0;
    for (let k = counts[c]; k < counts[c + 1]; k++) {
      const t = faces[k];
      const d = distSqPointTri(px, py, pz, srcPos, t * 9);
      if (d < best) { best = d; cls = untex[t]; }
    }
    out[i] = cls;
  }
  return out;
}
