import {initCompendiumDisplay} from "./compendium-runtime.js";
import {bookFolders} from "./publications.js";
import { Resolver } from "./resolver.js";
import { eligibleActor } from "./identity.js";
import { applyActor } from "./apply.js";
import {AG_PROVIDERS, createAgCatalog} from "./catalog.js";
import {readRawIndex, readRawDocuments} from "./raw-reader.js";

let ready = false;
let pending = null;
let running = false;
let catalog;
export function getAgCatalog() { return catalog ??= createAgCatalog({game}); }
const diagnostics = new Map();
const failures = [];
function report({ reason, name, actor, path, ...context }) {
  diagnostics.set(reason, (diagnostics.get(reason) ?? 0) + 1);
  console.debug("ru-ru DDB/AG", { reason, name, actor, path, ...context });
  if (/^(resolve|projection|update)-failed:/.test(reason)) {
    const action = path ? "Не удалось проверить сохранённый текст" :
      reason.startsWith("update-failed:") ? "Не удалось сохранить перевод" : "Не удалось подготовить перевод";
    const field = path?.includes("description") ? "описание" : "текст";
    failures.push(`${action}: ${actor ?? "Персонаж"} → ${name ?? "предмет"}${path ? ` (${field})` : ""}`);
  }
}
async function load() {
  if (
    !AG_PROVIDERS.some(id => game.modules.get(id)?.active)
  )
    throw new Error("Не установлен активный поставщик AG");
  if (!pending)
    pending = (async () => {
      const read = (file) =>
        foundry.utils.fetchJsonWithTimeout(
          foundry.utils.getRoute(`modules/ru-ru/integrations/ddb-ag/${file}.json`),
        );
      const [supplement, sources, roles] = await Promise.all([read("supplement"), read("sources"), read("roles")]);
      if (supplement.schemaVersion !== 1 || ![2,3].includes(sources.schemaVersion) || roles.schemaVersion !== 1)
        throw new Error("Unsupported DDB/AG data schema");
      const catalog = getAgCatalog();
      await catalog.ready();
      const labelIndexes = new Map();
      const resolverOptions = {
        providers: catalog.providers,
        modules: game.modules,
        settings: game.settings,
        redirects: CONFIG.compendium.uuidRedirects,
        diagnostics: report,
        sources,
        roles,
        readNativeParents,

        readUuid: async (uuid, { provider, style, linkOnly, indexOnly }) => {
          if (indexOnly) {
            const parts = uuid.split(".");
            // Embedded donors have no standalone index row. Never load their parents' prose.
            if (parts.length !== 5 || parts[0] !== "Compendium") return null;
            const packId = `${parts[1]}.${parts[2]}`;
            const pack = game.packs.get(packId);
            if (!pack) return null;
            if (!labelIndexes.has(packId)) labelIndexes.set(packId, pack.getIndex({ fields: [
              "type", "folder", "flags.babele.originalName", "system.source", "system.details.source",
              "system.type", "system.classIdentifier", "system.identifier",
            ] }));
            const rows = await labelIndexes.get(packId);
            const row = rows.get(parts[4]);
            if (!row) return null;
            return providerData({ toObject: () => structuredClone(row), folder: pack.folders?.get(row.folder) });
          }
          const document = await globalThis.fromUuid(uuid);
          if (!document) return null;
          if (linkOnly) return document;
          const data = providerData(document);
          // fromUuid already traverses Babele. A second translation can corrupt dnd.su data.
          return data;
        },
      };
      const resolver = new Resolver(resolverOptions);
      const pcResolver = new Resolver(resolverOptions);
      resolver.catalog = pcResolver.catalog = catalog;
      return { resolver, pcResolver, supplement };
    })().catch((error) => {
      pending = null;
      throw error;
    });
  return pending;
}

async function readNativeParents(selector) {
  const pack = game.settings.get("ddb-importer", "entity-item-compendium");
  if (!game.packs.has(pack)) return [];
  const index = await readRawIndex(pack, ["type", "flags.ddbimporter", "system.source"]);
  const ids = index
    .filter((d) => {
      const f = d.flags?.ddbimporter;
      return (
        d.type === selector.kind &&
        f?.definitionId === selector.ddb.definitionId &&
        f.definitionEntityTypeId === selector.ddb.namespace
      );
    })
    .map((d) => d._id);
  if (!ids.length) return [];
  return readRawDocuments(pack, ids);
}

// Mirror the catalog's explicit-first containment/folder evidence on the installed target.
// This object exists only for resolution; it is never saved to either pack.
function providerData(document, seen = new Set()) {
  const data = document.toObject();
  if (seen.has(document)) return data;
  seen.add(document);
  let folder = document.folder,
    book;
  const folders = new Set();
  while (folder && !folders.has(folder)) {
    folders.add(folder);
    book ??= bookFolders.get(folder.name);
    folder = folder.folder;
  }
  const inherited = document.parent?.toObject
    ? providerData(document.parent, seen).system?.source
    : null;
  data.system ??= {};
  const source = data.system.source ?? data.system.details?.source ?? {};
  data.system.source = { ...source };
  if (!source.book && (book || inherited?.book)) data.system.source.book = book ?? inherited.book;
  if (!source.rules && (book || inherited?.rules))
    data.system.source.rules = book ? "2024" : inherited.rules;
  return data;
}

function unavailableReason() {
  if (!game.modules.get("ddb-importer")?.active) return "Включите DDB Importer для перевода персонажей.";
  if (!AG_PROVIDERS.some(id => game.modules.get(id)?.active))
    return "Включите поставщик AG для перевода персонажей.";
  return "";
}

