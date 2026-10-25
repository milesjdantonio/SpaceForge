// guide.riv: short looping scenes for the How to guide, one artboard per step, all 320 x 180 like
// outline.riv (which, with forge.riv, covers the outlining and sending steps).
//   Find     — a pointer clicks the globe, it zooms in, a pin drops where it landed.
//   Describe — a type is picked, the description types itself, the fit bar fills.
//   Move     — from above: the building is dragged by its grip, then turned by the ring grip.
//   Inside   — a floor plan; a visitor walks room to room, looking ahead.
//   Save     — a new building slides into My Builds with a tick, then its link is copied.
//
// Each has one looping animation, "play" (autoplays), that fades through dark as it loops.

import { RivFile, EASE } from '../riv.mjs';
import { COLORS, mix } from '../helpers.mjs';

const W = 320, H = 180;
const GROUND = '#0a1019', PANEL = '#0d131c', PANEL3 = '#1b2533', BORDER = '#243142', GREEN = '#5fd39a';

function scene(f, name, L) {
  const ab = f.artboard({ name, width: W, height: H });
  const bg = ab.shape(null, { name: 'bg' });
  ab.rect(bg, { w: W, h: H, r: 10 });
  ab.fill(bg, GROUND);
  const anim = ab.animation('play', { duration: L, loop: 1 });
  return { ab, anim, L };
}

// The pointer and its click ripple, drawn last so they sit on top.
function pointer(s, start) {
  const { ab } = s;
  const ripple = ab.node(null, { name: 'ripple', opacity: 0 });
  const rs = ab.shape(ripple);
  ab.ellipse(rs, { w: 26, h: 26 });
  ab.stroke(rs, '#ffffff', 1.6);
  const cursor = ab.node(null, { name: 'cursor', x: start[0], y: start[1] });
  const arrow = ab.shape(cursor);
  ab.path(arrow, [[0, 0], [0, 17], [4.5, 13], [8, 20.5], [11, 19], [7.6, 11.8], [13, 11.6]]);
  ab.fill(arrow, '#ffffff');
  ab.stroke(arrow, '#111418', 1.2);
  return { cursor, ripple, arrow };
}
// Pointer path: [[frame, [x, y], ease?], ...]; clicks: [[frame, [x, y]], ...]; holds: frame spans pressed.
function drive(s, p, path, clicks = [], holds = []) {
  const { anim } = s;
  // A missing ease means ease in-out; EASE.linear is null, so it can't use ??.
  const ease = (e) => (e === undefined ? EASE.inOut : e);
  anim.key(p.cursor, 'x', path.map(([t, [x], e]) => [t, x, ease(e)]));
  anim.key(p.cursor, 'y', path.map(([t, [, y], e]) => [t, y, ease(e)]));
  const rx = [[0, clicks[0]?.[1][0] ?? 0, 'hold']], ry = [[0, clicks[0]?.[1][1] ?? 0, 'hold']];
  const sc = [[0, 0.3, 'hold']], op = [[0, 0, 'hold']];
  for (const [t, [x, y]] of clicks) {
    rx.push([t, x, 'hold']); ry.push([t, y, 'hold']);
    sc.push([t, 0.3, EASE.out], [t + 22, 1.4, 'hold']);
    op.push([t, 0.9, EASE.out], [t + 22, 0, 'hold']);
  }
  anim.key(p.ripple, 'x', rx); anim.key(p.ripple, 'y', ry);
  anim.key(p.ripple, 'scaleX', sc); anim.key(p.ripple, 'scaleY', sc);
  anim.key(p.ripple, 'opacity', op);
  // The arrow dips while pressed.
  const press = [[0, 1, 'hold']];
  for (const [a, b] of [...clicks.map(([t]) => [t - 2, t + 6]), ...holds]) press.push([a, 1, EASE.out], [a + 4, 0.86, 'hold'], [b, 0.86, EASE.out], [b + 5, 1, 'hold']);
  press.sort((m, n) => m[0] - n[0]);
  anim.key(p.cursor, 'scaleX', press); anim.key(p.cursor, 'scaleY', press);
}
// A dark veil that lifts at the start and falls at the end, so the loop doesn't jump.
function veil(s) {
  const { ab, anim, L } = s;
  const v = ab.shape(null, { name: 'veil' });
  ab.rect(v, { w: W, h: H, r: 10 });
  ab.fill(v, GROUND);
  anim.key(v, 'opacity', [[0, 1, EASE.out], [16, 0, 'hold'], [L - 22, 0, EASE.in], [L - 4, 1, 'hold'], [L, 1]]);
}
const box = (ab, parent, { x, y, w, h, r = 3, fill, stroke, sw = 1.4, name }) => {
  const s = ab.shape(parent, { name, x, y });
  ab.rect(s, { w, h, r, originX: 0, originY: 0 });
  const out = { s };
  if (fill) out.fill = ab.fill(s, fill);
  if (stroke) out.stroke = ab.stroke(s, stroke, sw);
  return out;
};
const line = (ab, parent, pts, color, width, opts = {}) => {
  const s = ab.shape(parent, opts.props ?? {});
  ab.path(s, pts, { closed: false });
  const st = ab.stroke(s, color, width, { alpha: opts.alpha ?? 1 });
  return { s, st };
};

