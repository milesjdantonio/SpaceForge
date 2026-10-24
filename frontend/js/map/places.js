// Place search and "where am I" names, from OpenStreetMap's Nominatim (free, no key). Its usage
// policy allows light use: search runs only when the visitor submits, and the place name only after
// the map has settled, at most once a second and cached. Swap `config.geocoder` for a paid service
// before heavy traffic.

import { config } from '../config.js';

let last = 0;
async function politely(url, signal) {
  const wait = Math.max(0, last + 1100 - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const res = await fetch(url, { signal, headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) throw new Error(`Search answered ${res.status}`);
  return res.json();
}

// Places matching a query: [{ name, detail, center: [lng, lat], bbox: [w, s, e, n] | null, kind }]
export async function searchPlaces(query, { signal } = {}) {
  const url = `${config.geocoder}/search?format=jsonv2&limit=6&addressdetails=0&q=${encodeURIComponent(query)}`;
  const list = await politely(url, signal);
  return list.map((p) => {
    const [name, ...rest] = String(p.display_name).split(', ');
    const bb = p.boundingbox?.map(Number);
    return {
      name,
      detail: rest.slice(0, 3).join(', '),
      center: [Number(p.lon), Number(p.lat)],
      bbox: bb ? [bb[2], bb[0], bb[3], bb[1]] : null,
      kind: p.addresstype || p.type,
    };
  });
}

// A short name for where the map is looking: "Asheville, North Carolina".
const cache = new Map();
export async function placeName([lng, lat], zoom, { signal } = {}) {
  const level = zoom >= 13 ? 14 : zoom >= 9 ? 10 : zoom >= 6 ? 5 : 3;
  const key = `${level}:${lng.toFixed(level >= 10 ? 2 : 1)},${lat.toFixed(level >= 10 ? 2 : 1)}`;
  if (cache.has(key)) return cache.get(key);
  const url = `${config.geocoder}/reverse?format=jsonv2&zoom=${level}&lat=${lat}&lon=${lng}`;
  const p = await politely(url, signal);
  const a = p?.address ?? {};
  const local = a.city || a.town || a.village || a.hamlet || a.suburb || a.county;
  const region = a.state || a.province || a.region;
  const parts = level <= 3 ? [a.country] : level <= 5 ? [region, a.country] : [local, region ?? a.country];
  const name = parts.filter(Boolean).join(', ') || null;
  cache.set(key, name);
  return name;
}
