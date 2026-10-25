// forge.riv: the "design in progress" animation for any building. An isometric survey grid of the
// land; a survey line sweeps it; floor plates rise one by one into a massing while its corner lines
// draw upward and a height bracket follows. Done: the massing fills in and its windows light up.
// Failed: the plates drop and the grid dims.
//
// State machine "Forge", number `state`: 0 idle, 1 working, 2 done, 3 failed.

import { RivFile, EASE } from '../riv.mjs';
import { COLORS, iso, mix } from '../helpers.mjs';

const W = 800, H = 520;
const N = 8;                 // grid tiles per side
const K = 42;                // pixels per grid unit
const B = [2.6, 5.4];        // building footprint, both axes
const FLOORS = 5;
const STOREY = 0.62;         // grid units per floor
const TOP = FLOORS * STOREY;

export default function build() {
  const f = new RivFile();
  const ab = f.artboard({ name: 'Forge', width: W, height: H });
  const P = iso(W / 2, 105, K);
  const unit = P([0, 0, 0])[1] - P([0, 0, 1])[1];

  // Colours.
  const tileBase = '#202b39';
  const tileTop = mix(tileBase, '#ffffff', 0.16);
  const tileHot = mix(tileTop, COLORS.amber, 0.55);
  const tileDim = mix(tileBase, '#000000', 0.35);
  const plateTop = '#33445a';
  const faceL = '#263445', faceR = '#2f3f53', faceT = '#3b4d64';
  const ink = COLORS.ink;

  // Every animated property gets a pose in every animation: { idle, working, done, failed }.
  const ANIMS = { idle: { duration: 60, loop: 0 }, working: { duration: 240, loop: 1 }, done: { duration: 170, loop: 0 }, failed: { duration: 90, loop: 0 } };
  const tracks = [];
  // frames per animation: an array of [frame, value, ease?], or a single value meaning "hold".
  const track = (target, prop, poses) => tracks.push({ target, prop, poses });

  // ---- the land: a grid of flat tiles --------------------------------------------------------
  const order = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) order.push([i, j]);
  order.sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[0] - b[0]);
  const grid = ab.node(null, { name: 'grid' });
  const SWEEP = 150; // frames for the survey line to cross the grid
  for (const [i, j] of order) {
    const g = 0.1;
    const shape = ab.shape(grid, { name: `tile-${i}-${j}` });
    ab.path(shape, [P([i + g, j + g]), P([i + 1 - g, j + g]), P([i + 1 - g, j + 1 - g]), P([i + g, j + 1 - g])]);
    const fill = ab.fill(shape, tileTop);
    ab.stroke(shape, ink, 0.8, { alpha: 0.12 });
    // The survey line passes this row at frame t; the tile warms as it does.
    const t = ((j + 0.5) / N) * SWEEP;
    const under = i + 0.5 > B[0] && i + 0.5 < B[1] && j + 0.5 > B[0] && j + 0.5 < B[1];
    track(fill, 'colorValue', {
      idle: tileTop,
      working: [[0, tileTop, 'hold'], [Math.max(1, t - 10), tileTop, EASE.out], [t, under ? tileHot : mix(tileTop, COLORS.amber, 0.28), EASE.inOut], [t + 40, tileTop, 'hold'], [240, tileTop]],
      done: [[0, tileTop, EASE.inOut], [60, mix(tileBase, '#ffffff', 0.1)]],
      failed: [[0, tileTop, EASE.inOut], [50, tileDim]],
    });
  }

  // ---- the survey line -----------------------------------------------------------------------
  const scan = ab.node(null, { name: 'scan', opacity: 0 });
  const band = ab.shape(scan, { name: 'band' });
  ab.path(band, [P([-0.4, -0.35]), P([N + 0.4, -0.35]), P([N + 0.4, 0.35]), P([-0.4, 0.35])]);
  ab.fill(band, COLORS.amber, { alpha: 0.12 });
  const line = ab.shape(scan, { name: 'line' });
  ab.path(line, [P([-0.4, 0]), P([N + 0.4, 0])], { closed: false });
  ab.stroke(line, COLORS.ember, 2, { alpha: 0.95 });
  // Moving along the grid's y axis: screen offset per unit.
  const dy = P([0, 1])[1] - P([0, 0])[1], dx = P([0, 1])[0] - P([0, 0])[0];
  track(scan, 'x', { idle: 0, working: [[0, 0, EASE.linear], [SWEEP, dx * N], [SWEEP + 1, 0, 'hold'], [240, 0]], done: 0, failed: 0 });
  track(scan, 'y', { idle: 0, working: [[0, 0, EASE.linear], [SWEEP, dy * N], [SWEEP + 1, 0, 'hold'], [240, 0]], done: 0, failed: 0 });
  track(scan, 'opacity', { idle: 0, working: [[0, 0], [12, 1], [SWEEP - 14, 1], [SWEEP, 0, 'hold'], [240, 0]], done: 0, failed: 0 });

  const [b0, b1] = B;

  // ---- floor plates, rising one by one --------------------------------------------------------
  const plates = [];
  for (let fl = 0; fl <= FLOORS; fl++) {
    const z = fl * STOREY;
    const base = P([b1, b1, 0]);
    const node = ab.node(null, { name: `plate-${fl}`, x: base[0], y: base[1], opacity: 0 });
    const rel = (p) => { const q = P(p); return [q[0] - base[0], q[1] - base[1]]; };
    const t = 0.1;
    const sideL = ab.shape(node);
    ab.path(sideL, [rel([b0, b1, -t]), rel([b1, b1, -t]), rel([b1, b1, 0]), rel([b0, b1, 0])]);
    ab.fill(sideL, mix(plateTop, '#000000', 0.25));
    const sideR = ab.shape(node);
    ab.path(sideR, [rel([b1, b0, -t]), rel([b1, b1, -t]), rel([b1, b1, 0]), rel([b1, b0, 0])]);
    ab.fill(sideR, mix(plateTop, '#000000', 0.12));
    const top = ab.shape(node);
    ab.path(top, [rel([b0, b0, 0]), rel([b1, b0, 0]), rel([b1, b1, 0]), rel([b0, b1, 0])]);
    const topFill = ab.fill(top, plateTop, { alpha: 0.92 });
    const edge = ab.stroke(top, COLORS.amber, 1.6, { alpha: 0.95 });
    plates.push({ node, fl, z, topFill, edge, baseY: base[1] });
    const rise = 24 + fl * 22;          // frame it starts rising
    const lift = -z * unit;
    track(node, 'y', {
      idle: base[1],
      working: [[0, base[1], 'hold'], [rise, base[1], EASE.out], [rise + 34, base[1] + lift, 'hold'], [240, base[1] + lift]],
      done: base[1] + lift,
      failed: [[0, base[1] + lift, EASE.in], [36 + fl * 6, base[1] + 4]],
    });
    track(node, 'opacity', {
      idle: 0,
      working: [[0, 0, 'hold'], [rise, 0, EASE.out], [rise + 14, 1, 'hold'], [206, 1, EASE.inOut], [232, 0, 'hold'], [240, 0]],
      done: [[0, 1, 'hold'], [170, 1]],
      failed: [[0, 1, EASE.inOut], [70, 0.25]],
    });
    track(edge.color, 'colorValue', {
      idle: COLORS.amber,
      working: COLORS.amber,
      done: [[0, COLORS.amber, EASE.inOut], [60, mix(ink, faceT, 0.55)]],
      failed: [[0, COLORS.amber, EASE.inOut], [40, '#a0525a']],
    });
    track(topFill.color, 'colorValue', {
      idle: plateTop, working: plateTop,
      done: [[0, plateTop, EASE.inOut], [45, faceT]],
      failed: [[0, plateTop, EASE.inOut], [50, tileDim]],
    });
  }

  // ---- the massing, solid (shown when done) --------------------------------------------------
  // Drawn after the plates: its front faces are nearest the viewer, and a lower plate's top face
  // would otherwise paint over the walls above it.
  // Faded in through the paint's alpha (colour keys), which every runtime applies reliably.
  const clear = (c) => `${c}00`;
  const solid = ab.node(null, { name: 'solid' });
  const face = (pts, c) => {
    const s = ab.shape(solid);
    ab.path(s, pts.map(P));
    const fill = ab.fill(s, c, { alpha: 0 });
    track(fill, 'colorValue', { idle: clear(c), working: clear(c), done: [[0, clear(c), EASE.inOut], [45, c]], failed: clear(c) });
    return s;
  };
  face([[b0, b1, 0], [b1, b1, 0], [b1, b1, TOP], [b0, b1, TOP]], faceL);   // front-left face (y = b1)
  face([[b1, b0, 0], [b1, b1, 0], [b1, b1, TOP], [b1, b0, TOP]], faceR);   // front-right face (x = b1)
  face([[b0, b0, TOP], [b1, b0, TOP], [b1, b1, TOP], [b0, b1, TOP]], faceT);

  // Windows on the two front faces, lit one by one when done.
  const lights = ab.node(null, { name: 'windows' });
  let w = 0;
  for (let fl = 0; fl < FLOORS; fl++) {
    const z0 = fl * STOREY + 0.18, z1 = z0 + 0.3;
    for (let k = 0; k < 3; k++) {
      const a = b0 + 0.35 + k * 0.85, c = a + 0.45;
      for (const side of ['L', 'R']) {
        const pts = side === 'L'
          ? [[a, b1, z0], [c, b1, z0], [c, b1, z1], [a, b1, z1]]
          : [[b1, a, z0], [b1, c, z0], [b1, c, z1], [b1, a, z1]];
        const s = ab.shape(lights, { name: `win-${fl}-${k}-${side}` });
        ab.path(s, pts.map(P));
        const lit = side === 'L' ? COLORS.ember : mix(COLORS.ember, '#ffffff', 0.2);
        const fill = ab.fill(s, lit, { alpha: 0 });
        const start = 50 + ((w * 37) % 60);
        track(fill, 'colorValue', { idle: clear(lit), working: clear(lit), done: [[0, clear(lit), 'hold'], [start, clear(lit), EASE.out], [start + 14, `${lit}f2`]], failed: clear(lit) });
        w++;
      }
    }
  }

  // ---- corner lines drawing upward, and a height bracket --------------------------------------
  const corners = ab.node(null, { name: 'corners', opacity: 0 });
  const trims = [];
  for (const [x, y] of [[b0, b1], [b1, b1], [b1, b0]]) {
    const s = ab.shape(corners);
    ab.path(s, [P([x, y, 0]), P([x, y, TOP])], { closed: false });
    const st = ab.stroke(s, COLORS.ember, 1.4, { alpha: 0.9 });
    trims.push(ab.trim(st, { end: 0 }));
  }
  const bracket = ab.node(null, { name: 'bracket', opacity: 0 });
  const bx = b1 + 0.9;
  const bs = ab.shape(bracket);
  ab.path(bs, [P([bx, b0 - 0.15, 0]), P([bx, b0 - 0.15, TOP])], { closed: false });
  const bst = ab.stroke(bs, ink, 1.2, { alpha: 0.6 });
  const bTrim = ab.trim(bst, { end: 0 });
  for (let fl = 0; fl <= FLOORS; fl++) {
    const tick = ab.shape(bracket, { opacity: 0 });
    ab.path(tick, [P([bx - 0.12, b0 - 0.15, fl * STOREY]), P([bx + 0.18, b0 - 0.15, fl * STOREY])], { closed: false });
    ab.stroke(tick, ink, 1.2, { alpha: 0.7 });
    const at = 24 + fl * 22 + 30;
    track(tick, 'opacity', { idle: 0, working: [[0, 0, 'hold'], [at, 0, EASE.out], [at + 10, 1, 'hold'], [240, 1]], done: 1, failed: [[0, 1], [40, 0]] });
  }
  const climb = [[0, 0, 'hold'], [24, 0, EASE.inOut], [24 + FLOORS * 22 + 34, 1, 'hold'], [240, 1]];
  for (const tr of trims) track(tr, 'end', { idle: 0, working: climb, done: 1, failed: [[0, 1, EASE.in], [50, 0]] });
  track(bTrim, 'end', { idle: 0, working: climb, done: 1, failed: [[0, 1, EASE.in], [50, 0]] });
  track(corners, 'opacity', { idle: 0, working: [[0, 0, EASE.out], [20, 1, 'hold'], [206, 1, EASE.inOut], [232, 0, 'hold'], [240, 0]], done: [[0, 1, EASE.inOut], [70, 0]], failed: [[0, 1], [60, 0]] });
  track(bracket, 'opacity', { idle: 0, working: [[0, 0, EASE.out], [20, 1, 'hold'], [206, 1, EASE.inOut], [232, 0, 'hold'], [240, 0]], done: [[0, 1, 'hold'], [120, 1, EASE.inOut], [170, 0.6]], failed: [[0, 1], [60, 0]] });

  // ---- a sweep up the building when it's done -------------------------------------------------
  const sweep = ab.node(null, { name: 'sweep', opacity: 0 });
  const sw = ab.shape(sweep);
  ab.path(sw, [P([b0 - 0.1, b1 + 0.02, 0]), P([b1 + 0.02, b1 + 0.02, 0]), P([b1 + 0.02, b0 - 0.1, 0])], { closed: false });
  ab.stroke(sw, '#ffffff', 2.4, { alpha: 0.9 });
  track(sweep, 'y', { idle: 0, working: 0, done: [[0, 0, 'hold'], [20, 0, EASE.inOut], [95, -TOP * unit]], failed: 0 });
  track(sweep, 'opacity', { idle: 0, working: 0, done: [[0, 0, 'hold'], [20, 0, EASE.out], [30, 1, 'hold'], [80, 1, EASE.in], [100, 0]], failed: 0 });

  // ---- write the animations -------------------------------------------------------------------
  const anims = {};
  for (const [name, opts] of Object.entries(ANIMS)) anims[name] = ab.animation(name, opts);
  for (const { target, prop, poses } of tracks) {
    for (const [name, anim] of Object.entries(anims)) {
      const p = poses[name];
      anim.key(target, prop, Array.isArray(p) ? p : [[0, p, 'hold']]);
    }
  }

  const sm = ab.stateMachine('Forge');
  const state = sm.number('state', 0);
  const layer = sm.layer('Main');
  const states = [anims.idle, anims.working, anims.done, anims.failed].map((a) => layer.state(a));
  layer.transition(layer.entry, states[0]);
  states.forEach((from, a) => states.forEach((to, b) => {
    if (a !== b) layer.transition(from, to, { conditions: [{ input: state, op: '==', value: b }], duration: b === 1 ? 300 : 250 });
  }));
  return f;
}
