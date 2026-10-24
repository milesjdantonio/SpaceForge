// forge.riv: a general "working" animation for any design request. An isometric grid of square
// tiles. State machine "Forge", number `state`: 0 idle (flat), 1 working (tiles rise and fall in a
// slow wave), 2 done (an amber sweep crosses the grid as it settles), 3 failed (tiles drop and dim).

import { RivFile, EASE } from '../riv.mjs';
import { COLORS, iso, mix } from '../helpers.mjs';

export default function build() {
  const f = new RivFile();
  const ab = f.artboard({ name: 'Forge', width: 800, height: 520 });
  const N = 9;
  const P = iso(400, 168, 34);
  const H = 2.4; // tallest tile, in grid units
  const BASE = '#2a3646';
  const topColor = mix(BASE, '#ffffff', 0.22);
  const leftColor = mix(BASE, '#ffffff', 0.04);
  const rightColor = mix(BASE, '#ffffff', 0.12);
  const tiles = [];

  // Back to front so nearer tiles draw over farther ones.
  const order = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) order.push([i, j]);
  order.sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[0] - b[0]);

  for (const [i, j] of order) {
    const g = 0.12; // gap between tiles
    const x0 = i + g, x1 = i + 1 - g, y0 = j + g, y1 = j + 1 - g;
    const base = P([x1, y1, 0]);
    const tile = ab.node(null, { name: `tile-${i}-${j}`, x: base[0], y: base[1] });
    const rel = (p) => { const q = P(p); return [q[0] - base[0], q[1] - base[1]]; };
    // Side faces from the ground up to one unit; scaleY sets the height.
    const sides = ab.node(tile, { name: 'sides', scaleY: 0.02 });
    const left = ab.shape(sides, { name: 'left' });
    ab.path(left, [rel([x0, y1, 0]), rel([x1, y1, 0]), rel([x1, y1, 1]), rel([x0, y1, 1])]);
    ab.fill(left, leftColor);
    const right = ab.shape(sides, { name: 'right' });
    ab.path(right, [rel([x1, y0, 0]), rel([x1, y1, 0]), rel([x1, y1, 1]), rel([x1, y0, 1])]);
    ab.fill(right, rightColor);
    // The top face rides on the sides.
    const top = ab.shape(tile, { name: 'top', y: 0 });
    ab.path(top, [rel([x0, y0, 0]), rel([x1, y0, 0]), rel([x1, y1, 0]), rel([x0, y1, 0])]);
    const topFill = ab.fill(top, topColor);
    ab.stroke(top, COLORS.ink, 1, { alpha: 0.35 });
    const unit = P([0, 0, 0])[1] - P([0, 0, 1])[1]; // pixels per unit of height
    tiles.push({ i, j, sides, top, topFill, unit });
  }

  const T = 150; // wave period, frames
  const idle = ab.animation('idle', { duration: 60, loop: 0 });
  const working = ab.animation('working', { duration: T, loop: 1 });
  const done = ab.animation('done', { duration: 150, loop: 0 });
  const failed = ab.animation('failed', { duration: 70, loop: 0 });
  const flat = 0.02;

  for (const t of tiles) {
    const d = Math.hypot(t.i - (N - 1) / 2, t.j - (N - 1) / 2);
    const phase = (d / N) * 2.2 + (t.i * 0.13);
    const height = (k) => {
      const v = 0.5 + 0.5 * Math.sin((2 * Math.PI * k) / 8 - phase * Math.PI);
      return flat + v * v * H * (1 - d / (N * 0.95)) ** 1.2;
    };
    idle.key(t.sides, 'scaleY', [[0, flat, 'hold']]);
    idle.key(t.top, 'y', [[0, 0, 'hold']]);
    idle.key(t.topFill, 'colorValue', [[0, topColor, 'hold']]);

    const sy = [], ty = [];
    for (let k = 0; k <= 8; k++) {
      const h = height(k % 8);
      sy.push([(k * T) / 8, h, EASE.inOut]);
      ty.push([(k * T) / 8, -h * t.unit, EASE.inOut]);
    }
    working.key(t.sides, 'scaleY', sy);
    working.key(t.top, 'y', ty);
    working.key(t.topFill, 'colorValue', [[0, topColor, 'hold']]);

    // Done: a sweep from the front corner; each tile lifts once, glows amber, settles.
    const s = (t.i + t.j) * 6;
    done.key(t.sides, 'scaleY', [[0, flat], [s, flat, EASE.out], [s + 18, 0.9, EASE.inOut], [s + 46, flat]]);
    done.key(t.top, 'y', [[0, 0], [s, 0, EASE.out], [s + 18, -0.9 * t.unit, EASE.inOut], [s + 46, 0]]);
    done.key(t.topFill, 'colorValue', [[0, topColor], [s + 6, topColor, EASE.out], [s + 20, COLORS.amber, EASE.inOut], [s + 60, topColor]]);

    failed.key(t.sides, 'scaleY', [[0, 0.6, EASE.in], [30 + (t.i % 3) * 8, flat]]);
    failed.key(t.top, 'y', [[0, -0.6 * t.unit, EASE.in], [30 + (t.i % 3) * 8, 0]]);
    failed.key(t.topFill, 'colorValue', [[0, topColor, EASE.inOut], [60, mix(BASE, '#000000', 0.25)]]);
  }

  const sm = ab.stateMachine('Forge');
  const state = sm.number('state', 0);
  const layer = sm.layer('Main');
  const states = [idle, working, done, failed].map((a) => layer.state(a));
  layer.transition(layer.entry, states[0]);
  states.forEach((from, a) => states.forEach((to, b) => {
    if (a !== b) layer.transition(from, to, { conditions: [{ input: state, op: '==', value: b }], duration: b === 1 ? 400 : 250 });
  }));
  return f;
}
