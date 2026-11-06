import {semanticKey, matchEntry} from "./identity.js";
import {canonicalPublication, canonicalName, publicationContradicts, bookFolders, agStyleEvidence} from "./publications.js";

export const AG_PROVIDERS = ["ag-fifthpendium", "ag-fifthpendium-dndbeyond", "ag-fifthpendium-eberron", "ag-fifthpendium-forgotten-realms", "ag-fifthpendium-ravenloft"];
export const AG_INDEX_FIELDS = ["type", "folder", "flags.babele.originalName", "flags.babele.translated", "flags.babele.hasTranslation", "system.source", "system.details.source", "system.type", "system.identifier", "system.classIdentifier", "system.container"];
const english = value => typeof value === "string" && /[A-Za-z]/.test(value) && /^[\p{Script=Latin}\p{M}\p{N}\p{P}\p{S} ]+$/u.test(value) && !/[<>\p{Cc}\p{Cf}]/u.test(value);
export function englishName(data) {
  // AG sometimes types a typographic apostrophe ("Cook’s Utensils"); DDB never does.
  const parse = v => typeof v === "string" ? (v.match(/\[([^\]]+)\]\s*$/)?.[1] ?? v).replace(/[’‘]/g, "'") : null;
  const names = [parse(data.flags?.babele?.originalName), parse(data.name)].filter(english);
  return new Set(names).size === 1 ? names[0] : null;
}
// Only this bounded provider language layer may separate display from identity.
// A Babele originalName alone is not evidence: both complete labels and all raw
// discriminators must match the independently reviewed AG/dictionary tuple.
export function providerEnglishName(data, {uuid, provider, style} = {}) {
  const proof = agStyleEvidence.get(uuid);
  if (!proof || style !== "dndsu") return englishName(data);
  const [pack, id, kind, book, name, original, label, identifier, subtype, detail, parent] = proof;
  const source = data.system?.source ?? data.system?.details?.source;
  if (provider !== pack.split(".")[0] || data._id !== id ||
      (data.uuid && data.uuid !== uuid) || data.type !== kind ||
      source?.rules !== "2024" ||
      (canonicalPublication(source?.book, "2024") ?? source?.book) !== (canonicalPublication(book, "2024") ?? book) ||
      data.flags?.babele?.translated !== true || data.flags?.babele?.hasTranslation !== true ||
      data.flags?.babele?.originalName !== original || data.name !== label ||
      (data.system?.identifier ?? null) !== identifier ||
      (data.system?.type?.value ?? null) !== subtype ||
      (data.system?.type?.subtype ?? null) !== detail ||
      (data.system?.classIdentifier ?? null) !== parent) return englishName(data);
  return name;
}
// Exact identities may still have an unsafe combined presentation. Keep those
// catalog rows for identity/ambiguity, but do not offer their labels as text.
export function providerPresentationCompatible(uuid, name, label) {
  if (!agStyleEvidence.has(uuid)) return true;
  const numbers = value => JSON.stringify(value.match(/[+-]?\d+(?:\.\d+)?/g) ?? []);
  return numbers(name) === numbers(label.match(/^(.*?)\s*\[/)?.[1] ?? label);
}
export function catalogRow(data, pack, provider, {style} = {}) {
  // Items inside AG starting-equipment packs are copies of the standalone entry.
  if (data.system?.container) return null;
  const name = providerEnglishName(data, {uuid:`Compendium.${pack.collection}.${pack.documentName}.${data._id}`, provider, style});
  if (!name || !data.type) return null;
  let folder = pack.folders?.get(data.folder), book;
  const seen = new Set();
  while (folder && !seen.has(folder)) { seen.add(folder); book ??= bookFolders.get(folder.name); folder = folder.folder; }
  const source = data.system?.source ?? data.system?.details?.source ?? {};
  const rawBook = source.book || book, rules = source.rules || (book ? "2024" : null);
  if (!rawBook || !["2014", "2024"].includes(rules)) return null;
  const publication = canonicalPublication(rawBook, rules) ?? rawBook;
  const context = {subtype:data.system?.type?.value, subtypeDetail:data.system?.type?.subtype, classIdentifier:data.system?.classIdentifier};
  return {uuid:`Compendium.${pack.collection}.${pack.documentName}.${data._id}`, pack:pack.collection, provider,
    english:name, name, ru:data.name, kind:data.type, type:data.type, rules, publication, source:publication,
    identifier:data.system?.identifier, ...context, context};
}
async function bounded(rows, fn) {
  let next = 0;
  await Promise.all(Array.from({length:Math.min(4, rows.length)}, async () => {
    while (next < rows.length) await fn(rows[next++]);
  }));
}
export function createAgCatalog({game}) {
  let generation = 0, pending, actorPending, items = [], actors = [], statuses = [];
  const providers = [];
  let itemLookup = new Map(), actorLookup = new Map();
  const packs = kind => [...game.packs.values()].filter(p => p.documentName === kind && AG_PROVIDERS.includes(p.metadata?.packageName ?? p.collection?.split(".")[0]) && game.modules.get(p.metadata?.packageName ?? p.collection.split(".")[0])?.active);
  async function build(kind, epoch) {
    const all = [], diagnostics = [];
    await bounded(packs(kind), async pack => {
      const provider = pack.metadata?.packageName ?? pack.collection.split(".")[0];
      const status = {documentName:kind, provider, version:game.modules.get(provider)?.version, packs:[pack.collection], missingFields:[], compatible:true};
      try {
        const index = await pack.getIndex({fields:AG_INDEX_FIELDS});
        const rows = [...index.values()];
        const style = provider === "ag-fifthpendium-ravenloft" ? "ag" : (() => {try {return game.settings?.get("ag-fifthpendium", "compendiumTranslation") === "dndsu" ? "dndsu" : "ag";} catch {return "ag";}})();
        const usable = rows.map(d => catalogRow(d, pack, provider, {style})).filter(Boolean);
        if (rows.length && !usable.length) status.missingFields.push("english/source/rules/type");
        if (rows.some(d => ["class", "subclass"].includes(d.type)) && !rows.some(d => d.system?.identifier)) status.missingFields.push("system.identifier");
        if (rows.some(d => d.type === "subclass") && !rows.some(d => d.system?.classIdentifier)) status.missingFields.push("system.classIdentifier");
        status.compatible = !status.missingFields.length;
        all.push(...usable.map(row => ({...row, compatible:status.compatible})));
        if (!status.compatible) status.blockers = rows.map(d => ({name:englishName(d), kind:d.type,
          rules:d.system?.source?.rules, publication:canonicalPublication(d.system?.source?.book, d.system?.source?.rules)}));
      } catch (e) { status.compatible = false; status.missingFields.push(`index: ${e.message}`); }
      if (!status.compatible) console.warn(`ru-ru provider-incompatible: AG ${provider} ${pack.collection}: ${status.missingFields.join(", ")}`);
      diagnostics.push(status);
    });
    if (epoch !== generation) return;
    statuses.push(...diagnostics);
    const lookup = new Map();
    for (const row of all) {if (!lookup.has(row.english)) lookup.set(row.english, []); lookup.get(row.english).push(row);}
    if (kind === "Item") {
      itemLookup = lookup;
      items = all;
      providers.splice(0, providers.length, ...AG_PROVIDERS.filter(id => game.modules.get(id)?.active).map(id => ({id, entries:items.filter(r => r.provider === id)})));
    } else {actors = all; actorLookup = lookup;}
  }
  function ready() { return pending ??= build("Item", generation).catch(e => {pending = null; throw e;}); }
  function readyActors() { return actorPending ??= build("Actor", generation).catch(e => {actorPending = null; throw e;}); }
  function candidates(lookup, key) {
    if (!key || !key.publication || publicationContradicts(key)) return [];
    const name = canonicalName(key);
    return (lookup.get(name) ?? []).filter(r => matchEntry({...key, name, source:key.publication}, r));
  }
  return {
    providers, ready, readyActors,
    incompatibleFor(key, kind = "Item") {
      if (!key) return false;
      return statuses.some(s => !s.compatible && s.documentName === kind && (!s.blockers || s.blockers.some(b =>
        (!b.name || b.name === canonicalName(key)) && (!b.kind || b.kind === key.kind) &&
        (!b.rules || b.rules === key.rules) && (!b.publication || b.publication === (key.publication ?? key.source)))));
    },
    itemCandidates:key => candidates(itemLookup, key), actorCandidates:key => candidates(actorLookup, key),
    nameFor(data, {documentName} = {}) {
      const key = semanticKey(data, {kind:documentName});
      if (this.incompatibleFor(key, documentName === "Actor" ? "Actor" : "Item")) return null;
      const rows = candidates(documentName === "Actor" ? actorLookup : itemLookup, key);
      // Acquisition-dependent roles require Actor context. Never read donor documents here.
      const standalone = rows.filter(r => !["subclass"].includes(r.kind) && !(r.kind === "feat" && ["class", "race", "background"].includes(r.subtype)));
      if (standalone.length !== 1) return null;
      const row = standalone[0];
      return providerPresentationCompatible(row.uuid, row.name, row.ru) ? {raw:data.name, ru:row.ru} : null;
    },
    status:() => structuredClone(statuses),
    invalidate() { generation++; pending = actorPending = null; items = []; actors = []; itemLookup = new Map(); actorLookup = new Map(); statuses = []; providers.length = 0; },
  };
}
