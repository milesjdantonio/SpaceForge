// Housing types and the questions each one asks. This mirrors contracts/FIELDS.md (Part 1): the
// main form asks the `brief` fields marked required for the chosen type; everything in `advanced`
// is optional, and a blank answer means the design system decides.

export const HOUSING_TYPES = [
  { id: 'house', name: 'House', blurb: 'One home on its own lot' },
  { id: 'tiny-home', name: 'Tiny home', blurb: 'A small home, often with a loft' },
  { id: 'townhouse', name: 'Townhouses', blurb: 'A row of homes side by side' },
  { id: 'duplex', name: 'Duplex', blurb: 'Two homes in one building' },
  { id: 'apartment', name: 'Apartments', blurb: 'A building of rented homes' },
  { id: 'condo', name: 'Condos', blurb: 'A building of owned homes' },
  { id: 'dorm', name: 'Dorm', blurb: 'Student rooms and shared spaces' },
];

export const typeName = (id) => HOUSING_TYPES.find((t) => t.id === id)?.name ?? 'Building';

const MULTI = new Set(['townhouse', 'duplex', 'apartment', 'condo']);
const SHARED_BUILDING = new Set(['apartment', 'condo', 'dorm']);
export const isMultiHome = (type) => MULTI.has(type);
export const isSharedBuilding = (type) => SHARED_BUILDING.has(type);

// Required questions per type. `fixed` means the type decides it (sent, not asked).
// Areas are square metres. Ranges are inclusive.
export const BRIEF_RULES = {
  house: { floors: [1, 3], areaM2: [50, 900], unitCount: { fixed: 1 }, bedrooms: [1, 8], bathrooms: [1, 7] },
  'tiny-home': { floors: [1, 2], areaM2: [12, 45], unitCount: { fixed: 1 }, bedrooms: [1, 2], bathrooms: [1, 1.5] },
  townhouse: { floors: [2, 4], areaM2: [60, 350], unitCount: [2, 12], bedrooms: [1, 5], bathrooms: [1, 4.5] },
  duplex: { floors: [1, 3], areaM2: [50, 300], unitCount: { fixed: 2 }, bedrooms: [1, 5], bathrooms: [1, 4] },
  apartment: { floors: [2, 12], areaM2: [30, 200], unitCount: [4, 200], bedrooms: [0, 4], bathrooms: [1, 3] },
  condo: { floors: [2, 12], areaM2: [35, 250], unitCount: [4, 200], bedrooms: [0, 4], bathrooms: [1, 3.5] },
  dorm: { floors: [2, 12], residents: [8, 800], roomType: { options: ['single', 'double', 'suite'] } },
};

export const ROOM_TYPES = [['single', 'Single rooms'], ['double', 'Double rooms'], ['suite', 'Suites']];

// What each brief field is called, and how it reads for a given type.
export function fieldLabel(field, type) {
  const per = isMultiHome(type);
  const avg = type === 'apartment' || type === 'condo';
  switch (field) {
    case 'floors': return 'Floors';
    case 'areaM2': return avg ? 'Average home size' : per ? 'Size of each home' : 'Living space';
    case 'unitCount': return type === 'townhouse' ? 'Townhomes in the row' : 'Homes in the building';
    case 'bedrooms': return avg ? 'Bedrooms in a typical home' : per ? 'Bedrooms per home' : 'Bedrooms';
    case 'bathrooms': return avg ? 'Bathrooms in a typical home' : per ? 'Bathrooms per home' : 'Bathrooms';
    case 'residents': return 'Beds in the building';
    case 'roomType': return 'Room type';
    case 'budgetUSD': return type === 'house' || type === 'tiny-home' ? 'Budget for the build' : 'Budget for the whole building';
    default: return field;
  }
}

export function fieldHint(field, type) {
  switch (field) {
    case 'floors': return 'Storeys above ground.';
    case 'areaM2': return 'Finished space, not counting garages or parking.';
    case 'bathrooms': return 'A half bath (toilet and sink) counts as 0.5.';
    case 'bedrooms': return type === 'apartment' || type === 'condo' ? '0 means studios. Set an exact mix under Advanced.' : '';
    case 'residents': return 'Total beds across every room.';
    default: return '';
  }
}

// The required fields the main form shows for a type, in order. Budget is always last.
export function requiredFields(type) {
  const rules = BRIEF_RULES[type];
  if (!rules) return [];
  const order = ['floors', 'areaM2', 'unitCount', 'bedrooms', 'bathrooms', 'residents', 'roomType'];
  return [...order.filter((f) => rules[f] && !rules[f].fixed), 'budgetUSD'];
}

