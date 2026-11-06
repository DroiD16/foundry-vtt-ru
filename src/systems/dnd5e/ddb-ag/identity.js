import {canonicalPublication} from "./publications.js";
// No world/pack IDs enter a semantic identity. Missing evidence is not inferred.
export function identity(data, { kind } = {}) {
  const flags = data.flags?.ddbimporter;
  if (!flags) return null;
  const source = data.system?.source ?? data.system?.details?.source;
  const rules =
    source?.rules ??
    (flags.is2014 === true && flags.is2024 !== true
      ? "2014"
      : flags.is2024 === true && flags.is2014 !== true
        ? "2024"
        : null);
  if (!["2014", "2024"].includes(rules)) return null;
  if ((flags.is2014 === true && rules !== "2014") || (flags.is2024 === true && rules !== "2024"))
    return null;
  if (
    typeof source?.book !== "string" ||
    !source.book ||
    /^(?:UA|unknown|custom|homebrew)$/i.test(source.book.trim())
  )
    return null;
  let name = flags.originalName ?? data.flags?.babele?.originalName ??
    (typeof data.name === "string" ? data.name.match(/\[([^\]]+)\]$/)?.[1] ?? data.name : data.name);
  // DDB names a species lineage trait "Elven Lineage"; AG names it after the lineage ("High Elf").
  const species = data.flags?.species;
  if (data.type === "feat" && data.system?.type?.value === "race" && species?.isLineage === true &&
      typeof name === "string" && /\bLineage$/.test(name) && typeof species.fullRaceName === "string" && species.fullRaceName)
    name = species.fullRaceName;
  if (!name || !(data.type ?? kind) || !source?.book) return null;
  return {
    kind: data.type ?? kind,
    name,
    rules,
    source: source.book,
    sourceIds: (flags.sources ?? flags.dndbeyond?.sources ?? []).map((s) => s.sourceId),
    subtype: data.system?.type?.value,
    subtypeDetail: data.system?.type?.subtype,
    classIdentifier: data.system?.classIdentifier,
    identifier: data.system?.identifier,
    parent: flags.dndbeyond?.class ?? flags.dndbeyond?.lookupName,
    classId: flags.dndbeyond?.classId,
    requiredLevel: flags.dndbeyond?.requiredLevel,
    choice: flags.dndbeyond?.choice?.choiceId ?? flags.dndbeyond?.choiceId,
    ddb:
      flags.definitionId && flags.definitionEntityTypeId
        ? {
            definitionId: String(flags.definitionId),
            namespace: String(flags.definitionEntityTypeId),
          }
        : null,
  };
}

export function copied(data, nativeSource = false) {
  return Boolean(
    data.pack ||
    (!nativeSource && data._stats?.compendiumSource) ||
    data._stats?.duplicateSource ||
    (!nativeSource && data.flags?.core?.sourceId) ||
    data.flags?.dnd5e?.cachedFor ||
    data.flags?.dnd5e?.enchantment,
  );
}

export function eligibleActorIdentity(actor) {
  const f = actor.flags?.ddbimporter;
  return (
    actor.type === "character" &&
    !actor.isToken &&
    !copied(actor) &&
    Boolean(f?.dndbeyond?.characterId && f.importId)
  );
}

export function eligibleActor(actor) {
  return eligibleActorIdentity(actor) && Array.from(actor.items ?? []).some(item => eligibleItem(actor, item));
}

// DDB CharacterSpellFactory links generated spells to the configured spell pack.
// A source link alone never establishes provenance; import stamps and typed identity do.
export function nativeImportSource(actor, item) {
  const data = item;
  const f = data.flags?.ddbimporter;
  const source = data._stats?.compendiumSource ?? data.flags?.core?.sourceId;
  const packs = globalThis.game?.packs;
  const packId = source?.match(/^Compendium\.(.+)\.Item\.[^.]+$/)?.[1];
  const pack = packs?.get(packId);
  return (
    Boolean(item.type === "spell" || data.type === "spell") &&
    Boolean(
      f?.importId &&
      f.definitionId &&
      (f.definitionEntityTypeId || f.entityTypeId) &&
      pack &&
      (pack.metadata?.flags?.ddbimporter ||
        pack.metadata?.packageName === "ddb-importer" ||
        nativeSpellPacks().includes(packId)) &&
      (!data.flags?.core?.sourceId || data.flags.core.sourceId === source),
    )
  );
}
function nativeSpellPacks() {
  try {
    return [game.settings.get("ddb-importer", "entity-spell-compendium")];
  } catch {
    return [];
  }
}
export function eligibleItem(actor, item) {
  const f = item.flags?.ddbimporter;
  return Boolean(
    f &&
    !copied(item, nativeImportSource(actor, item)) &&
    // Any DDB import stamp. With "update equipment" off, DDB keeps equipment from an
    // earlier import of the same character, so its importId is older than the actor's.
    f.importId &&
    !f.ignoreItemImport &&
    !f.ddbCustomAdded &&
    !f.isCustomItem &&
    !f.custom &&
    !f.dndbeyond?.isCustomItem &&
    (!f.overrideId || f.overrideId === "NONE") &&
    !f.overrideItem &&
    (f.definitionId || f.id ||
      (["race", "species"].includes(item.type) && f.type === "race" && Number.isSafeInteger(f.entityRaceId) && f.entityRaceId > 0)),
  );
}

export const PHYSICAL_KINDS = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container"]);
export function matchEntry(key, entry) {
  if (
    (entry.matchStatus && entry.matchStatus !== "semantic-candidate") ||
    !key ||
    entry.kind !== key.kind ||
    entry.rules !== key.rules ||
    entry.source !== key.source
  )
    return false;
  if (entry.name !== key.name && !(entry.aliases ?? []).includes(key.name)) return false;
  if (entry.parents || entry.context?.grantParents) return false;
  if (entry.issues?.some((issue) => issue !== "duplicate-discriminators")) return false;

  // Physical item subtypes are each module's own categorisation (DDB "trinket", AG "lighting").
  const fields = PHYSICAL_KINDS.has(key.kind) ? ["classIdentifier"] : ["subtype", "subtypeDetail", "classIdentifier"];
  for (const field of fields) {
    if (entry.context?.[field] && entry.context[field] !== key[field]) return false;
  }
  if (entry.parent && typeof entry.parent !== "string") return false;
  if (
    entry.ddb &&
    (!key.ddb ||
      String(entry.ddb.definitionId) !== key.ddb.definitionId ||
      String(entry.ddb.namespace) !== key.ddb.namespace)
  )
    return false;
  return true;
}

// Public selector contract. Legacy identity remains available to the projector.
export function semanticKey(data, options = {}) {
  const key = identity(data, options);
  return key && {...key, english: key.name, publication: canonicalPublication(key.source, key.rules)};
}
