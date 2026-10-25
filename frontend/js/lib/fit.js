// Does the brief suit the land? A rough footprint from the brief's numbers, compared with the land's
// buildable area, so the user knows before sending. It only warns; Gemma has the final say.

import { BRIEF_RULES } from './housing.js';

// Gross floor area per bed in a dorm, including its share of corridors and common rooms.
const DORM_M2_PER_BED = { single: 20, double: 14, suite: 22 };
const SHARED_EXTRA = 1.25;   // corridors, stairs, lobby in apartment and condo buildings
const GARAGE_M2_PER_CAR = 18;
const PARKING_M2_PER_SPACE = 25; // a surface space with its share of the aisle
const TIGHT = 0.85;          // above this share of the buildable area, little is left over
const SMALL_SHARE = 0.02;    // under this share of a big piece of land, the building is a speck
const BIG_LAND_M2 = 2000;

// Total finished floor area the brief asks for, in m², or null until the boxes it needs are filled.
export function briefFloorArea(type, a) {
  const per = a.areaM2;
  switch (type) {
    case 'house': case 'tiny-home': return per ?? null;
    case 'duplex': return per == null ? null : per * 2;
    case 'townhouse': return per == null || !a.unitCount ? null : per * a.unitCount;
    case 'apartment': case 'condo': return per == null || !a.unitCount ? null : per * a.unitCount * SHARED_EXTRA;
    case 'dorm': return !a.residents ? null : a.residents * (DORM_M2_PER_BED[a.roomType] ?? DORM_M2_PER_BED.double);
    default: return null;
  }
}

// Ground the brief takes up beside the building itself: garages and surface parking.
function groundExtras(type, a, adv) {
  let m2 = 0;
  if (adv?.garage) m2 += adv.garage * GARAGE_M2_PER_CAR * (type === 'townhouse' ? a.unitCount || 1 : type === 'duplex' ? 2 : 1);
  if (adv?.parkingSpaces) m2 += adv.parkingSpaces * PARKING_M2_PER_SPACE;
  return m2;
}

// { level: 'ok' | 'tight' | 'over' | 'small' | 'ai' | 'none', footprintM2, buildableM2, share, floorsNeeded }
// or null while there isn't enough to say anything.
export function landFit(type, answers, advanced, m) {
  if (!type || !m) return null;
  const buildableM2 = m.buildableM2 ?? 0;
  if (buildableM2 <= 0) return { level: 'none', buildableM2: 0 };
  if (answers.areaByAI && type !== 'dorm') return { level: 'ai', buildableM2 };
  const total = briefFloorArea(type, answers);
  const floors = answers.floors;
  if (total == null || !floors || floors < 1) return null;
  const extras = groundExtras(type, answers, advanced);
  const footprintM2 = total / floors + extras;
  const share = footprintM2 / buildableM2;
  const base = { footprintM2, buildableM2, share, floors, single: type === 'house' || type === 'tiny-home' };
  if (share > 1) {
    // Floors that would make it fit, if the type allows that many.
    const room = buildableM2 - extras;
    const need = room > 0 ? Math.ceil(total / room) : Infinity;
    const max = BRIEF_RULES[type]?.floors?.[1] ?? floors;
    return { ...base, level: 'over', floorsNeeded: need > floors && need <= max ? need : null };
  }
  if (share > TIGHT) return { ...base, level: 'tight' };
  if (m.areaM2 >= BIG_LAND_M2 && footprintM2 / m.areaM2 < SMALL_SHARE) return { ...base, level: 'small', landShare: footprintM2 / m.areaM2 };
  return { ...base, level: 'ok' };
}

// The words for a fit result, in the user's units.
export function fitMessage(fit, fmt) {
  if (!fit) return null;
  // Rounded down below 100, so a building that fits never reads as filling the land.
  const pct = (x) => `${Math.max(1, x < 1 ? Math.min(99, Math.floor(x * 100)) : Math.round(x * 100))}%`;
  const about = fit.footprintM2 != null ? `About ${fmt.area(fit.footprintM2)} of ground on ${fit.floors} floor${fit.floors === 1 ? '' : 's'}` : '';
  switch (fit.level) {
    case 'none': return { title: 'No room to build', text: `Keeping ${fmt.len(3)} back from every edge leaves no buildable space. Outline a bigger or wider piece of land.` };
    case 'ai': return { title: 'Gemma sizes it to fit', text: `The building will be sized for the ${fmt.land(fit.buildableM2)} of buildable land.` };
    case 'over': {
      const smaller = fit.single ? 'a smaller size' : 'smaller or fewer homes';
      return {
        title: 'Too big for this land',
        text: `${about}, but only ${fmt.land(fit.buildableM2)} is buildable. ${fit.floorsNeeded
          ? `Try ${fit.floorsNeeded} floors, ${smaller}, or more land.`
          : `Try ${smaller}, or outline more land.`} You can still send it, but the design may not fit inside the land.`,
      };
    }
    case 'tight': return { title: 'A tight fit', text: `${about}: ${pct(fit.share)} of the buildable land, leaving little room for a yard, paths or parking.` };
    case 'small': return { title: 'Small for this much land', text: `${about}: ${pct(fit.landShare)} of the land. That’s fine, it will stand in one spot. To design for just that spot, outline a smaller piece.` };
    default: return { title: 'Fits the land', text: `${about}: ${pct(fit.share)} of the ${fmt.land(fit.buildableM2)} buildable.` };
  }
}
