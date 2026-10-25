// mark.riv: the TerraSim mark. An amber disc; a white roofline over a horizon line.
// State machine "Mark": bool `hover` lifts the roof and swells the horizon.

import { RivFile, EASE } from '../riv.mjs';

export default function build() {
  const f = new RivFile();
  const ab = f.artboard({ name: 'Mark', width: 64, height: 64 });
  const disc = ab.shape(null, { name: 'disc', x: 32, y: 32 });
  ab.ellipse(disc, { w: 64, h: 64 });
  ab.fill(disc, '#ff8a2a');

  const horizon = ab.shape(null, { name: 'horizon', x: 0, y: 0 });
  const wave = [];
  for (let i = 0; i <= 12; i++) {
    const x = 9 + (i / 12) * 46;
    wave.push([x, 44 + Math.sin(i * 0.9) * 1.6]);
  }
  ab.path(horizon, wave, { closed: false });
  ab.stroke(horizon, '#1b0e03', 3.4, { cap: 1 });

  const roof = ab.node(null, { name: 'roof', x: 32, y: 0 });
  const r = ab.shape(roof, { name: 'roofline' });
  ab.path(r, [[-13, 37], [0, 24], [13, 37]], { closed: false });
  const rs = ab.stroke(r, '#ffffff', 3.6, { cap: 1, join: 1 });
  const walls = ab.shape(roof, { name: 'walls' });
  ab.path(walls, [[-9, 34], [-9, 41], [9, 41], [9, 34]], { closed: false });
  ab.stroke(walls, '#ffffff', 3.2, { cap: 1, join: 1 });

  const intro = ab.animation('intro', { duration: 50 });
  const trim = ab.trim(rs, { end: 0 });
  intro.key(trim, 'end', [[0, 0, EASE.inOut], [40, 1]]);
  intro.key(roof, 'y', [[0, 0, 'hold']]);
  const idle = ab.animation('idle', { duration: 20 });
  idle.key(roof, 'y', [[0, 0, EASE.out], [20, 0]]);
  idle.key(trim, 'end', [[0, 1, 'hold']]);
  const up = ab.animation('hover', { duration: 24 });
  up.key(roof, 'y', [[0, 0, EASE.back], [24, -4]]);
  up.key(trim, 'end', [[0, 1, 'hold']]);

  const sm = ab.stateMachine('Mark');
  const hover = sm.bool('hover', false);
  const layer = sm.layer('Main');
  const sIntro = layer.state(intro), sIdle = layer.state(idle), sUp = layer.state(up);
  layer.transition(layer.entry, sIntro);
  layer.transition(sIntro, sIdle, { exitTime: 100, percent: true });
  layer.transition(sIdle, sUp, { conditions: [{ input: hover, value: true }] });
  layer.transition(sUp, sIdle, { conditions: [{ input: hover, value: false }] });
  return f;
}