// ---- Find your land --------------------------------------------------------------------------------
function find(f) {
  const s = scene(f, 'Find', 300);
  const { ab, anim } = s;
  // Stars.
  for (let i = 0; i < 26; i++) {
    const d = ab.shape(null, { x: (i * 97) % W, y: (i * 53 + 11) % H });
    ab.ellipse(d, { w: 1.6, h: 1.6 });
    ab.fill(d, '#ffffff', { alpha: 0.25 + (i % 4) * 0.12 });
  }
  const C = [160, 92], R = 54;
  const globe = ab.node(null, { name: 'globe', x: C[0], y: C[1] });
  const disc = ab.shape(globe);
  ab.ellipse(disc, { w: R * 2, h: R * 2 });
  ab.fill(disc, '#1f4b73');
  const land = (pts, c) => { const sh = ab.shape(globe); ab.path(sh, pts, { radius: 6 }); ab.fill(sh, c); };
  land([[-34, -30], [-8, -40], [4, -22], [-6, -4], [-26, 2], [-40, -12]], '#4d7a4f');
  land([[8, 6], [30, -6], [44, 10], [34, 34], [14, 38], [6, 22]], '#6b7d4a');
  land([[-30, 18], [-14, 14], [-10, 32], [-24, 40]], '#4d7a4f');
  for (const w of [R * 0.9, R * 1.5]) {
    const m = ab.shape(globe);
    ab.ellipse(m, { w, h: R * 2 });
    ab.stroke(m, '#ffffff', 0.8, { alpha: 0.18 });
  }
  line(ab, globe, [[-R, 0], [R, 0]], '#ffffff', 0.8, { alpha: 0.18 });
  const rim = ab.shape(globe);
  ab.ellipse(rim, { w: R * 2, h: R * 2 });
  ab.stroke(rim, '#9cc4ea', 1.4, { alpha: 0.5 });

  // The click lands at P; the globe zooms about it until P sits in the middle.
  const P = [186, 104], Z = 2.2; // on the eastern patch of land
  const after = [W / 2 + (C[0] - P[0]) * Z, H / 2 + (C[1] - P[1]) * Z];
  anim.key(globe, 'x', [[0, C[0], 'hold'], [96, C[0], EASE.inOut], [160, after[0], 'hold'], [300, after[0]]]);
  anim.key(globe, 'y', [[0, C[1], 'hold'], [96, C[1], EASE.inOut], [160, after[1], 'hold'], [300, after[1]]]);
  anim.key(globe, 'scaleX', [[0, 1, 'hold'], [96, 1, EASE.inOut], [160, Z, 'hold'], [300, Z]]);
  anim.key(globe, 'scaleY', [[0, 1, 'hold'], [96, 1, EASE.inOut], [160, Z, 'hold'], [300, Z]]);

  // A pin drops where it landed.
  const pin = ab.node(null, { name: 'pin', x: W / 2, y: H / 2, opacity: 0 });
  const shadow = ab.shape(pin);
  ab.ellipse(shadow, { w: 14, h: 4 });
  ab.fill(shadow, '#000000', { alpha: 0.4 });
  const head = ab.node(pin, { name: 'head' });
  const hs = ab.shape(head);
  ab.path(hs, [[0, 0], [-7, -12, 2], [-8, -20, 7], [0, -28, 7], [8, -20, 7], [7, -12, 2]]);
  ab.fill(hs, COLORS.amber);
  ab.stroke(hs, '#1b0e03', 1.2, { alpha: 0.6 });
  const dot = ab.shape(head, { y: -19 });
  ab.ellipse(dot, { w: 6, h: 6 });
  ab.fill(dot, '#ffffff');
  anim.key(pin, 'opacity', [[0, 0, 'hold'], [166, 0, EASE.out], [170, 1, 'hold'], [300, 1]]);
  anim.key(head, 'y', [[0, -40, 'hold'], [166, -40, EASE.in], [184, 0, EASE.out], [192, -5, EASE.in], [200, 0, 'hold'], [300, 0]]);

  const p = pointer(s, [262, 160]);
  drive(s, p, [[0, [262, 160]], [70, P, 'hold'], [96, P, EASE.inOut], [150, [232, 142], 'hold'], [300, [232, 142]]], [[78, P]]);
  veil(s);
}

