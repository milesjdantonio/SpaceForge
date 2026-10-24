// One outline icon set, 24px grid, 1.6px strokes.

const P = {
  outline: '<path d="M4 18 7 5l10 2 3 11z"/><circle cx="4" cy="18" r="1.6"/><circle cx="7" cy="5" r="1.6"/><circle cx="17" cy="7" r="1.6"/><circle cx="20" cy="18" r="1.6"/>',
  satellite: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5S14.6 18.1 12 20.5M12 3.5C9.4 5.9 8.2 8.7 8.2 12s1.2 6.1 3.8 8.5"/>',
  map: '<path d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
  tilt: '<path d="M3 17 9 7h6l6 10z"/><path d="M6.5 12h11"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
  moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  locate: '<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="m10 21 2-6-2.5-2.5L11 8l3 2.5 3 1M9.5 12.5 7 15M12 15l3 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  retry: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  house: '<path d="M3.5 11 12 4l8.5 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
  share: '<circle cx="6" cy="12" r="2.4"/><circle cx="17.5" cy="6" r="2.4"/><circle cx="17.5" cy="18" r="2.4"/><path d="m8.2 10.9 7-3.8M8.2 13.1l7 3.8"/>',
  pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5S14.6 18.1 12 20.5M12 3.5C9.4 5.9 8.2 8.7 8.2 12s1.2 6.1 3.8 8.5"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="m12 5.5 2.4 6.5h-4.8z" fill="currentColor"/><path d="m12 18.5-2.4-6.5h4.8z"/>',
  grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.2v.3"/>',
  'type-house': '<path d="M3 11 12 4l9 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>',
  'type-tiny-home': '<path d="M6 12 12 6l6 6"/><path d="M7.5 11v9h9v-9"/><path d="M11 20v-3.5h2V20"/><path d="M3 20h18"/>',
  'type-townhouse': '<path d="M2.5 11 6.5 6l4 5M10.5 11l4-5 4 5M18.5 11l3-3.5"/><path d="M3.5 10v10h17V10"/><path d="M10.5 11v9M18.5 11v9"/><path d="M6 20v-3h1.5v3M14 20v-3h1.5v3"/>',
  'type-duplex': '<path d="M3 10 12 4l9 6"/><path d="M5 9v11h14V9"/><path d="M12 7v13"/><path d="M7.5 20v-4h2v4M14.5 20v-4h2v4"/>',
  'type-apartment': '<rect x="5" y="3.5" width="14" height="16.5" rx="1"/><path d="M8.5 7h1.5M14 7h1.5M8.5 10.5h1.5M14 10.5h1.5M8.5 14h1.5M14 14h1.5"/><path d="M10.5 20v-3h3v3"/><path d="M3 20h18"/>',
  'type-condo': '<path d="M4 20V8l8-4.5L20 8v12"/><path d="M8 10h2M14 10h2M8 13.5h2M14 13.5h2"/><path d="M10.5 20v-3h3v3"/><path d="M2.5 20h19"/>',
  'type-dorm': '<rect x="3.5" y="6" width="17" height="14" rx="1"/><path d="M3.5 6 12 2.8 20.5 6"/><path d="M7 9.5h2M11 9.5h2M15 9.5h2M7 13h2M11 13h2M15 13h2"/><path d="M10.5 20v-3.5h3V20"/>',
};

export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`;
}
