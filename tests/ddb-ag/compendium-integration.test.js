import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { set } from "../../src/systems/dnd5e/ddb-ag/projector.js";

test("settings and compendium localization follow Babele readiness and DDB imports", async (t) => {
  const globals = [
    "Hooks",
    "game",
    "ui",
    "CONFIG",
    "foundry",
    "fromUuid",
    "DDBImporter",
    "libWrapper",
    "HTMLElement",
    "document",
    "Option",
  ];
  const saved = globals.map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]);
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const listeners = new Map(),
    registered = [],
    notices = [];
  globalThis.Hooks = {
    on(name, fn) {
      const rows = listeners.get(name) ?? [];
      rows.push(fn);
      listeners.set(name, rows);
    },
    once(name, fn) {
      this.on(name, fn);
    },
  };
  const emit = (name, ...args) =>
    (listeners.get(name) ?? []).map((fn) => fn(...args));
  const source = {
    _id: "npc",
    name: "Goblin",
    type: "npc",
    flags: { ddbimporter: { id: 7, originalName: "Goblin" } },
    system: {
      source: { book: "MM 2024", rules: "2024" },
      details: { biography: { value: "English" } },
    },
    items: [],
    effects: [],
  };
  const donor = {
    ...structuredClone(source),
    _id: "goblin",
    name: "Гоблин",
    flags: { babele: { originalName: "Goblin" } },
    system: {
      source: { book: "MM 2024", rules: "2024" },
      details: { biography: { value: "Русский текст" } },
    },
  };
  class Document {
    static fromSource(data) {
      return { toObject: () => structuredClone(data) };
    }
  }
  const nativePack = {
    collection: "world.ddb",
    documentName: "Actor",
    metadata: { flags: { ddbimporter: { schema: 1 } } },
    index: new Map(),
    keys: () => [][Symbol.iterator](),
    getIndex: async function () {
      const rows = await CONFIG.DatabaseBackend._getDocuments(Document, {
        pack: this.collection,
        index: true,
      });
      for (const row of rows) this.index.set(row._id, row);
      return this.index;
    },
  };
  let translationsLoaded = false;
  const provider = {
    collection: "ag-fifthpendium.monsters",
    documentName: "Actor",
    metadata: { packageName: "ag-fifthpendium" },
    getIndex: async () => {
      return new Map([[donor._id, translationsLoaded ? donor : { ...donor, name: "Goblin" }]]);
    },
  };
  globalThis.game = {
    user: {},
    modules: new Map([
      ["ddb-importer", { active: true, version: "8.0.0" }],
      ["babele", { active: true }],
      ["ag-fifthpendium", { active: true }],
    ]),
    settings: { get: () => "ag" },
    packs: new Map([
      [nativePack.collection, nativePack],
      [provider.collection, provider],
    ]),
  };
  globalThis.ui = { notifications: { warn: (m) => notices.push(m) } };
  globalThis.CONFIG = {
    compendium: { uuidRedirects: {} },
    DatabaseBackend: { _getDocuments: async () => [structuredClone(source)] },
  };
  globalThis.foundry = {
    utils: {
      getRoute: (p) => p,
      fetchJsonWithTimeout: async (p) =>
        JSON.parse(
          await readFile(
            new URL(
              `../../public/integrations/ddb-ag/${p.split("/").at(-1)}`,
              import.meta.url,
            ),
            "utf8",
          ),
        ),
    },
  };
  globalThis.fromUuid = async () => ({
    toObject: () => structuredClone(donor),
  });
  globalThis.DDBImporter = {
    debug: {
      lib: {
        DDBRunContext: { runWith: async (_context, fn) => fn() },
        DDBToolProficiencies: { syncCompendiumItems: async (fn) => fn() },
      },
    },
  };
  globalThis.libWrapper = {
    register(_id, path, fn) {
      registered.push(path);
      const parts = path.split("."),
        key = parts.pop();
      let obj = globalThis;
      for (const p of parts) obj = obj[p];
      const original = obj[key];
      obj[key] = function (...args) {
        return fn.call(this, original.bind(this), ...args);
      };
    },
  };
  // Missing capabilities and optional providers must leave reads untouched.
  const { initCompendiumDisplay } =
    await import("../../src/systems/dnd5e/ddb-ag/compendium-runtime.js");
  const probe = () =>
    initCompendiumDisplay({ catalog: {}, readContext: async () => ({}) });
  const sync = DDBImporter.debug.lib.DDBToolProficiencies.syncCompendiumItems;
  delete DDBImporter.debug.lib.DDBToolProficiencies.syncCompendiumItems;
  assert.equal(probe().enabled, false);
  assert.deepEqual(registered, []);
  DDBImporter.debug.lib.DDBToolProficiencies.syncCompendiumItems = sync;
  for (const id of ["ddb-importer", "ag-fifthpendium"]) {
    game.modules.get(id).active = false;
    assert.equal(probe().enabled, false);
    assert.deepEqual(registered, []);
    game.modules.get(id).active = true;
  }
  const { initDdbAg } = await import("../../src/systems/dnd5e/ddb-ag/index.js");
  initDdbAg();
  const [display] = emit("ready");
  assert.equal(display.enabled, true);
  const read = async (index = false) => {
    const [row] = await CONFIG.DatabaseBackend._getDocuments(Document, {
      pack: "world.ddb",
      index,
    });
    return row.toObject?.() ?? row;
  };
  assert.equal((await read()).name, "Goblin");
  assert.equal((await read(true)).name, "Goblin");
  emit("dnd5e.ready");
  await nativePack.getIndex();
  assert.equal(nativePack.index.get("npc").name, "Goblin");
  translationsLoaded = true;
  await Promise.all(emit("babele.ready"));
  assert.equal(nativePack.index.get("npc").name, "Гоблин");
  const localized = await read();
  assert.equal(localized.name, "Гоблин");
  assert.equal(localized.system.details.biography.value, "Русский текст");
  assert.deepEqual(localized.flags, source.flags);
  assert.equal((await read(true)).name, "Гоблин");
  await nativePack.getIndex();
  assert.equal(nativePack.index.get("npc").name, "Гоблин");

  // Only the DDB boundary is simulated; installed production wrappers own the pause.
  await DDBImporter.debug.lib.DDBRunContext.runWith({}, async () => {
    assert.equal(nativePack.index.get("npc").name, "Goblin");
    assert.deepEqual(await read(), source);
    assert.equal((await read(true)).name, "Goblin");
  });
  assert.equal((await read()).name, "Гоблин");
  assert.equal((await read(true)).name, "Гоблин");
  await assert.rejects(
    DDBImporter.debug.lib.DDBToolProficiencies.syncCompendiumItems(async () => {
      assert.deepEqual(await read(), source);
      throw new Error("import failed");
    }),
    /import failed/,
  );
  assert.equal((await read()).name, "Гоблин");
  assert.equal((await read(true)).name, "Гоблин");

  donor.name = "Гоблин-разведчик";
  await Promise.all(emit("babele.reinitialized"));
  assert.equal(nativePack.index.get("npc").name, "Гоблин-разведчик");
  await DDBImporter.debug.lib.DDBRunContext.runWith({}, async () => {
    assert.equal(nativePack.index.get("npc").name, "Goblin");
  });

  class Element {
    children = [];
    dataset = {};
    append(...children) {
      this.children.push(...children);
    }
    add(child) {
      this.append(child);
    }
    setAttribute() {}
    removeAttribute() {}
    addEventListener(_event, fn) {
      this.click = fn;
    }
    querySelector() {
      return null;
    }
  }
  globalThis.HTMLElement = Element;
  globalThis.document = { createElement: () => new Element() };
  globalThis.Option = class {};
  game.user.isGM = true;
  game.actors = [];
  for (const id of ["ddb-importer", "ag-fifthpendium", "babele"]) {
    game.modules.get(id).active = false;
    const tab = new Element(),
      root = new Element();
    root.querySelector = () => tab;
    emit("renderSettingsConfig", {}, root);
    const group = tab.children[0];
    const [select, button] = group.children[1].children;
    assert.equal(select.disabled, true);
    assert.equal(button.disabled, true);
    assert.match(group.children[2].textContent, /Включите/);
    await button.click();
    game.modules.get(id).active = true;
  }
  assert.deepEqual(notices, []);

  // A PC can become ineligible after the batch list was built. Keep the earlier
  // result and continue with the next PC using the real apply pipeline.
  const sword = {
    _id: "sword", name: "Test Sword", type: "weapon",
    flags: { ddbimporter: { id: 17, definitionId: 42, definitionEntityTypeId: 7,
      importId: "session", originalName: "Test Sword" } },
    system: { source: { book: "PHB 2024", rules: "2024" },
      description: { value: "English sword" } }, effects: [],
  };
  const translatedSword = { ...structuredClone(sword), name: "Тестовый меч",
    flags: { babele: { originalName: "Test Sword" } } };
  translatedSword.system.description.value = "Описание меча";
  game.packs.set("ag-fifthpendium.equipment", {
    collection: "ag-fifthpendium.equipment", documentName: "Item",
    metadata: { packageName: "ag-fifthpendium" },
    getIndex: async () => new Map([[translatedSword._id, translatedSword]]),
  });
  globalThis.fromUuid = async (uuid) => ({
    toObject: () => structuredClone(uuid.includes(".equipment.") ? translatedSword : donor),
  });
  const actors = ["First", "Unavailable", "Last"].map((name, i) => {
    const data = structuredClone(sword);
    const item = { id: data._id, flags: data.flags, toObject: () => structuredClone(data),
      update: async (patch) => {
        for (const [path, value] of Object.entries(patch)) set(data, path, value);
        if (i === 0) actors[1].flags.ddbimporter.importId = null;
      } };
    const items = new Map([[item.id, item]]);
    items[Symbol.iterator] = items.values;
    return { id: name, name, type: "character", isOwner: true, items,
      flags: { ddbimporter: { importId: "session", dndbeyond: { characterId: i + 1 } } } };
  });
  game.actors = actors;
  await Promise.all(emit("babele.reinitialized"));
  ui.notifications.info = (message) => notices.push(message);
  ui.notifications.warn = (message) => notices.push(message);
  ui.notifications.has = () => false;
  ui.notifications.remove = () => {};
  const tab = new Element(), root = new Element();
  root.querySelector = () => tab;
  emit("renderSettingsConfig", {}, root);
  const button = tab.children[0].children[1].children[1];
  assert.equal(button.disabled, false);
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    await button.click();
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1].message, "PC недоступен для перевода");
  assert.match(notices.at(-1), /обновлено 2, без изменений 0, пропущено 0 .*ошибок 1/);
  assert.match(notices.at(-1), /Unavailable/);
  assert.equal(actors[0].items.get("sword").toObject().name, "Тестовый меч");
  assert.equal(actors[2].items.get("sword").toObject().name, "Тестовый меч");
  assert.equal(button.disabled, false);
  donor.system.source.rules = "2014";
  await Promise.all(emit("babele.reinitialized"));
  assert.deepEqual(await read(), source);
});