// ---- Describe the building ---------------------------------------------------------------------------
function describe(f) {
  const s = scene(f, 'Describe', 330);
  const { ab, anim } = s;
  box(ab, null, { x: 40, y: 14, w: 240, h: 152, r: 8, fill: PANEL, stroke: BORDER });
  // Three housing types; the middle one is picked.
  const tiles = [64, 130, 196].map((x, i) => {
    const t = box(ab, null, { x, y: 28, w: 60, h: 40, r: 6, fill: PANEL3, stroke: BORDER, name: `type-${i}` });
    const icon = ab.shape(null, { x: x + 30, y: 50 });
    ab.path(icon, i === 0 ? [[-10, 2], [0, -8], [10, 2]] : i === 1 ? [[-13, 2], [-6, -8], [1, 2], [7, -8], [13, 2]] : [[-8, 8], [-8, -10], [8, -10], [8, 8]], { closed: false });
    ab.stroke(icon, COLORS.inkSoft, 1.8);
    const base = ab.shape(null, { x: x + 30, y: 50 });
    ab.path(base, [[-10, 2], [-10, 10], [10, 10], [10, 2]], { closed: false });
    ab.stroke(base, COLORS.inkSoft, 1.8);
    return t;
  });
  anim.key(tiles[1].stroke, 'colorValue', [[0, BORDER, 'hold'], [70, BORDER, EASE.out], [80, COLORS.amber, 'hold'], [330, COLORS.amber]]);
  anim.key(tiles[1].fill, 'colorValue', [[0, PANEL3, 'hold'], [70, PANEL3, EASE.out], [80, mix(PANEL3, COLORS.amber, 0.22), 'hold'], [330, mix(PANEL3, COLORS.amber, 0.22)]]);
  // The description types itself, line by line.
  box(ab, null, { x: 64, y: 78, w: 192, h: 44, r: 5, fill: '#0a1019', stroke: BORDER });
  [[72, 90, 176], [72, 100, 160], [72, 110, 104]].forEach(([x, y, w], i) => {
    const l = line(ab, null, [[x, y], [x + w, y]], COLORS.inkSoft, 2.4, { alpha: 0.8 });
    const trim = ab.trim(l.st, { end: 0 });
    const t0 = 100 + i * 42;
    anim.key(trim, 'end', [[0, 0, 'hold'], [t0, 0, EASE.linear], [t0 + 40, 1, 'hold'], [330, 1]]);
  });
  // The fit check: a bar that fills green with a tick.
  box(ab, null, { x: 64, y: 134, w: 192, h: 20, r: 5, fill: PANEL3 });
  box(ab, null, { x: 72, y: 142, w: 120, h: 4, r: 2, fill: '#2a3647' });
  const bar = box(ab, null, { x: 72, y: 142, w: 120, h: 4, r: 2, fill: GREEN, name: 'fit' });
  anim.key(bar.s, 'scaleX', [[0, 0.001, 'hold'], [240, 0.001, EASE.out], [280, 0.42, 'hold'], [330, 0.42]]);
  const tick = ab.node(null, { name: 'tick', x: 240, y: 144, opacity: 0 });
  const tc = ab.shape(tick);
  ab.ellipse(tc, { w: 12, h: 12 });
  ab.fill(tc, GREEN);
  line(ab, tick, [[-3, 0], [-0.8, 2.4], [3.2, -2.2]], '#0a1019', 1.6);
  anim.key(tick, 'opacity', [[0, 0, 'hold'], [276, 0, EASE.out], [284, 1, 'hold'], [330, 1]]);
  anim.key(tick, 'scaleX', [[0, 0.4, 'hold'], [276, 0.4, EASE.back], [290, 1, 'hold'], [330, 1]]);
  anim.key(tick, 'scaleY', [[0, 0.4, 'hold'], [276, 0.4, EASE.back], [290, 1, 'hold'], [330, 1]]);

  const p = pointer(s, [286, 170]);
  drive(s, p, [[0, [286, 170]], [60, [160, 50], 'hold'], [90, [160, 50], EASE.inOut], [130, [250, 118], 'hold'], [330, [250, 118]]], [[66, [160, 50]]]);
  veil(s);
}

