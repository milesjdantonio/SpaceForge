// pin.riv: a corner pin that drops onto the ground as the drawing hint slides out, with a ripple
// where it lands, then rests with a slow pulse. Used at the top of the drawing hint.
//
// State machine "Pin", trigger `drop` replays the drop.

import { RivFile, EASE } from '../riv.mjs';
import { COLORS } from '../helpers.mjs';

export default function build() {
  const f = new RivFile();
  const ab = f.artboard({ name: 'Pin', width: 56, height: 56 });
  const GROUND = 44;

  // Shadow and landing ripple on the ground.
  const shadow = ab.shape(null, { name: 'shadow', x: 28, y: GROUND });
  ab.ellipse(shadow, { w: 16, h: 5 });
  const shadowFill = ab.fill(shadow, '#000000', { alpha: 0.35 });
  const ripple = ab.node(null, { name: 'ripple', x: 28, y: GROUND });
  const rs = ab.shape(ripple);
  ab.ellipse(rs, { w: 18, h: 6 });
  const rippleStroke = ab.stroke(rs, COLORS.amber, 1.6);

  // The pin: a teardrop head with a white dot, pointing at the ground.
  const pin = ab.node(null, { name: 'pin', x: 28, y: GROUND });
  const head = ab.shape(pin, { name: 'head' });
  ab.path(head, [[0, 0], [-7, -12, 2], [-8, -20, 7], [0, -28, 7], [8, -20, 7], [7, -12, 2]]);
  ab.fill(head, COLORS.amber);
  ab.stroke(head, '#1b0e03', 1.2, { alpha: 0.6 });
  const dot = ab.shape(pin, { name: 'dot', y: -19 });
  ab.ellipse(dot, { w: 6.5, h: 6.5 });
  ab.fill(dot, '#ffffff');

  const drop = ab.animation('drop', { duration: 54 });
  drop.key(pin, 'y', [[0, GROUND - 40, EASE.in], [16, GROUND, EASE.out], [24, GROUND - 5, EASE.in], [32, GROUND, EASE.out], [54, GROUND]]);
  drop.key(pin, 'scaleY', [[0, 1.1, 'hold'], [15, 1.1, EASE.out], [17, 0.82, EASE.out], [26, 1.04, EASE.inOut], [36, 1]]);
  drop.key(pin, 'scaleX', [[0, 0.92, 'hold'], [15, 0.92, EASE.out], [17, 1.14, EASE.out], [26, 0.98, EASE.inOut], [36, 1]]);
  drop.key(shadow, 'scaleX', [[0, 0.3, EASE.in], [16, 1.1, EASE.out], [24, 0.85], [32, 1]]);
  drop.key(shadowFill, 'colorValue', [[0, '#00000022', EASE.in], [16, '#00000066'], [54, '#00000059']]);
  drop.key(ripple, 'scaleX', [[0, 0.4, 'hold'], [16, 0.4, EASE.out], [44, 2.6]]);
  drop.key(ripple, 'scaleY', [[0, 0.4, 'hold'], [16, 0.4, EASE.out], [44, 2.6]]);
  drop.key(rippleStroke, 'colorValue', [[0, `${COLORS.amber}00`, 'hold'], [16, `${COLORS.amber}ff`, EASE.out], [44, `${COLORS.amber}00`]]);

  const rest = ab.animation('rest', { duration: 120, loop: 1 });
  rest.key(pin, 'y', [[0, GROUND, EASE.inOut], [60, GROUND - 2.5, EASE.inOut], [120, GROUND]]);
  rest.key(pin, 'scaleX', [[0, 1, 'hold']]);
  rest.key(pin, 'scaleY', [[0, 1, 'hold']]);
  rest.key(shadow, 'scaleX', [[0, 1, EASE.inOut], [60, 0.86, EASE.inOut], [120, 1]]);
  rest.key(shadowFill, 'colorValue', [[0, '#00000059', 'hold']]);
  rest.key(ripple, 'scaleX', [[0, 0.4, 'hold']]);
  rest.key(ripple, 'scaleY', [[0, 0.4, 'hold']]);
  rest.key(rippleStroke, 'colorValue', [[0, `${COLORS.amber}00`, 'hold']]);

  const sm = ab.stateMachine('Pin');
  const replay = sm.trigger('drop');
  const layer = sm.layer('Main');
  const sDrop = layer.state(drop), sRest = layer.state(rest);
  layer.transition(layer.entry, sDrop);
  layer.transition(sDrop, sRest, { exitTime: 100, percent: true });
  layer.transition(sRest, sDrop, { conditions: [{ input: replay }] });
  return f;
}
