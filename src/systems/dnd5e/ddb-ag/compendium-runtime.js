import { project, projectCandidates, set } from "./projector.js";
import { createImportPause, installImportEntrypoints } from "./import-pause.js";
import { ownRawRead } from "./request-flags.js";

const metadataFields = [
  "type",
  "flags.ddbimporter",
  "system.source",
  "system.details.source",
  "system.type",
  "system.identifier",
  "system.classIdentifier",
];
const settings = [
  "item",
  "spell",
  "monster",
  "vehicle",
  "class",
  "species",
  "background",
  "feat",
  "summons",
  "override",
];
export function isDdbSourcePack(pack, game) {
  if (!pack || !["Actor", "Item"].includes(pack.documentName)) return false;
  if (pack.metadata?.flags?.ddbimporter?.schema !== undefined) return true;
  return settings.some((kind) => {
    try {
      return game.settings.get("ddb-importer", `entity-${kind}-compendium`) === pack.collection;
    } catch {
      return false;
    }
  });
}
function applyPatches(
  clone,
  { delta = {}, effectDeltas = [], resultDeltas = [], itemDeltas = [] },
) {
  for (const [p, v] of Object.entries(delta)) set(clone, p, v);
  for (const [list, patches] of [
    [clone.effects, effectDeltas],
    [clone.results, resultDeltas],
  ]) {
    for (const patch of patches) {
      const target = list?.find((row) => row._id === patch._id);
      if (target) for (const [p, v] of Object.entries(patch)) if (p !== "_id") set(target, p, v);
    }
  }
  for (const patch of itemDeltas) {
    const target = clone.items?.find((row) => row._id === patch._id);
    if (target) applyPatches(target, patch);
  }
}

// Must be called synchronously in ready. readContext is the existing load() owner;
// it supplies the current Resolver and supplement, including typed parent checks.
export function initCompendiumDisplay({
  catalog,
  readContext,
  game = globalThis.game,
  Hooks = globalThis.Hooks,
  libWrapper = globalThis.libWrapper,
  notice = (message) => globalThis.ui?.notifications?.warn(message),
}) {
  if (!game.modules.get("ddb-importer")?.active ||
      ![...game.modules.entries()].some(([id, module]) => id.startsWith("ag-fifthpendium") && module.active))
    return { enabled: false };
  const warn = notice;
  notice = (message) => { if (game.user?.isGM) warn(message); };
  const packs = () => [...game.packs.values()].filter((p) => isDdbSourcePack(p, game));
  let enabled = false;
  const pause = createImportPause({ packs, refresh: () => refreshIndexes() });
  try {
    if (!installImportEntrypoints({ pause, game, Hooks, libWrapper, notice })) {
      notice(
        "DDB: русский просмотр компендиумов отключён. Недоступны необходимые методы DDB Importer или libWrapper. Кнопка перевода персонажа AG доступна отдельно.",
      );
      return { enabled, pause };
    }
    enabled = true;
  } catch (error) {
    notice("DDB: русский просмотр отключён из-за конфликта обёрток импорта.");
    console.warn("ru-ru DDB wrappers", error);
    return { enabled: false, pause };
  }
  async function names(rows, pack) {
    await catalog.ready();
    if (pack.documentName === "Actor") await catalog.readyActors();
    return rows.map((raw) => {
      const name = catalog.nameFor(raw, { documentName: pack.documentName });
      return name && raw.flags?.ddbimporter ? { ...structuredClone(raw), name: name.ru } : raw;
    });
  }
  async function refreshIndexes() {
    for (const pack of packs()) {
      if (pause.active) return;
      await pack.getIndex({ fields: metadataFields });
      if (pause.active) return;
      const original = [...pack.index.values()];
      const translated = await names(original, pack);
      if (pause.active) return;
      let changed = false;
      for (let i = 0; i < original.length; i++) {
        const raw = original[i],
          ru = translated[i];
        if (ru === raw || pack.index.get(raw._id) !== raw) continue;
        pause.remember(pack, raw, ru);
        pack.index.set(raw._id, ru);
        changed = true;
      }
      if (changed)
        for (const app of Object.values(pack.apps ?? {})) {
          try {
            Promise.resolve(app.render?.(false)).catch(() => {});
          } catch {
            /* display only */
          }
        }
    }
  }
  try {
    libWrapper.register(
      "ru-ru",
      "CONFIG.DatabaseBackend._getDocuments",
      async function (wrapped, cls, request, ...rest) {
        const pack = game.packs.get(request?.pack);
        if (!enabled || request?.[ownRawRead] || !isDdbSourcePack(pack, game))
          return wrapped(cls, request, ...rest);
        const index = Boolean(request.index ?? request.options?.index);
        const operation = index
          ? {
              ...request,
              indexFields: [...new Set([...(request.indexFields ?? []), ...metadataFields])],
            }
          : request;
        const raw = await wrapped(cls, operation, ...rest);
        if (!Array.isArray(raw) || pause.active) return raw;
        try {
          let projected;
          if (index) projected = await names(raw, pack);
          else {
            const { resolver: currentResolver, supplement } = await readContext();
            if (pack.documentName === "Actor") await catalog.readyActors();
            projected = await Promise.all(
              raw.map(async (document) => {
                try {
                  const data = document.toObject?.() ?? document;
                  if (
                    !data.flags?.ddbimporter ||
                    data.flags.ddbimporter.ignoreItemImport ||
                    data._stats?.duplicateSource
                  )
                    return document;
                  const match = await currentResolver.resolve(data, {
                    kind: pack.documentName,
                    pack: pack.collection,
                    sourceActor: pack.documentName === "Actor" ? data : undefined,
                  });
                  if (!match) return document;
                  const clone = structuredClone(data);
                  const { extra, children } = projectCandidates(data, match, supplement);
                  applyPatches(clone, {
                    ...children,
                    delta: {
                      ...project(data, match.text, match.projectOptions),
                      ...extra.activityDelta,
                      ...children.delta,
                    },
                    effectDeltas: [...extra.effectDeltas, ...children.effectDeltas],
                  });
                  return cls.fromSource(clone, { pack: pack.collection });
                } catch (error) {
                  console.warn("ru-ru DDB document projection", error);
                  return document;
                }
              }),
            );
          }
          // No awaits below: an earlier UI read must never return RU while paused.
          if (pause.active) return raw;
          for (let i = 0; i < raw.length; i++)
            if (raw[i] !== projected[i]) {
              pause.remember(
                pack,
                raw[i].toObject?.() ?? raw[i],
                projected[i].toObject?.() ?? projected[i],
              );
            }
          return projected;
        } catch (error) {
          console.warn("ru-ru DDB projection", error);
          return raw;
        }
      },
      "WRAPPER",
    );
  } catch (error) {
    enabled = false;
    notice("DDB: русский просмотр отключён из-за конфликта обёртки компендиумов.");
    console.warn("ru-ru DDB wrapper", error);
    return { enabled, pause };
  }
  // Initial game.data indexes also pass through metadata-only naming.
  void refreshIndexes().catch((error) => console.warn("ru-ru DDB index", error));
  return { enabled, pause, refreshIndexes };
}