// ---- Move or turn it (seen from above) ---------------------------------------------------------------
function move(f) {
  const L = 360;
  const s = scene(f, 'Move', L);
  const { ab, anim } = s;
  // Satellite-ish ground and the outlined land.
  const g = ab.shape(null);
  ab.rect(g, { x: 6, y: 6, w: W - 12, h: H - 12, r: 8 });
  ab.fill(g, '#25301f');
  const landS = ab.shape(null, { name: 'land' });
  ab.path(landS, [[44, 24], [278, 18], [292, 158], [34, 162]]);
  const landFill = ab.fill(landS, COLORS.ember, { alpha: 0.12 });
  const landLine = ab.stroke(landS, COLORS.ember, 2);
  void landFill; void landLine;

  // The building, its ring and grips all move together; the building and turn grip also turn.
  const A = [120, 92], B = [196, 96];
  const rig = ab.node(null, { name: 'rig', x: A[0], y: A[1] });
  const ring = ab.shape(rig);
  ab.ellipse(ring, { w: 104, h: 104 });
  ab.stroke(ring, COLORS.ember, 1.6, { alpha: 0.75 });
  const spin = ab.node(rig, { name: 'spin' });
  const house = ab.shape(spin);
  ab.rect(house, { w: 62, h: 40, r: 2, originX: 0.5, originY: 0.5 });
  ab.fill(house, '#e9e4da');
  ab.stroke(house, '#2b2f33', 1.2);
  const ridge = line(ab, spin, [[-24, 0], [24, 0]], '#9a9286', 1.4);
  void ridge;
  const front = box(ab, spin, { x: -8, y: 18, w: 16, h: 3, r: 1, fill: COLORS.amber });
  void front;
  const knob = ab.node(spin, { name: 'knob', y: 52 });
  const ks = ab.shape(knob);
  ab.ellipse(ks, { w: 16, h: 16 });
  ab.fill(ks, COLORS.amber);
  ab.stroke(ks, '#ffffff', 1.4);
  line(ab, knob, [[-3.5, -1], [0, -4], [3.5, -1]], '#1b0e03', 1.4);
  const grip = ab.node(rig, { name: 'grip' });
  const gs = ab.shape(grip);
  ab.ellipse(gs, { w: 22, h: 22 });
  ab.fill(gs, COLORS.amber);
  ab.stroke(gs, '#ffffff', 1.6);
  line(ab, grip, [[-6, 0], [6, 0]], '#1b0e03', 1.8);
  line(ab, grip, [[0, -6], [0, 6]], '#1b0e03', 1.8);

  // Drag: frames 60-140. Turn: 190-270, by T radians.
  const T = 0.75;
  anim.key(rig, 'x', [[0, A[0], 'hold'], [60, A[0], EASE.inOut], [140, B[0], 'hold'], [L, B[0]]]);
  anim.key(rig, 'y', [[0, A[1], 'hold'], [60, A[1], EASE.inOut], [140, B[1], 'hold'], [L, B[1]]]);
  anim.key(spin, 'rotation', [[0, 0, 'hold'], [190, 0, EASE.inOut], [270, T, 'hold'], [L, T]]);
  anim.key(grip, 'scaleX', [[0, 1, 'hold'], [54, 1, EASE.out], [60, 0.9, 'hold'], [140, 0.9, EASE.out], [148, 1, 'hold'], [L, 1]]);
  anim.key(grip, 'scaleY', [[0, 1, 'hold'], [54, 1, EASE.out], [60, 0.9, 'hold'], [140, 0.9, EASE.out], [148, 1, 'hold'], [L, 1]]);

  // The pointer follows: onto the grip, along with the drag, round to the knob, round the ring.
  const knobAt = (a) => [B[0] - Math.sin(a) * 52, B[1] + Math.cos(a) * 52];
  const arc = [0.25, 0.5, 0.75].map((k) => [190 + k * 80, knobAt(T * k), EASE.linear]);
  const p = pointer(s, [270, 168]);
  drive(s, p, [
    [0, [270, 168]], [48, A, 'hold'], [60, A, EASE.inOut], [140, B, 'hold'], [150, B, EASE.inOut],
    [184, knobAt(0), 'hold'], [190, knobAt(0), EASE.linear], ...arc, [270, knobAt(T), 'hold'],
    [300, knobAt(T), EASE.inOut], [340, [270, 168], 'hold'], [L, [270, 168]],
  ], [], [[56, 140], [186, 270]]);
  veil(s);
}

