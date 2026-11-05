import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { get } from "../../src/systems/dnd5e/ddb-ag/projector.js";

test("ready pauses migration, isolates PC resolver, checks capabilities and disables unavailable PC actions", async () => {
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
  const emit = (name, ...args) => (listeners.get(name) ?? []).map((fn) => fn(...args));
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
  let actorIndexes = 0,
    imports = 0;
  const nativePack = {
    collection: "world.ddb",
    documentName: "Actor",
    metadata: { flags: { ddbimporter: { schema: 1 } } },
    index: new Map(),
    keys: () => [][Symbol.iterator](),
    getIndex: async function () {
      return this.index;
    },
  };
  const provider = {
    collection: "ag-fifthpendium.monsters",
    documentName: "Actor",
    metadata: { packageName: "ag-fifthpendium" },
    getIndex: async () => {
      actorIndexes++;
      return new Map([[donor._id, donor]]);
    },
  };
  globalThis.game = {
    user: {},
    modules: new Map([
      ["ddb-importer", { active: true, version: "8.0.0" }],
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
            new URL(`../../public/integrations/ddb-ag/${p.split("/").at(-1)}`, import.meta.url),
            "utf8",
          ),
        ),
    },
  };
  globalThis.fromUuid = async () => ({ toObject: () => structuredClone(donor) });
  const noop = async () => {};
  globalThis.DDBImporter = {
    debug: {
      lib: {
        DDBRunContext: { runWith: async (_context, fn) => fn() },
        DDBToolProficiencies: { syncCompendiumItems: noop },
      },
    },
    importCharacter: async () => {
      imports++;
    },
    importCharacterById: async () => {
      imports++;
    },
    updateAllPCs: { foundry: noop },
    parse: { items: noop, spells: noop, monsters: noop, vehicles: noop },
    updateWorldMonsters: noop,
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
  const { initCompendiumDisplay } = await import("../../src/systems/dnd5e/ddb-ag/compendium-runtime.js");
  const probe = () => initCompendiumDisplay({ catalog: {}, readContext: async () => ({}) });
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
  const { initDdbAg, getAgCatalog } = await import(
    `../../src/systems/dnd5e/ddb-ag/index.js?integrated-native`
  );
  initDdbAg();
  initDdbAg();
  assert.equal(listeners.get("ready").length, 1);
  const [display] = emit("ready");
  assert.equal(display.enabled, true);
  assert.equal(typeof display.then, "undefined");
  assert.equal(registered[0], "DDBImporter.debug.lib.DDBToolProficiencies.syncCompendiumItems");
  assert.equal(registered.filter((p) => p === "CONFIG.DatabaseBackend._getDocuments").length, 1);
  class Document {
    static fromSource(data) {
      return { toObject: () => data };
    }
  }
  assert.equal(display.pause.active, true);
  const [migrationRead] = await CONFIG.DatabaseBackend._getDocuments(Document, { pack: "world.ddb" });
  assert.equal(migrationRead.name, "Goblin");
  emit("dnd5e.ready");
  assert.equal(display.pause.active, false);
  const [localized] = await CONFIG.DatabaseBackend._getDocuments(Document, { pack: "world.ddb" });
  assert.equal(localized.toObject().system.details.biography.value, "Русский текст");
  const release = display.pause.acquire();
  const [duringImport] = await CONFIG.DatabaseBackend._getDocuments(Document, { pack: "world.ddb" });
  assert.equal(duringImport.name, "Goblin");
  release();
  const [afterImport] = await CONFIG.DatabaseBackend._getDocuments(Document, { pack: "world.ddb" });
  assert.equal(afterImport.toObject().name, "Гоблин");
  assert.equal(
    getAgCatalog().providers.flatMap((p) => p.entries).length,
    0,
    "Actor candidates stay out of PC universe",
  );
  assert.equal(actorIndexes, 1);
  // Exercise the actual PC button, observing the two runtime Resolver instances.
  const {Resolver} = await import("../../src/systems/dnd5e/ddb-ag/resolver.js");
  const originalResolve = Resolver.prototype.resolve;
  const originalPrepare = Resolver.prototype.prepareParents;
  const globals = ["HTMLElement", "document", "Option"].map(key => [key, globalThis[key]]);
  let pcResolver, displayResolver;
  class Element {
    children = []; dataset = {};
    append(...children) { this.children.push(...children); }
    add(child) { this.append(child); }
    setAttribute() {} removeAttribute() {}
    addEventListener(_event, fn) { this.click = fn; }
    querySelector() { return null; }
  }
  try {
    globalThis.HTMLElement = Element;
    globalThis.document = {createElement: () => new Element()};
    globalThis.Option = class {};
    const item = {flags:{ddbimporter:{id:1,importId:"run"}},toObject:()=>({type:"feat",flags:{ddbimporter:{id:1,importId:"run"}}})};
    game.user.isGM = true;
    game.actors = [{type:"character",flags:{ddbimporter:{importId:"run",dndbeyond:{characterId:1}}},items:[item]}];
    Resolver.prototype.prepareParents = async function () {
      pcResolver = this;
      this.runGrants = new Map([["PC-only", []]]);
    };
    Resolver.prototype.resolve = async function (...args) {
      if (args[1]?.nativeRoot) return null;
      displayResolver = this;
      return originalResolve.apply(this, args);
    };
    const tab = new Element(), root = new Element();
    root.querySelector = () => tab;
    emit("babele.ready");
    for (const id of ["ddb-importer", "ag-fifthpendium"]) {
      game.modules.get(id).active = false;
      const disabledTab = new Element(), disabledRoot = new Element();
      disabledRoot.querySelector = () => disabledTab;
      emit("renderSettingsConfig", {}, disabledRoot);
      const group = disabledTab.children[0];
      const [select, button] = group.children[1].children;
      assert.equal(select.disabled, true);
      assert.equal(button.disabled, true);
      assert.match(group.children[2].textContent, /Включите/);
      await button.click();
      assert.equal(pcResolver, undefined);
      game.modules.get(id).active = true;
    }
    emit("renderSettingsConfig", {}, root);
    await tab.children[0].children[1].children[1].click();
    const [afterPC] = await CONFIG.DatabaseBackend._getDocuments(Document, {pack:"world.ddb"});
    assert.equal(afterPC.toObject().name, "Гоблин");
    assert.ok(pcResolver);
    assert.notEqual(pcResolver, displayResolver);
    assert.equal(pcResolver.providers, displayResolver.providers);
    assert.equal(displayResolver.runGrants, undefined);
  } finally {
    Resolver.prototype.resolve = originalResolve;
    Resolver.prototype.prepareParents = originalPrepare;
    for (const [key, value] of globals) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
  // Public import APIs and PartySync have no installed wrappers.
  assert.ok(!registered.includes("DDBImporter.importCharacter"));
  assert.ok(!registered.includes("DDBImporter.importCharacterById"));
  assert.equal(listeners.has("renderDDBPartySync"), false);
  class Importer {
    async processCharacterData() {}
    copySupportedCharacterItemFlags() {}
    copyCharacterItemEffects() {}
  }
  const importer = new Importer(),
    original = importer.copySupportedCharacterItemFlags;
  const manager = {
    actor: {items:[]},
    characterImporter: importer,
    options: {
      actions: {
        importCharacter: async () => {
          imports++;
        },
      },
    },
  };
  emit("renderDDBCharacterManager", manager);
  assert.equal(importer.copySupportedCharacterItemFlags, original);
  assert.equal(listeners.has("renderDDBCharacterManager"), false);
  const wrapped = manager.options.actions.importCharacter;
  emit("renderDDBCharacterManager", manager);
  assert.equal(manager.options.actions.importCharacter, wrapped);
  await manager.options.actions.importCharacter.call(manager);
  assert.equal(imports, 1);
  const oldItem = {name:"Старое заклинание",type:"spell",_id:"historical",flags:{ddbimporter:{id:17,originalName:"Bless"}}};
  manager.actor = {items:[oldItem]};
  importer.actorOriginal = {items:[{...oldItem,name:"Bless"}]};
  await manager.options.actions.importCharacter.call(manager);
  assert.equal(imports,2,"native manager accepts historical RU items");

  assert.equal(display.pause.count, 0);
  assert.deepEqual(notices, []);
  // Current donor validation checks full metadata after catalog naming.
  donor.system.source.rules = "2014";
  emit("babele.reinitialized");
  const [raw] = await CONFIG.DatabaseBackend._getDocuments(Document, { pack: "world.ddb" });
  assert.equal(get(raw, "name"), "Goblin");
});
