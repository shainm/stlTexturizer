/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// PDS edition, modular stacking (mapping.js scaleMmToRelative + a frame whose
// min.z is the part's seat): any part stacked on any part meets the texture at
// the same coordinates at the joint — also turned by one of `positions` steps
// with cylindrical mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { computeUV } from '../js/mapping.js';

const parts = { Base: 9.0, Bottom: 54.0, Body: 54.005, Top: 42.99, Odd: 47.3 };
const R = 57, P = 3;
const frame = (pitch, rotate) => {
  const min = new THREE.Vector3(-87.5, -87.5, 0), size = new THREE.Vector3(175, 175, Math.max(pitch, 1));
  return { min, size, max: min.clone().add(size), center: min.clone().addScaledVector(size, 0.5), modular: { pitch, positions: rotate ? P : 1 } };
};
const frac = (x) => x - Math.floor(x);
const dist = (a, b) => { const x = Math.abs(frac(a) - frac(b)); return Math.min(x, 1 - x); };
const main = (r) => (r.samples ? r.samples.reduce((x, y) => (y.w > x.w ? y : x)) : r);

for (const [mode, name, rotate] of [[3, 'cylindrical', false], [3, 'cylindrical turned 120°', true], [5, 'triplanar', false]]) {
  test(`every joint is seamless (${name})`, () => {
    const s = { scaleU: 11, scaleV: 9.3, offsetU: 0, offsetV: 0, rotation: 0, mappingBlend: 0, seamBandWidth: 0, textureAspectU: 1, textureAspectV: 1 };
    let worst = 0;
    for (const pl of Object.values(parts)) for (const pu of Object.values(parts)) {
      for (let k = 0; k < 360; k += 7) {
        const th = k * Math.PI / 180, turn = rotate ? 2 * Math.PI / P : 0;
        const a = main(computeUV(new THREE.Vector3(R * Math.cos(th), R * Math.sin(th), pl), new THREE.Vector3(Math.cos(th), Math.sin(th), 0), mode, s, frame(pl, rotate)));
        const b = main(computeUV(new THREE.Vector3(R * Math.cos(th - turn), R * Math.sin(th - turn), 0), new THREE.Vector3(Math.cos(th - turn), Math.sin(th - turn), 0), mode, s, frame(pu, rotate)));
        worst = Math.max(worst, dist(a.u, b.u), dist(a.v, b.v));
      }
    }
    assert.ok(worst < 1e-9, `worst mismatch ${worst}`);
  });
}