// ---- Look inside -------------------------------------------------------------------------------------
function inside(f) {
  const L = 420;
  const s = scene(f, 'Inside', L);
  const { ab, anim } = s;
  const floor = ab.shape(null);
  ab.rect(floor, { x: 40, y: 22, w: 240, h: 136, r: 2, originX: 0, originY: 0 });
  ab.fill(floor, '#1d2633');
  // Rooms: tinted floors, then walls with door gaps.
  box(ab, null, { x: 40, y: 22, w: 110, h: 72, r: 0, fill: '#243041' });
  box(ab, null, { x: 150, y: 22, w: 130, h: 72, r: 0, fill: '#212c3a' });
  box(ab, null, { x: 40, y: 94, w: 160, h: 64, r: 0, fill: '#26323f' });
  const wall = (pts) => line(ab, null, pts, '#d8dee8', 3);
  wall([[40, 22], [280, 22], [280, 158], [40, 158], [40, 22]]);
  wall([[150, 22], [150, 50]]); wall([[150, 70], [150, 94]]);
  wall([[40, 94], [80, 94]]); wall([[104, 94], [230, 94]]); wall([[254, 94], [280, 94]]);
  wall([[200, 94], [200, 120]]); wall([[200, 140], [200, 158]]);
  // Windows on the outside walls.
  for (const [a, b] of [[[66, 22], [110, 22]], [[190, 22], [250, 22]], [[280, 112], [280, 140]], [[70, 158], [130, 158]]]) line(ab, null, [a, b], '#7fb2e0', 3);
  // Furniture: a table with chairs facing it, a sofa, a bed.
  box(ab, null, { x: 78, y: 116, w: 34, h: 22, r: 3, fill: '#8a6a4a' });
  for (const [x, y] of [[84, 109], [100, 109], [84, 141], [100, 141]]) box(ab, null, { x, y, w: 8, h: 6, r: 1.5, fill: '#5b4632' });
  box(ab, null, { x: 52, y: 32, w: 14, h: 40, r: 3, fill: '#4a5a72' });
  box(ab, null, { x: 226, y: 34, w: 40, h: 30, r: 3, fill: '#5c6b80' });
  box(ab, null, { x: 226, y: 34, w: 40, h: 8, r: 2, fill: '#c9d2de' });

  // The visitor: a dot with a cone of view, walking a path through the doors.
  const stops = [[60, 140], [92, 100], [92, 70], [120, 52], [160, 60], [210, 72], [242, 104], [242, 128], [222, 130]];
  const times = [20, 70, 105, 140, 180, 220, 260, 295, 330];
  const who = ab.node(null, { name: 'visitor', x: stops[0][0], y: stops[0][1] });
  const look = ab.node(who, { name: 'look' });
  const cone = ab.shape(look);
  ab.path(cone, [[0, 0], [34, -16], [38, 0], [34, 16]]);
  ab.fill(cone, COLORS.amber, { alpha: 0.22 });
  const me = ab.shape(who);
  ab.ellipse(me, { w: 11, h: 11 });
  ab.fill(me, COLORS.amber);
  ab.stroke(me, '#ffffff', 1.4);
  const xs = [[0, stops[0][0], 'hold']], ys = [[0, stops[0][1], 'hold']], rot = [];
  let heading = 0;
  stops.forEach(([x, y], i) => {
    xs.push([times[i], x, EASE.inOut]); ys.push([times[i], y, EASE.inOut]);
    const next = stops[i + 1];
    if (next) {
      let a = Math.atan2(next[1] - y, next[0] - x);
      while (a - heading > Math.PI) a -= Math.PI * 2;
      while (a - heading < -Math.PI) a += Math.PI * 2;
      heading = a;
      rot.push([times[i], a, EASE.inOut]);
    }
  });
  xs.push([L, stops.at(-1)[0]]); ys.push([L, stops.at(-1)[1]]);
  rot.unshift([0, rot[0][1], 'hold']);
  rot.push([L, heading]);
  anim.key(who, 'x', xs); anim.key(who, 'y', ys);
  anim.key(look, 'rotation', rot);
  veil(s);
}