export const BRIEF_FIELDS = ['designPrompt', 'floors', 'areaM2', 'unitCount', 'bedrooms', 'bathrooms', 'residents', 'roomType', 'budgetUSD'];

// The design prompt: the user's own description of the building and its style. It is the base of
// what Gemma is asked for; the boxes below it add the numbers.
export const PROMPT_MIN = 15;
export const PROMPT_MAX = 1000;
export function promptProblem(text) {
  const t = String(text ?? '').trim();
  if (!t) return 'Describe the building and its style in a sentence or two.';
  if (t.length < PROMPT_MIN) return 'Add a little more: a style, a feeling, or rooms you need.';
  if (t.length > PROMPT_MAX) return `Keep it under ${PROMPT_MAX} characters.`;
  return '';
}

// Builds the brief sent to Gemma: every field present, null where it doesn't apply.
export function briefFor(type, answers) {
  const rules = BRIEF_RULES[type] || {};
  const out = {};
  for (const f of BRIEF_FIELDS) {
    if (f === 'designPrompt') { out[f] = String(answers.designPrompt ?? '').trim() || null; continue; }
    if (f === 'budgetUSD') { out[f] = answers.noBudgetLimit ? null : answers.budgetUSD ?? null; continue; }
    const r = rules[f];
    if (!r) out[f] = null;
    else if (r.fixed != null) out[f] = r.fixed;
    else out[f] = answers[f] ?? null;
  }
  return out;
}

const EMPTY = {
  floors: () => 'Add how many floors.',
  areaM2: (t) => (t === 'apartment' || t === 'condo' ? 'Add the average size of a home.' : isMultiHome(t) ? 'Add the size of each home.' : 'Add the living space.'),
  unitCount: (t) => (t === 'townhouse' ? 'Add how many townhomes.' : 'Add how many homes.'),
  bedrooms: () => 'Add how many bedrooms.',
  bathrooms: () => 'Add how many bathrooms.',
  residents: () => 'Add how many beds.',
};

// One problem per required box that is empty or out of range, keyed by field.
export function briefProblems(type, answers, fmtArea) {
  const problems = {};
  const prompt = promptProblem(answers.designPrompt);
  if (prompt) problems.designPrompt = prompt;
  if (!type) return { housingType: 'Choose what you’re building.', ...problems };
  const rules = BRIEF_RULES[type];
  for (const f of requiredFields(type)) {
    const v = answers[f];
    if (f === 'budgetUSD') {
      if (answers.noBudgetLimit) continue;
      if (v == null || v === '') problems[f] = 'Add a budget, or tick “No limit”.';
      else if (v < 10000) problems[f] = 'That budget is too small to build with. Check the number.';
      continue;
    }
    if (f === 'roomType') {
      if (!v) problems[f] = 'Choose single rooms, double rooms or suites.';
      continue;
    }
    const [lo, hi] = rules[f];
    if (v == null || v === '' || Number.isNaN(v)) { problems[f] = EMPTY[f](type); continue; }
    if (v < lo || v > hi) {
      const show = f === 'areaM2' && fmtArea ? [fmtArea(lo), fmtArea(hi)] : [lo, hi];
      problems[f] = `For ${typeName(type).toLowerCase()}, between ${show[0]} and ${show[1]}.`;
    } else if (f === 'bathrooms' && Math.round(v * 2) !== v * 2) problems[f] = 'Use whole or half bathrooms, like 2 or 2.5.';
    else if (f !== 'bathrooms' && f !== 'areaM2' && !Number.isInteger(v)) problems[f] = 'Use a whole number.';
  }
  return problems;
}

// ---- Advanced -----------------------------------------------------------------------------------

