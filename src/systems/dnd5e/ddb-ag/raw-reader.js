import {ownRawRead} from "./request-flags.js";
// Backend reads deliberately retain the libWrapper chain and never enter pack caches.
async function read(packId, request) {
  const pack = globalThis.game?.packs?.get(packId);
  if (!pack) throw new Error(`raw-unavailable: unknown pack ${packId}`);
  if (globalThis.game.babele?.translatedCompendiumFor?.(packId))
    throw new Error(`raw-unavailable: Babele translates ${packId}`);
  const cls = pack.documentClass ?? globalThis.CONFIG?.[pack.documentName]?.documentClass;
  if (!cls || typeof globalThis.CONFIG?.DatabaseBackend?.get !== "function")
    throw new Error(`raw-unavailable: backend missing for ${packId}`);
  const rows = await CONFIG.DatabaseBackend.get(cls, {pack: packId, ...request, broadcast: false, [ownRawRead]:true}, game.user);
  if (!Array.isArray(rows)) throw new Error(`raw-unavailable: invalid response ${packId}`);
  return rows.map(row => structuredClone(row.toObject?.() ?? row));
}
export function readRawIndex(packId, fields = []) {
  return read(packId, {query: {}, index: true, indexFields: [...new Set(["name", "img", ...fields])]});
}
export function readRawDocuments(packId, ids) {
  if (!ids.length) return Promise.resolve([]);
  return read(packId, {query: {_id__in: [...ids]}});
}