const initializedHooks = new WeakSet();
export function initDdbAg() {
  if (initializedHooks.has(Hooks)) return;
  initializedHooks.add(Hooks);
  Hooks.once("ready", () => {
    const catalog = getAgCatalog();
    const display = initCompendiumDisplay({catalog, readContext:load});
    // dnd5e emits this after startup migration, also when no migration is needed.
    if (display.enabled) Hooks.once("dnd5e.ready", display.pause.acquire());
    return display;
  });
  Hooks.on("babele.ready", () => {
    ready = true;
    pending = null;
    catalog?.invalidate();
  });
  Hooks.on("babele.reinitialized", () => {
    pending = null;
    catalog?.invalidate();
    ready = true;
  });
  Hooks.on("babele.dataLoaded", () => {
    pending = null;
  });
  Hooks.on("renderSettingsConfig", (_app, root) => {
    const html = root instanceof HTMLElement ? root : root[0];
    const tab = html?.querySelector('section[data-tab="ru-ru"]');
    if (!game.user.isGM || !tab || tab.querySelector('[data-ddb-ag="apply"]')) return;
    const group = document.createElement("div");
    group.className = "form-group ru-ru-ddb-ag";
    const label = document.createElement("label");
    label.htmlFor = "ru-ru-ddb-ag-actor";
    label.textContent = "Персонаж DDB";
    const fields = document.createElement("div");
    fields.className = "form-fields";
    const select = document.createElement("select");
    select.id = label.htmlFor;
    select.setAttribute("aria-label", "Персонаж DDB");
    select.setAttribute("aria-describedby", "ru-ru-ddb-ag-hint");
    select.add(new Option("Все импортированные", ""));
    for (const actor of game.actors.filter(eligibleActor))
      select.add(new Option(actor.name, actor.id));
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.ddbAg = "apply";
    button.textContent = "Перевести";
    button.title = "Перевести предметы, заклинания и способности выбранных персонажей DDB через AG";
    button.setAttribute("aria-describedby", "ru-ru-ddb-ag-hint");
    button.disabled = select.disabled = Boolean(unavailableReason());
    if (button.disabled) button.title = unavailableReason();
    button.addEventListener("click", async () => {
      if (running || !game.user.isGM || unavailableReason()) return;
      running = true;
      button.disabled = true;
      button.textContent = "Перевод…";
      button.setAttribute("aria-busy", "true");
      // Native notification failures must not stop data work or discard its totals.
      const safeNotify = (notify) => {
        try {
          return notify();
        } catch {
          return undefined;
        }
      };
      let progress;
      diagnostics.clear();
      failures.length = 0;
      try {
        progress = safeNotify(() => ui.notifications.info("Подготовка перевода…", { progress: true, console: false }));
        if (!ready) throw new Error("Дождитесь готовности Babele");
        const {pcResolver: resolver, supplement} = await load();
        const context = {resolver, supplement};
        // Fresh cache per manual run; selected AG text may have changed since last run.
        context.resolver.cache.clear();
        context.resolver.linkCache.clear();
        const actors = select.value
          ? [game.actors.get(select.value)].filter(Boolean)
          : game.actors.filter(eligibleActor);
        const totals = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };
        let lastUpdate = 0;
        for (const [index, actor] of actors.entries()) {
          let lastPhase;
          const outcome = await applyActor(actor, {
            ...context,
            isGM: game.user.isGM,
            onProgress: ({ phase, completed, total }) => {
              const now = Date.now();
              if (phase === lastPhase && completed !== total && now - lastUpdate < 100) return;
              lastPhase = phase;
              lastUpdate = now;
              if (!progress) return;
              safeNotify(() => {
                if (!ui.notifications.has(progress)) return;
                const fraction = total ? completed / total : 1;
                progress.update({
                  pct: (index + (phase === "prepare" ? fraction / 2 : (1 + fraction) / 2)) / actors.length,
                  message: `DDB/AG: персонаж ${index + 1}/${actors.length}, ${phase === "prepare" ? "подготовка" : "сохранение"} предметов ${completed}/${total}`,
                });
              });
            },
          });
          for (const key of Object.keys(totals)) totals[key] += outcome[key];
        }
        safeNotify(() => {
          if (progress && ui.notifications.has(progress)) progress.update({ pct: 1 });
        });
        const reasons = failures.slice(0, 1).join("");
        safeNotify(() => ui.notifications[totals.failed ? "warn" : "info"](
          `DDB/AG: обновлено ${totals.updated}, без изменений ${totals.unchanged}, пропущено ${totals.skipped} (старый или чужой импорт: ${diagnostics.get("older-or-foreign-import") ?? 0}, несовместимый поставщик: ${diagnostics.get("provider-incompatible") ?? 0}), ошибок ${totals.failed}.${reasons ? ` ${reasons}` : ""}`,
          { permanent: true },
        ));
      } catch (error) {
        console.error("ru-ru DDB/AG", error);
        safeNotify(() => ui.notifications.error("DDB/AG: не удалось выполнить перевод. Подробности в консоли.", { permanent: true }));
      } finally {
        safeNotify(() => { if (progress) ui.notifications.remove(progress); });
        running = false;
        button.disabled = Boolean(unavailableReason());
        button.textContent = "Перевести";
        button.removeAttribute("aria-busy");
      }
    });
    fields.append(select, button);
    group.append(label, fields);
    const hint = document.createElement("p");
    hint.id = "ru-ru-ddb-ag-hint";
    hint.className = "hint";
    hint.textContent = unavailableReason() ||
      "Заменяет текущий текст предметов, заклинаний и способностей персонажей DDB переводом установленного AG. Для защиты ручных правок включите в DDB Importer флаг «Ignore this item when importing the character». Неоднозначные совпадения пропускаются.";
    group.append(hint);
    tab.append(group);
  });
}
