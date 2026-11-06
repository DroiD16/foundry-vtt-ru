import { presentationEqual } from "./presentation.js";
import { eligibleActor, eligibleActorIdentity, eligibleItem, identity } from "./identity.js";
import { canonicalName } from "./publications.js";
import { automationStrings, get, project, projectCandidates } from "./projector.js";

export async function applyActor(actor, { resolver, supplement = {entries: []}, isGM, onProgress }) {
  if (!isGM || !eligibleActor(actor) || actor.isOwner === false)
    throw new Error("PC недоступен для перевода");
  // Progress is synchronous, optional UI feedback; it must never interrupt Item work.
  const safeReporter = (event) => {
    try {
      onProgress?.(event);
    } catch {
      // A notification failure is not an Item failure.
    }
  };
  const outcome = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  // Resolve everything before the first write. Never call Actor.update or touch Actor.effects.
  const proposals = [];
  const snapshots = new Map(Array.from(actor.items, i => [i, i.toObject()]));
  const parents = actorParents([...snapshots.values()]);
  // Automation on any item can find another item by name (midi-qol `ItemUses.Ki`).
  const automation = [...snapshots.values()].flatMap(automationStrings);
  await resolver.prepareParents?.(parents);
  let prepared = 0;
  for (const item of actor.items) {
    safeReporter({ phase: "prepare", completed: prepared++, total: actor.items.size });
    if (!eligibleItem(actor, item)) {
      outcome.skipped++;
      continue;
    }
    let before, match;
    try {
      before = snapshots.get(item);
      match = await resolver.resolve(before, { parents, nativeRoot: true });
    } catch (error) {
      outcome.failed++;
      resolver.diagnostics({ reason: `resolve-failed: ${error.message}`, name: item.name, actor: actor.name, actorId: actor.id, itemId: item.id, path: error.path });
      continue;
    }
    if (!match) {
      outcome.skipped++;
      continue;
    }
    try {
      let rollData;
      try {
        rollData = item.getRollData?.();
      } catch {
        rollData = undefined;
      }
      const patch = project(before, match.text, {
        diagnostics: resolver.diagnostics,
        nativeRoot: true,
        automation,
        rollData,
        ...match.projectOptions,
      });
      const { extra, children } = projectCandidates(before, match, supplement);
      const { activityDelta, effectDeltas } = extra;
      Object.assign(patch, activityDelta, children.delta);
      for (const delta of children.effectDeltas) {
        const existing = effectDeltas.find((e) => e._id === delta._id);
        if (existing) Object.assign(existing, delta);
        else effectDeltas.push(delta);
      }
      proposals.push({ item, before, patch, effectDeltas });
    } catch (error) {
      outcome.failed++;
      resolver.diagnostics({ reason: `projection-failed: ${error.message}`, name: item.name, actor: actor.name, actorId: actor.id, itemId: item.id, path: error.path });
    }
  }
  safeReporter({ phase: "prepare", completed: prepared, total: prepared });
  let applied = 0;
  for (const { item, before, patch, effectDeltas } of proposals) {
    safeReporter({ phase: "apply", completed: applied++, total: proposals.length });
    // Check native guard again after async provider reads. Abort stale proposals.
    if (
      !eligibleActorIdentity(actor) ||
      !eligibleItem(actor, item) ||
      actor.items.get(item.id) !== item ||
      JSON.stringify(item.toObject()) !== JSON.stringify(before)
    ) {
      outcome.skipped++;
      continue;
    }
    if (!Object.keys(patch).length && !effectDeltas.length) {
      outcome.unchanged++;
      continue;
    }
    try {
      if (Object.keys(patch).length) await item.update(patch);
      if (effectDeltas.length) {
        if (!eligibleItem(actor, item)) throw new Error("Item protected during translation");
        await item.updateEmbeddedDocuments("ActiveEffect", effectDeltas);
      }
      const current = item.toObject();
      const failedPath = Object.entries(patch).find(([path, value]) =>
        !presentationEqual(get(current, path), value))?.[0] ??
        effectDeltas.flatMap(delta => Object.entries(delta)
          .filter(([path, value]) => path !== "_id" &&
            !presentationEqual(get(current.effects?.find(e => e._id === delta._id), path), value))
          .map(([path]) => `effects.${delta._id}.${path}`))[0];
      if (failedPath) {
        const error = new Error("Translation verification failed");
        error.path = failedPath;
        throw error;
      }
      outcome.updated++;
    } catch (error) {
      outcome.failed++;
      resolver.diagnostics({ reason: `update-failed: ${error.message}`, name: item.name, actor: actor.name, actorId: actor.id, itemId: item.id, path: error.path });
    }
  }
  safeReporter({ phase: "apply", completed: applied, total: proposals.length });
  return outcome;
}

export function actorParents(items) {
  const classes = new Map();
  for (const data of items) if (data.type === "class") {
    const id = data.system?.identifier;
    if (!classes.has(id)) classes.set(id, []);
    classes.get(id).push(data);
  }
  return items.map(data => {
    const key = identity(data);
    if (!key) return null;
    // "Background: Noble" grants as AG "Noble".
    key.name = canonicalName(key);
    // A DDB subrace or lineage ("High Elf") is granted by its base species in AG ("Elf").
    const f = data.flags?.ddbimporter;
    if (["race", "species"].includes(data.type) && (f?.isSubRace || f?.isLineage) &&
        typeof f.baseRaceName === "string" && f.baseRaceName)
      key.name = f.baseRaceName;
    const matching = classes.get(data.system?.classIdentifier) ?? [];
    const level = data.type === "subclass" ?
      (data.system?.classIdentifier && matching.length === 1 ? matching[0].system?.levels : undefined) : data.system?.levels;
    return {...key, level};
  }).filter(Boolean);
}
