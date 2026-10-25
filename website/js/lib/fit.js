// Does the brief suit the land? A rough footprint from the brief's numbers, compared with the land's
// buildable area, so the user knows before sending. It only warns; Gemma has the final say.

import { BRIEF_RULES, isSingleHome, isSiteType } from './housing.js';

// Gross floor area per bed in a dorm, including its share of corridors and common rooms.
const DORM_M2_PER_BED = { single: 20, double: 14, suite: 22 };
// Gross floor area per hotel room (with its share of corridors and stairs), plus the ground floor's
// lobby, restaurant and back of house.
const HOTEL_M2_PER_ROOM = { single: 42, double: 46, suite: 76 };
const HOTEL_GROUND_M2 = 260;
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
    case 'house': case 'tiny-home': case 'mansion': case 'villa': return per ?? null;
    case 'duplex': return per == null ? null : per * 2;
    case 'townhouse': return per == null || !a.unitCount ? null : per * a.unitCount;
    case 'apartment': case 'condo': return per == null || !a.unitCount ? null : per * a.unitCount * SHARED_EXTRA;
    case 'dorm': return !a.residents ? null : a.residents * (DORM_M2_PER_BED[a.roomType] ?? DORM_M2_PER_BED.double);
    case 'hotel': return !a.unitCount ? null : a.unitCount * (HOTEL_M2_PER_ROOM[a.roomType] ?? HOTEL_M2_PER_ROOM.single) + HOTEL_GROUND_M2;
    // Sites: the land each home takes, its lot and its share of the streets.
    case 'neighborhood': {
      if (!a.unitCount || per == null || !a.floors) return null;
      const fp = per / a.floors * 1.15 + 35;
      return a.unitCount * (Math.sqrt(fp * 1.4) + 7) * (fp / Math.sqrt(fp * 1.4) + 16) * 1.3;
    }
    case 'trailer-park': return !a.unitCount ? null : a.unitCount * (a.roomType === 'double' ? 520 : 400);
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
  if (answers.areaByAI && type !== 'dorm' && type !== 'hotel') return { level: 'ai', buildableM2 };
  const total = briefFloorArea(type, answers);
  const floors = isSiteType(type) ? 1 : answers.floors; // a site's figure is land, not floor area
  if (total == null || !floors || floors < 1) return null;
  const extras = groundExtras(type, answers, advanced);
  const footprintM2 = total / floors + extras;
  const share = footprintM2 / buildableM2;
  const base = { footprintM2, buildableM2, share, floors, single: isSingleHome(type) };
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

// The design service's own answer (POST /api/fit, design-service/fitcheck.go), in the same shape as
// landFit's. It sizes a first version of the building and places it with the code that places the
// real one, so it knows the building's shape, not just its area.
export function serviceFit(res, type, m) {
  if (!res?.level) return null;
  const fit = {
    level: res.level,
    source: 'service',
    footprintM2: res.footprintM2 ?? null,
    buildableM2: res.buildableM2 ?? m?.buildableM2 ?? 0,
    share: res.share ?? null,
    floors: res.floors,
    widthM: res.widthM ?? null,
    depthM: res.depthM ?? null,
    floorsNeeded: res.floorsNeeded || null,
    maxAreaM2: res.maxAreaM2 || null,
    dropped: res.dropped ?? [],
    single: isSingleHome(type),
  };
  if (fit.level === 'ok' && m?.areaM2 >= BIG_LAND_M2 && fit.footprintM2 / m.areaM2 < SMALL_SHARE) {
    return { ...fit, level: 'small', landShare: fit.footprintM2 / m.areaM2 };
  }
  return fit;
}

// The words for a fit result, in the user's units.
export function fitMessage(fit, fmt) {
  if (!fit) return null;
  // Rounded down below 100, so a building that fits never reads as filling the land.
  const pct = (x) => `${Math.max(1, x < 1 ? Math.min(99, Math.floor(x * 100)) : Math.round(x * 100))}%`;
  const floorsWord = `${fit.floors} floor${fit.floors === 1 ? '' : 's'}`;
  const about = fit.source === 'service' && fit.widthM
    ? `A ${fmt.len(fit.widthM)} × ${fmt.len(fit.depthM)} building on ${floorsWord}`
    : fit.footprintM2 != null ? `About ${fmt.area(fit.footprintM2)} of ground on ${floorsWord}` : '';
  const list = (xs) => xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0];
  switch (fit.level) {
    case 'none': return { title: 'No Room to Build', text: `Keeping ${fmt.len(3)} back from every edge leaves no buildable space. Outline a bigger or wider piece of land.` };
    case 'ai': return { title: 'Gemma Sizes It to Fit', text: `The building will be sized for the ${fmt.land(fit.buildableM2)} of buildable land.` };
    case 'over': {
      const smaller = fit.single ? 'a smaller size' : 'smaller or fewer homes';
      if (fit.source === 'service') {
        const tries = [
          fit.floorsNeeded && `${fit.floorsNeeded} floors`,
          fit.maxAreaM2 && `${fit.single ? 'a size' : 'homes'} up to ${fmt.area(fit.maxAreaM2)}`,
        ].filter(Boolean);
        return {
          title: 'Too Big for This Land',
          text: `There’s no spot on the land where this building stands ${fmt.len(3)} back from every edge. ${tries.length
            ? `It would fit with ${tries.join(', or ')}.`
            : `Try ${smaller}, or outline more land.`} You can still send it; Gemma will try to make it fit.`,
        };
      }
      return {
        title: 'Too Big for This Land',
        text: `${about}, but only ${fmt.land(fit.buildableM2)} is buildable. ${fit.floorsNeeded
          ? `Try ${fit.floorsNeeded} floors, ${smaller}, or more land.`
          : `Try ${smaller}, or outline more land.`} You can still send it, but the design may not fit inside the land.`,
      };
    }
    case 'tight':
      if (fit.dropped?.length) return { title: 'Fits, with less', text: `${about} fits once the ${list(fit.dropped)} ${fit.dropped.length === 1 && !/s$/.test(fit.dropped[0]) ? 'is' : 'are'} left out. Gemma will leave ${fit.dropped.length === 1 ? 'it' : 'them'} out if needed.` };
      return { title: 'A tight fit', text: `${about}: ${pct(fit.share)} of the buildable land, leaving little room for a yard, paths or parking.` };
    case 'small': return { title: 'Small for This Much Land', text: `${about}: ${pct(fit.landShare)} of the land. That’s fine, it will stand in one spot. To design for just that spot, outline a smaller piece.` };
    default: return { title: 'Fits the Land', text: `${about}: ${pct(fit.share)} of the ${fmt.land(fit.buildableM2)} buildable.` };
  }
}
