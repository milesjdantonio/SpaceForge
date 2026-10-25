// handle.riv: the grips for moving and turning a building on the map.
//   Move   — an amber disc with a four-way arrow, shown above the building's roof.
//   Rotate — a smaller disc with two curved arrows, riding the ring round the building.
// Both pulse a ring outward while idle so they're easy to spot over satellite imagery.
//
// State machine "Handle" on each artboard: bool `hover` swells the disc, bool `active` (while being
// dragged) presses it in, brightens it and stops the pulse.

import { RivFile, EASE } from '../riv.mjs';
import { COLORS } from '../helpers.mjs';

const INK = '#1b0e03';

function grip(f, { name, size, disc, glyph }) {
  const ab = f.artboard({ name, width: size, height: size });
  const c = size / 2;

  const pulse = ab.node(null, { name: 'pulse', x: c, y: c });
  const ps = ab.shape(pulse);
  ab.ellipse(ps, { w: disc + 2, h: disc + 2 });
  const pulseStroke = ab.stroke(ps, COLORS.amber, 2);

  const body = ab.node(null, { name: 'body', x: c, y: c });
  const shadow = ab.shape(body, { name: 'shadow', y: 1.5 });
  ab.ellipse(shadow, { w: disc + 2, h: disc + 2 });
  ab.fill(shadow, '#000000', { alpha: 0.35 });
  const face = ab.shape(body, { name: 'face' });
  ab.ellipse(face, { w: disc, h: disc });
  const faceFill = ab.fill(face, COLORS.amber);
  ab.stroke(face, '#ffffff', 1.6, { alpha: 0.85 });
  const mark = ab.node(body, { name: 'glyph' });
  glyph(ab, mark);

  const pulseAnim = ab.animation('pulse', { duration: 96, loop: 1 });
  pulseAnim.key(pulse, 'scaleX', [[0, 1, EASE.out], [72, 1.7, 'hold'], [96, 1.7]]);
  pulseAnim.key(pulse, 'scaleY', [[0, 1, EASE.out], [72, 1.7, 'hold'], [96, 1.7]]);
  pulseAnim.key(pulseStroke, 'colorValue', [[0, `${COLORS.amber}e6`, EASE.out], [72, `${COLORS.amber}00`, 'hold'], [96, `${COLORS.amber}00`]]);
  const still = ab.animation('still', { duration: 10 });
  still.key(pulse, 'scaleX', [[0, 1, 'hold']]);
  still.key(pulse, 'scaleY', [[0, 1, 'hold']]);
  still.key(pulseStroke, 'colorValue', [[0, `${COLORS.amber}00`, 'hold']]);

  const pose = (anim, scale, color, turn) => {
    anim.key(body, 'scaleX', [[0, scale, 'hold']]);
    anim.key(body, 'scaleY', [[0, scale, 'hold']]);
    anim.key(faceFill, 'colorValue', [[0, color, 'hold']]);
    anim.key(mark, 'rotation', [[0, turn, 'hold']]);
    return anim;
  };
  const rest = pose(ab.animation('rest', { duration: 10 }), 1, COLORS.amber, 0);
  const hover = pose(ab.animation('hover', { duration: 10 }), 1.14, '#ff9d4c', name === 'Rotate' ? 0.45 : 0);
  const active = pose(ab.animation('active', { duration: 10 }), 0.92, COLORS.ember, 0);

  const sm = ab.stateMachine('Handle');
  const isHover = sm.bool('hover', false);
  const isActive = sm.bool('active', false);

  const pl = sm.layer('Pulse');
  const sPulse = pl.state(pulseAnim), sStill = pl.state(still);
  pl.transition(pl.entry, sPulse);
  pl.transition(sPulse, sStill, { conditions: [{ input: isActive, value: true }], duration: 120 });
  pl.transition(sStill, sPulse, { conditions: [{ input: isActive, value: false }] });

  const ml = sm.layer('Main');
  const sRest = ml.state(rest), sHover = ml.state(hover), sActive = ml.state(active);
  ml.transition(ml.entry, sRest);
  ml.transition(sRest, sHover, { conditions: [{ input: isHover, value: true }], duration: 140 });
  ml.transition(sHover, sRest, { conditions: [{ input: isHover, value: false }], duration: 160 });
  ml.transition(sRest, sActive, { conditions: [{ input: isActive, value: true }], duration: 90 });
  ml.transition(sHover, sActive, { conditions: [{ input: isActive, value: true }], duration: 90 });
  ml.transition(sActive, sRest, { conditions: [{ input: isActive, value: false }, { input: isHover, value: false }], duration: 160 });
  ml.transition(sActive, sHover, { conditions: [{ input: isActive, value: false }, { input: isHover, value: true }], duration: 160 });
  return ab;
}

// A four-way arrow: a cross with a small head on each arm.
function moveGlyph(ab, parent) {
  const arms = ab.shape(parent, { name: 'arms' });
  ab.path(arms, [[-10, 0], [10, 0]], { closed: false });
  ab.stroke(arms, INK, 2.6, { cap: 1 });
  const arms2 = ab.shape(parent, { name: 'arms2' });
  ab.path(arms2, [[0, -10], [0, 10]], { closed: false });
  ab.stroke(arms2, INK, 2.6, { cap: 1 });
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const head = ab.shape(parent);
    const tip = [dx * 13, dy * 13], back = 5, half = 4.2;
    ab.path(head, [tip, [dx * (13 - back) - dy * half, dy * (13 - back) - dx * half], [dx * (13 - back) + dy * half, dy * (13 - back) + dx * half]]);
    ab.fill(head, INK);
  }
}

// Two curved arrows chasing each other round the centre.
function rotateGlyph(ab, parent) {
  const r = 7.5;
  for (const start of [200, 20]) {
    const arc = ab.shape(parent);
    const pts = [];
    for (let a = start; a <= start + 115; a += 11.5) pts.push([Math.cos(a * Math.PI / 180) * r, Math.sin(a * Math.PI / 180) * r]);
    ab.path(arc, pts, { closed: false });
    ab.stroke(arc, INK, 2.3, { cap: 1 });
    // The head points along the arc, clockwise, at its end.
    const end = (start + 115) * Math.PI / 180;
    const tip = [Math.cos(end + 0.32) * r, Math.sin(end + 0.32) * r];
    const outer = [Math.cos(end) * (r + 3.6), Math.sin(end) * (r + 3.6)];
    const inner = [Math.cos(end) * (r - 3.6), Math.sin(end) * (r - 3.6)];
    const head = ab.shape(parent);
    ab.path(head, [tip, outer, inner]);
    ab.fill(head, INK);
  }
}

export default function build() {
  const f = new RivFile();
  grip(f, { name: 'Move', size: 72, disc: 40, glyph: moveGlyph });
  grip(f, { name: 'Rotate', size: 56, disc: 30, glyph: rotateGlyph });
  return f;
}
