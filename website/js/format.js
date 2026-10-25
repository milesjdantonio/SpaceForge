// Number formatting in the user's units. Everything is stored in metres and square metres.

import { settings } from './store.js';

const FT = 3.28084;
const SQFT = 10.7639;
const ACRE_M2 = 4046.8564;

const n = (v, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export const fmt = {
  len(m, { precise = false } = {}) {
    if (m == null || Number.isNaN(m)) return '–';
    if (settings.units === 'metric') return `${n(m, precise || m < 10 ? 1 : 0)} m`;
    const ft = m * FT;
    if (precise && ft < 100) {
      const whole = Math.floor(ft);
      const inch = Math.round((ft - whole) * 12);
      return inch === 12 ? `${whole + 1}′` : `${whole}′ ${inch}″`;
    }
    return `${n(ft, 0)} ft`;
  },
  area(m2) {
    if (m2 == null || Number.isNaN(m2)) return '–';
    return settings.units === 'metric' ? `${n(m2, m2 < 100 ? 1 : 0)} m²` : `${n(m2 * SQFT, 0)} sq ft`;
  },
  land(m2) {
    if (m2 == null) return '–';
    if (settings.units === 'metric') return m2 >= 10000 ? `${n(m2 / 10000, 2)} ha` : `${n(m2, 0)} m²`;
    return m2 >= ACRE_M2 / 4 ? `${n(m2 / ACRE_M2, 2)} acres` : `${n(m2 * SQFT, 0)} sq ft`;
  },
  money(v, { short = false } = {}) {
    if (v == null || Number.isNaN(v)) return '–';
    if (short && Math.abs(v) >= 1e6) return `$${n(v / 1e6, 2)}M`;
    if (short && Math.abs(v) >= 1e3) return `$${n(v / 1e3, 0)}k`;
    return `$${n(v, 0)}`;
  },
  perArea(dollarsPerM2) {
    return settings.units === 'metric' ? `$${n(dollarsPerM2, 0)}/m²` : `$${n(dollarsPerM2 / SQFT, 0)}/sq ft`;
  },
  bearing(deg) {
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return `${names[Math.round(((deg % 360) + 360) % 360 / 45) % 8]} ${Math.round(deg)}°`;
  },
  int: (v) => n(v, 0),
  unitLen: () => (settings.units === 'metric' ? 'm' : 'ft'),
  toDisplayLen: (m) => (settings.units === 'metric' ? m : m * FT),
  fromDisplayLen: (v) => (settings.units === 'metric' ? v : v / FT),
  toDisplayArea: (m2) => (settings.units === 'metric' ? m2 : m2 * SQFT),
  fromDisplayArea: (v) => (settings.units === 'metric' ? v : v / SQFT),
  unitArea: () => (settings.units === 'metric' ? 'm²' : 'sq ft'),
};