// Style ideas the prompt box offers as one-click additions to the user's text.
export const STYLE_IDEAS = [
  ['Modern', 'modern, with a flat roof and long glass walls'],
  ['Farmhouse', 'farmhouse, with steep gables and a deep porch'],
  ['Craftsman', 'craftsman, with low gables and deep eaves'],
  ['Cabin', 'a cabin, with a steep roof and timber walls'],
  ['Mediterranean', 'Mediterranean, with stucco and a low tile roof'],
  ['Prairie', 'prairie style, long and low with wide eaves'],
  ['Contemporary', 'contemporary, mixing materials and forms'],
  ['Brick', 'traditional brick with a symmetrical front'],
];
export const QUALITY = [['essential', 'Essential'], ['standard', 'Standard'], ['premium', 'Premium']];
export const STRUCTURE = [['wood-frame', 'Wood frame'], ['steel-frame', 'Steel frame'], ['concrete', 'Concrete'], ['mass-timber', 'Mass timber'], ['masonry', 'Masonry']];
export const CLADDING = [['board-batten', 'Board and batten'], ['lap-siding', 'Lap siding'], ['brick', 'Brick'], ['stucco', 'Stucco'], ['stone', 'Stone'], ['fiber-cement', 'Fiber cement'], ['metal-panel', 'Metal panel'], ['timber', 'Timber']];
export const ROOFING = [['asphalt-shingle', 'Asphalt shingle'], ['metal', 'Standing-seam metal'], ['tile', 'Tile'], ['slate', 'Slate'], ['membrane', 'Flat membrane']];
export const PRIORITIES = [['efficiency', 'Energy efficiency'], ['maintenance', 'Low maintenance'], ['light', 'Daylight'], ['privacy', 'Privacy'], ['accessible', 'Step-free living'], ['quiet', 'Quiet']];
export const EXTRAS = [['office', 'Home office'], ['porch', 'Porch'], ['deck', 'Deck or terrace'], ['basement', 'Basement'], ['balconies', 'Balconies'], ['roof-terrace', 'Roof terrace']];
export const BATHROOM_SHARING = [['private', 'Private'], ['suite', 'Shared in a suite'], ['hall', 'Shared per floor']];
export const COMMON_SPACES = [['lobby', 'Lobby'], ['lounge', 'Lounge'], ['study', 'Study rooms'], ['gym', 'Gym'], ['laundry', 'Laundry'], ['kitchen', 'Shared kitchen'], ['bike-storage', 'Bike storage'], ['mail', 'Mail room']];
export const UNIT_MIX = [['studio', 'Studios'], ['oneBed', '1 bed'], ['twoBed', '2 bed'], ['threeBed', '3 bed']];

export const EMPTY_ADVANCED = {
  quality: null, garage: null, parkingSpaces: null,
  structure: null, cladding: null, roofing: null,
  priorities: [], extras: [],
  unitMix: { studio: null, oneBed: null, twoBed: null, threeBed: null },
  bathroomSharing: null, commonSpaces: [],
};

// Which advanced questions a type shows. Style and anything else the user wants are in their own
// words, in the design prompt.
export function advancedFields(type) {
  const f = ['quality'];
  if (['house', 'tiny-home', 'townhouse', 'duplex'].includes(type)) f.push('garage');
  if (isSharedBuilding(type)) f.push('parkingSpaces');
  f.push('structure', 'cladding', 'roofing', 'priorities', 'extras');
  if (type === 'apartment' || type === 'condo') f.push('unitMix');
  if (type === 'dorm') f.push('bathroomSharing');
  if (isSharedBuilding(type)) f.push('commonSpaces');
  return f;
}

// Advanced answers as sent: questions the type doesn't ask are null or empty.
export function advancedFor(type, adv) {
  const show = new Set(advancedFields(type));
  const out = structuredClone(EMPTY_ADVANCED);
  for (const k of Object.keys(out)) if (show.has(k) && adv[k] != null) out[k] = structuredClone(adv[k]);
  return out;
}

// The advanced fields left for the design system to decide.
export function aiDecides(type, adv) {
  return advancedFields(type).filter((k) => {
    const v = adv[k];
    if (k === 'unitMix') return !v || Object.values(v).every((x) => x == null);
    if (Array.isArray(v)) return v.length === 0;
    return v == null;
  });
}

export function advancedProblems(type, adv, unitCount) {
  const p = {};
  if ((type === 'apartment' || type === 'condo') && adv.unitMix) {
    const vals = Object.values(adv.unitMix).filter((x) => x != null);
    if (vals.length) {
      const sum = vals.reduce((s, x) => s + x, 0);
      if (vals.some((x) => x < 0 || !Number.isInteger(x))) p.unitMix = 'Use whole numbers.';
      else if (unitCount && sum !== unitCount) p.unitMix = `These add up to ${sum}; the building has ${unitCount} homes.`;
    }
  }
  if (adv.parkingSpaces != null && (adv.parkingSpaces < 0 || !Number.isInteger(adv.parkingSpaces))) p.parkingSpaces = 'Use a whole number.';
  return p;
}