// ---- Save and share ----------------------------------------------------------------------------------
function save(f) {
  const L = 330;
  const s = scene(f, 'Save', L);
  const { ab, anim } = s;
  box(ab, null, { x: 60, y: 14, w: 200, h: 152, r: 8, fill: PANEL, stroke: BORDER });
  line(ab, null, [[76, 32], [150, 32]], COLORS.ink, 3.2);
  // Rows: two saved already; the new one slides in at the top with a tick.
  const row = (y, name) => {
    const n = ab.node(null, { name, y });
    box(ab, n, { x: 74, y: 0, w: 172, h: 28, r: 5, fill: PANEL3 });
    box(ab, n, { x: 82, y: 6, w: 16, h: 16, r: 3, fill: '#2e3c50' });
    line(ab, n, [[106, 10], [170, 10]], COLORS.inkSoft, 2.2, { alpha: 0.85 });
    line(ab, n, [[106, 18], [146, 18]], COLORS.inkSoft, 1.6, { alpha: 0.45 });
    return n;
  };
  const old1 = row(48, 'row-1'), old2 = row(82, 'row-2');
  const fresh = row(48, 'row-new');
  fresh.opacity = 0;
  const tick = ab.node(fresh, { name: 'tick', x: 232, y: 14, opacity: 0 });
  const tc = ab.shape(tick);
  ab.ellipse(tc, { w: 13, h: 13 });
  ab.fill(tc, GREEN);
  line(ab, tick, [[-3.2, 0], [-0.8, 2.6], [3.4, -2.4]], '#0a1019', 1.6);
  anim.key(old1, 'y', [[0, 48, 'hold'], [60, 48, EASE.inOut], [84, 82, 'hold'], [L, 82]]);
  anim.key(old2, 'y', [[0, 82, 'hold'], [60, 82, EASE.inOut], [84, 116, 'hold'], [L, 116]]);
  anim.key(fresh, 'opacity', [[0, 0, 'hold'], [70, 0, EASE.out], [92, 1, 'hold'], [L, 1]]);
  anim.key(fresh, 'x', [[0, -18, 'hold'], [70, -18, EASE.out], [96, 0, 'hold'], [L, 0]]);
  anim.key(tick, 'opacity', [[0, 0, 'hold'], [104, 0, EASE.out], [110, 1, 'hold'], [L, 1]]);
  anim.key(tick, 'scaleX', [[0, 0.3, 'hold'], [104, 0.3, EASE.back], [120, 1, 'hold'], [L, 1]]);
  anim.key(tick, 'scaleY', [[0, 0.3, 'hold'], [104, 0.3, EASE.back], [120, 1, 'hold'], [L, 1]]);
  // The share button, then "Link copied".
  const share = box(ab, null, { x: 186, y: 144, w: 60, h: 16, r: 8, fill: PANEL3, stroke: BORDER });
  line(ab, null, [[198, 152], [208, 152]], COLORS.inkSoft, 1.6);
  line(ab, null, [[214, 152], [236, 152]], COLORS.inkSoft, 1.6, { alpha: 0.7 });
  anim.key(share.stroke, 'colorValue', [[0, BORDER, 'hold'], [196, BORDER, EASE.out], [204, COLORS.amber, 'hold'], [L, COLORS.amber]]);
  // "Link copied" drops in from the top, clear of the button.
  const toast = ab.node(null, { name: 'toast', x: 160, y: -16 });
  box(ab, toast, { x: -54, y: -10, w: 108, h: 20, r: 10, fill: '#ffffff' });
  line(ab, toast, [[-40, 0], [30, 0]], '#1b2533', 2.4);
  anim.key(toast, 'y', [[0, -16, 'hold'], [206, -16, EASE.back], [228, 32, 'hold'], [L, 32]]);

  const p = pointer(s, [290, 170]);
  drive(s, p, [[0, [290, 170]], [180, [290, 170], EASE.inOut], [196, [222, 152], 'hold'], [230, [222, 152], EASE.inOut], [280, [286, 170], 'hold'], [L, [286, 170]]], [[200, [222, 152]]]);
  veil(s);
}

export default function build() {
  const f = new RivFile();
  find(f); describe(f); move(f); inside(f); save(f);
  return f;
}
