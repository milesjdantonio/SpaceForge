// tap.riv: a pointer that hovers over something you can click, drifting a little, then presses it
// with a ripple, again and again. Used on the intro's "Click your marker" option.
//
// One looping animation, "hover" (autoplays).

import { RivFile, EASE } from '../riv.mjs';
import { COLORS } from '../helpers.mjs';

export default function build() {
  const f = new RivFile();
  const W = 72, H = 72;
  const ab = f.artboard({ name: 'Tap', width: W, height: H });
  const L = 150;
  const anim = ab.animation('hover', { duration: L, loop: 1 });
  // The press lands here; the pointer's tip is its origin.
  const T = [26, 26];

  const ripple = ab.node(null, { name: 'ripple', x: T[0], y: T[1], opacity: 0 });
  const rs = ab.shape(ripple);
  ab.ellipse(rs, { w: 30, h: 30 });
  ab.stroke(rs, COLORS.ember, 2.2);
  const glow = ab.node(null, { name: 'glow', x: T[0], y: T[1], opacity: 0 });
  const gs = ab.shape(glow);
  ab.ellipse(gs, { w: 16, h: 16 });
  ab.fill(gs, COLORS.amber, { alpha: 0.45 });

  const cursor = ab.node(null, { name: 'cursor', x: T[0] + 10, y: T[1] + 12 });
  const shadow = ab.shape(cursor, { x: 1.5, y: 2 });
  ab.path(shadow, [[0, 0], [0, 20], [5.3, 15.3], [9.4, 24.1], [12.9, 22.4], [8.9, 13.9], [15.3, 13.6]]);
  ab.fill(shadow, '#000000', { alpha: 0.35 });
  const arrow = ab.shape(cursor);
  ab.path(arrow, [[0, 0], [0, 20], [5.3, 15.3], [9.4, 24.1], [12.9, 22.4], [8.9, 13.9], [15.3, 13.6]]);
  ab.fill(arrow, '#ffffff');
  ab.stroke(arrow, '#111418', 1.3);

  // Drift in from the lower right, hover, press, lift, drift back a little.
  anim.key(cursor, 'x', [[0, T[0] + 10, EASE.inOut], [40, T[0] + 1, EASE.inOut], [62, T[0], 'hold'], [96, T[0], EASE.inOut], [L, T[0] + 10]]);
  anim.key(cursor, 'y', [[0, T[1] + 12, EASE.inOut], [40, T[1] + 2, EASE.inOut], [62, T[1], 'hold'], [96, T[1], EASE.inOut], [L, T[1] + 12]]);
  anim.key(cursor, 'scaleX', [[0, 1, 'hold'], [62, 1, EASE.out], [68, 0.84, EASE.out], [80, 1, 'hold'], [L, 1]]);
  anim.key(cursor, 'scaleY', [[0, 1, 'hold'], [62, 1, EASE.out], [68, 0.84, EASE.out], [80, 1, 'hold'], [L, 1]]);
  anim.key(ripple, 'opacity', [[0, 0, 'hold'], [66, 0, EASE.out], [68, 1, EASE.out], [100, 0, 'hold'], [L, 0]]);
  anim.key(ripple, 'scaleX', [[0, 0.3, 'hold'], [66, 0.3, EASE.out], [100, 1.5, 'hold'], [L, 1.5]]);
  anim.key(ripple, 'scaleY', [[0, 0.3, 'hold'], [66, 0.3, EASE.out], [100, 1.5, 'hold'], [L, 1.5]]);
  anim.key(glow, 'opacity', [[0, 0, 'hold'], [64, 0, EASE.out], [68, 1, EASE.out], [92, 0, 'hold'], [L, 0]]);
  return f;
}
