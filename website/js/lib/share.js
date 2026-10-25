// Sharing a building: the design, where it stands and its land, compressed into the link's hash
// (#b=...), so it needs no server or account and the hash never reaches any server. Builder details
// and the brief's form are never included.

export const SHARE_SCHEMA = 'terrasim.shared-building/1';
// Past this, some chat apps cut links short; the page offers a file as well.
export const LONG_LINK = 30000;

const b64url = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

// The shared document: what the person opening the link needs to see the building where it stands.
// `estimate` is only for older designs that keep their cost outside the design (design.cost).
export function shareDocument({ design, placement = design.placement, ring = design.site?.outline, name = null, estimate = null }) {
  return { schema: SHARE_SCHEMA, name: name ?? design.overview?.title ?? null, design, placement, ring, estimate: design.cost ? null : estimate };
}

export async function packShare(doc) {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  return b64url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function unpackShare(str) {
  const json = await pipe(fromB64url(str), new DecompressionStream('deflate-raw'));
  const doc = JSON.parse(new TextDecoder().decode(json));
  if (doc?.schema !== SHARE_SCHEMA || !doc.design) throw new Error('That link isn’t a TerraSim building.');
  return doc;
}
