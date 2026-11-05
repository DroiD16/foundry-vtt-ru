import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { initCompendiumDisplay } from "../../src/systems/dnd5e/ddb-ag/compendium-runtime.js";
import { get, set } from "../../src/systems/dnd5e/ddb-ag/projector.js";
import { ownRawRead } from "../../src/systems/dnd5e/ddb-ag/request-flags.js";

const fv = process.env.FOUNDRY_V14_ROOT,
  ddb = process.env.DDB_760_SOURCE;
const privateSkip =
  !fv || !ddb
    ? "Private Foundry v14 / DDB 7.6.0 source: set FOUNDRY_V14_ROOT and DDB_760_SOURCE"
    : false;
test("real CompendiumCollection + DDB 7.6.0 entrypoints", { skip: privateSkip }, async (t) => {
  await access(`${fv}/client/documents/collections/compendium-collection.mjs`);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith("@client/"))
        return next(pathToFileURL(`${fv}/client/${specifier.slice(8)}`).href, context);
      if (specifier.startsWith("@common/"))
        return next(pathToFileURL(`${fv}/common/${specifier.slice(8)}`).href, context);
      return next(specifier, context);
    },
  });
  await import(`${fv}/common/primitives/_module.mjs`);
  const H = await import(`${fv}/common/utils/helpers.mjs`);
  const { default: Collection } = await import(`${fv}/common/utils/collection.mjs`);
  class Doc {
    static hierarchy = {};
    static metadata = { compendiumIndexFields: ["_id", "name", "img", "type", "sort", "folder"] };
    constructor(data, { pack } = {}) {
      this._source = structuredClone(data);
      this.pack = pack;
      this.apps = {};
    }
    static fromSource(data, options) {
      return new this(data, options);
    }
    get id() {
      return this._source._id;
    }
    get name() {
      return this._source.name;
    }
    get uuid() {
      return `Compendium.${this.pack}.Actor.${this.id}`;
    }
    toObject() {
      return structuredClone(this._source);
    }
  }
  class Folder {}
  globalThis._loc = (s) => s;
  globalThis.CONST = {};
  globalThis.CONFIG = { Actor: { compendiumIndexFields: [] } };
  globalThis.game = {
    settings: { get: () => ({}) },
    user: {},
    compendiumArt: { get: () => undefined },
  };
  globalThis.foundry = {
    utils: {
      ...H,
      Collection,
      debounce: () => () => {},
      getDocumentClass: (n) => (n === "Folder" ? Folder : Doc),
    },
    abstract: { Document: Doc },
    documents: { Folder },
    applications: { sidebar: { apps: { Compendium: class {} } } },
  };
  const { default: CompendiumCollection } = await import(
    `${fv}/client/documents/collections/compendium-collection.mjs`
  );
  const { default: runContext } = await import(`${ddb}/lib/DDBRunContext.ts`);
  // Execute the actual DDB consumer body, retaining its settings and collection contract.
  const helper = await readFile(`${ddb}/lib/CompendiumHelper.ts`, "utf8");
  const method = helper.slice(
    helper.indexOf("    getActorIndexActor: async"),
    helper.indexOf("    existingActorCheck:"),
  );
  const consumer = await import(
    `data:text/javascript,${encodeURIComponent(`const utils={getSetting:()=>false};const CompendiumHelper={loadCompendiumIndex:async()=>globalThis.testDdbPack.getIndex({fields:["name","flags.ddbimporter.id","system.source.rules"]})};export default ({${method}}).getActorIndexActor;`)}`
  );
  const PACK = "world.ddb-monsters";
  const english = {
    _id: "m1",
    name: "Goblin",
    type: "npc",
    flags: { ddbimporter: { id: 7 } },
    system: {
      source: { book: "Monster Manual (2024)", rules: "2024" },
      details: { biography: { value: "English biography" } },
    },
    items: [{ _id: "owned", name: "Spear" }],
  };
  const originalRun = runContext.runWith;
  function setup({
    version = "7.6.0",
    ddbActive = true, agActive = true, isGM = true,
    resolveWith, missingMethod,
  } = {}) {
    globalThis.game = { ...game, actors: new Collection() };
    runContext.runWith = originalRun;
    const db = new Map([[english._id, structuredClone(english)]]),
      listeners = new Map(),
      notices = [],
      requests = [];
    let beforeBackend,
      beforeResolve,
      afterBackend,
      loads = 0;
    const Hooks = {
      on(name, fn) {
        const list = listeners.get(name) ?? [];
        list.push(fn);
        listeners.set(name, list);
      },
    };
    const emit = (name, ...args) => (listeners.get(name) ?? []).map((fn) => fn(...args));
    const backend = async (cls, op) => {
      requests.push(op);
      if (beforeBackend) {
        const wait = beforeBackend;
        beforeBackend = undefined;
        await wait;
      }
      const rows = [...db.values()].filter((d) => !op.query?._id || d._id === op.query._id);
      if (op.index)
        return rows.map((d) => {
          const out = { _id: d._id };
          for (const p of op.indexFields) set(out, p, get(d, p));
          return out;
        });
      loads++;
      return rows.map((d) => cls.fromSource(d, { pack: op.pack }));
    };
    CONFIG.DatabaseBackend = { _getDocuments: backend };
    Doc.database = {
      get: (cls, op) =>
        CONFIG.DatabaseBackend._getDocuments(cls, op).then((rows) => {
          if (afterBackend && afterBackend.match(op)) {
            const fn = afterBackend;
            afterBackend = undefined;
            fn.run();
          }
          return rows;
        }),
    };
    game.user = { isGM };
    game.modules = new Map([["ddb-importer", { active: ddbActive, version }], ["ag-fifthpendium", {active: agActive}]]);
    game.settings.get = (module, key) =>
      module === "core" ? {} : key === "entity-monster-compendium" ? PACK : undefined;
    const pack = new CompendiumCollection({
      id: PACK,
      type: "Actor",
      label: "DDB",
      packageType: "world",
      index: [],
      folders: [],
    });
    game.packs = new Map([[PACK, pack]]);
    globalThis.testDdbPack = pack;
    globalThis.DDBImporter = {
      debug: {
        lib: {
          DDBRunContext: runContext,
          DDBToolProficiencies: { syncCompendiumItems: async (fn) => fn() },
        },
      },
      importCharacter: async (fn) => fn(),
      importCharacterById: async (fn) => fn(),
      updateAllPCs: { foundry: async (fn) => fn() },
      parse: Object.fromEntries(
        ["monsters", "items", "spells", "vehicles"].map((k) => [k, async (fn) => fn()]),
      ),
      updateWorldMonsters: async (fn) => fn(),
    };
    if (missingMethod) delete DDBImporter.debug.lib.DDBToolProficiencies.syncCompendiumItems;
    const registered = [];
    const libWrapper = {
      register(_id, path, fn, type) {
        assert.equal(type, "WRAPPER");
        registered.push(path);
        const parts = path.split("."),
          key = parts.pop();
        let target = globalThis;
        for (const p of parts) target = target[p];
        const prev = target[key];
        target[key] = function (...args) {
          return fn.call(this, prev.bind(this), ...args);
        };
      },
    };
    const catalog = {
      ready: async () => {},
      readyActors: async () => {},
      nameFor: (row) => (row.name === "Goblin" ? { raw: row.name, ru: "Гоблин" } : null),
    };
    const resolver = {
      async resolve(data) {
        if (beforeResolve) await beforeResolve;
        return {
          text: {
            ...structuredClone(data),
            name: "Гоблин",
            system: { ...data.system, details: { biography: { value: "Русское описание" } } },
          },
          entry: { uuid: "Compendium.ag.test.Actor.goblin" },
          childRoles: [],
          descriptionRoles: [],
        };
      },
    };
    const runtime = initCompendiumDisplay({
      catalog,
      readContext: async () => ({ resolver: resolveWith ?? resolver, supplement: { entries: [] } }),
      game,
      Hooks,
      libWrapper,
      notice: (s) => notices.push(s),
    });
    return {
      pack,
      db,
      emit,
      notices,
      requests,
      registered,
      onAfterBackend(run, match = () => true) {
        afterBackend = { run, match };
      },
      ...runtime,
      get loads() {
        return loads;
      },
      delayBackend(p) {
        beforeBackend = p;
      },
      delayResolve(p) {
        beforeResolve = p;
      },
    };
  }
  const fields = [
    "name",
    "system.details.biography.value",
    "flags.ddbimporter.id",
    "system.source.rules",
  ];
  async function warm(s) {
    await s.pack.getIndex({ fields });
    const doc = await s.pack.getDocument("m1");
    doc.apps.sheet = { rendered: true };
    return doc;
  }
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  };
  await t.test(
    "cold/warm names, description, search, drag copy; no read database writes",
    async () => {
      const s = setup();
      await s.pack.getIndex({ fields });
      assert.equal(s.loads, 0);
      assert.equal(s.pack.index.get("m1").name, "Гоблин");
      assert.equal(s.pack.index.contents.filter((r) => r.name.includes("Гоб")).length, 1);
      const oldWorld = structuredClone(english);
      const doc = await warm(s);
      assert.equal(doc.name, "Гоблин");
      assert.equal(doc.toObject().system.details.biography.value, "Русское описание");
      const newCopy = doc.toObject();
      assert.equal(newCopy.name, "Гоблин");
      assert.deepEqual(oldWorld, english);
      assert.deepEqual(s.db.get("m1"), english);
      assert.ok(
        !s.requests.find((op) => op.index)?.indexFields.some((p) => p.includes("activities")),
      );
    },
  );
  await t.test(
    "C1/C2/C3/C5 regressions: forced open-sheet eviction, all indexed fields, stable Collection",
    async () => {
      const s = setup();
      const sheet = await warm(s);
      const ref = s.pack.index;
      const row = ref.get("m1");
      const release = s.pause.acquire();
      assert.equal(s.pack.get("m1"), undefined);
      assert.equal(ref, s.pack.index);
      assert.equal(ref.get("m1").name, "Goblin");
      assert.equal(ref.get("m1").system.details.biography.value, "English biography");
      assert.equal((await consumer.default("monster", english))._id, "m1");
      const raw = await s.pack.getDocument("m1");
      assert.notEqual(raw, sheet);
      assert.deepEqual(raw.toObject().items, english.items);
      release();
      assert.equal(row.name, "Гоблин");
      assert.equal(raw.name, "Goblin");
      assert.equal(s.pack.get("m1"), undefined);
      assert.equal((await s.pack.getDocument("m1")).name, "Гоблин");
    },
  );
  await t.test("C4: read crosses acquire during the last projection await", async () => {
    const s = setup();
    const gate = deferred();
    s.delayResolve(gate.promise);
    const read = s.pack.getDocument("m1");
    await Promise.resolve();
    await Promise.resolve();
    const release = s.pause.acquire();
    gate.resolve();
    assert.equal((await read).name, "Goblin");
    assert.equal(s.pack.get("m1").name, "Goblin");
    release();
  });
  await t.test(
    "actual runWith: nested, concurrent, error, only final release restores",
    async () => {
      const s = setup();
      await warm(s);
      const gate = deferred();
      const a = DDBImporter.debug.lib.DDBRunContext.runWith({}, async () => {
        await gate.promise;
        throw Error("expected");
      });
      await DDBImporter.debug.lib.DDBRunContext.runWith({}, async () => {
        assert.equal(s.pause.count, 2);
        assert.equal((await s.pack.getDocument("m1")).name, "Goblin");
      });
      assert.equal(s.pause.count, 1);
      gate.resolve();
      await assert.rejects(a, /expected/);
      assert.equal(s.pause.count, 0);
      assert.equal(s.pack.index.get("m1").name, "Гоблин");
    },
  );
  await t.test("C6: ready/background tools own an independent awaited bracket", async () => {
    const s = setup();
    await warm(s);
    const gate = deferred();
    let bg;
    await s.pause.bracket(async () => {
      bg = DDBImporter.debug.lib.DDBToolProficiencies.syncCompendiumItems(async () => {
        await gate.promise;
        assert.equal((await s.pack.getDocument("m1")).name, "Goblin");
      });
    });
    assert.equal(s.pause.count, 1);
    gate.resolve();
    await bg;
    assert.equal(s.pause.count, 0);
    assert.equal(s.registered[0], "DDBImporter.debug.lib.DDBToolProficiencies.syncCompendiumItems");
  });
  await t.test("C7: munch hold survives window close and releases separately", async () => {
    const s = setup();
    await warm(s);
    class Munch {
      _disableButtons() {}
      _enableButtons() {}
    }
    const app = new Munch();
    s.emit("renderDDBMuncher", app);
    app._disableButtons();
    app._disableButtons();
    s.emit("closeDDBAppV2", app);
    assert.equal(s.pause.count, 1);
    assert.equal((await consumer.default("monster", english))._id, "m1");
    app._enableButtons();
    app._enableButtons();
    assert.equal(s.pause.count, 0);
  });
  await t.test("native write during raw phase invalidates old localized metadata", async () => {
    const s = setup();
    await warm(s);
    const release = s.pause.acquire();
    const raw = await s.pack.getDocument("m1");
    const changed = { ...raw.toObject(), name: "New native name" };
    s.db.set("m1", changed);
    s.pack.set("m1", Doc.fromSource(changed, { pack: PACK }));
    release();
    assert.equal(s.pack.index.get("m1").name, "New native name");
  });
  await t.test("manual edits have no projection save guard", async () => {
    const s = setup();
    const ru = await warm(s);
    assert.deepEqual(s.emit("preUpdateActor", ru, { name: ru.name, img: "new.png" }), []);
    assert.deepEqual(s.emit("preUpdateItem", ru, { "system.price.value": 10 }), []);
    assert.deepEqual(s.db.get("m1"), english);
  });
  await t.test("startup is quiet without providers and compatibility notices are GM-only", () => {
    for (const options of [{ddbActive:false}, {agActive:false}]) {
      const s = setup(options);
      assert.equal(s.enabled, false);
      assert.equal(s.notices.length, 0);
    }
  });
  await t.test("missing required method leaves reads raw without patching", async () => {
    const s = setup({missingMethod:true});
    assert.equal(s.enabled, false);
    assert.deepEqual(s.registered, []);
    assert.equal((await s.pack.getDocument("m1")).name, "Goblin");
  });
  await t.test(
    "different version retains display; private own-reader marker retains wrapped chain",
    async () => {
      const s = setup({ version: "8.0.0" });
      assert.equal(s.enabled, true);
      assert.equal(s.notices.length, 0);
      assert.equal((await s.pack.getDocument("m1")).name, "Гоблин");
      const supported = setup();
      const raw = await CONFIG.DatabaseBackend._getDocuments(Doc, {
        pack: PACK,
        query: {},
        [ownRawRead]: true,
      });
      assert.equal(raw[0].name, "Goblin");
      assert.equal(supported.requests.at(-1)[ownRawRead], true);
    },
  );
  await t.test("C1-C3/C5 negative controls retain actual Foundry failure behavior", async () => {
    let s = setup();
    const sheet = await warm(s);
    s.pack.clear();
    assert.equal(s.pack.get("m1"), sheet);
    s = setup();
    await warm(s);
    s.pack.index.clear();
    assert.equal((await s.pack.getIndex({ fields })).size, 0);
    s = setup();
    await warm(s);
    assert.equal(await consumer.default("monster", english), undefined);
    const row = s.pack.index.get("m1");
    s.pack.index.set("m1", { ...row, name: "Goblin" });
    assert.equal(s.pack.index.get("m1").system.details.biography.value, "Русское описание");
  });
  await t.test(
    "C6/C7 negative controls: unbracketed async consumer and shared window/munch key",
    async () => {
      const s = setup();
      await warm(s);
      const gate = deferred();
      let background;
      await s.pause.bracket(async () => {
        background = (async () => {
          await gate.promise;
          return consumer.default("monster", english);
        })();
      });
      gate.resolve();
      assert.equal(await background, undefined);
      const shared = s.pause.holds(),
        app = {};
      shared.acquire(app);
      shared.acquire(app);
      shared.release(app);
      assert.equal(s.pause.count, 0);
      assert.equal(await consumer.default("monster", english), undefined);
    },
  );
  await t.test("current Resolver and separate Actor candidates through full wrapper", async () => {
    const { Resolver } = await import("../../src/systems/dnd5e/ddb-ag/resolver.js");
    const provider = "ag-fifthpendium",
      uuid = "Compendium.ag-fifthpendium.monsters.Actor.goblin";
    const entry = {
      uuid,
      name: "Goblin",
      english: "Goblin",
      kind: "npc",
      source: "Monster Manual (2024)",
      rules: "2024",
      provider,
    };
    const donor = {
      ...structuredClone(english),
      name: "Гоблин",
      flags: { babele: { originalName: "Goblin" } },
      system: {
        source: structuredClone(english.system.source),
        details: { biography: { value: "Русское описание" } },
      },
    };
    const resolver = new Resolver({
      providers: [{ id: provider, entries: [] }],
      modules: new Map([[provider, { active: true }]]),
      settings: { get: () => "ag" },
      readUuid: async () => donor,
    });
    resolver.catalog = { actorCandidates: () => [entry], incompatibleFor: () => false };
    assert.equal(resolver.byName.size, 0);
    assert.equal(resolver.byUuid.size, 0);
    const s = setup({ resolveWith: resolver });
    const doc = await s.pack.getDocument("m1");
    assert.equal(doc.name, "Гоблин");
    assert.equal(doc.toObject().system.details.biography.value, "Русское описание");
    const release = s.pause.acquire();
    assert.equal((await consumer.default("monster", english))._id, "m1");
    assert.deepEqual((await s.pack.getDocument("m1")).toObject(), english);
    release();
    resolver.cache.clear();
    donor.system.source.rules = "2014";
    s.pack.delete("m1");
    assert.equal((await s.pack.getDocument("m1")).name, "Goblin");
  });
  await t.test(
    "C4 negative control: naive check-at-start returns a cached RU document after acquire",
    async () => {
      const s = setup();
      const gate = deferred();
      CONFIG.DatabaseBackend._getDocuments = async (cls, op) => {
        const ru = cls.fromSource({ ...english, name: "Гоблин" }, { pack: op.pack });
        await gate.promise;
        return [ru];
      };
      const read = s.pack.getDocument("m1");
      const release = s.pause.acquire();
      gate.resolve();
      assert.equal((await read).name, "Гоблин");
      assert.equal(s.pack.get("m1").name, "Гоблин");
      release();
    },
  );
  await t.test(
    "actual DDB owned matcher sees native baseline through full paused wrapper",
    async () => {
      const source = await readFile(`${ddb}/parser/lib/DDBDataUtils.ts`, "utf8");
      const start = source.indexOf("static findMatchedDDBItem("),
        end = source.indexOf("\n    // TO DO: this ignores charges", start);
      assert.ok(start >= 0 && end > start);
      const { default: Native } = await import(
        `data:text/javascript,${encodeURIComponent(`export default class Native {${source.slice(start, end)}}`)}`
      );
      const s = setup();
      const owned = {
        _id: "retained",
        name: "Relentless Avenger",
        type: "feat",
        flags: {
          ddbimporter: {
            id: 10292886,
            originalName: "Relentless Avenger",
            retainActivityUseSpent: true,
          },
        },
        system: { uses: { spent: 2 } },
      };
      s.db.get("m1").items = [owned];
      await warm(s);
      await s.pause.bracket(async () => {
        const raw = await s.pack.getDocument("m1");
        const incoming = structuredClone(owned);
        delete incoming._id;
        const matched = Native.findMatchedDDBItem(incoming, raw.toObject().items);
        assert.equal(matched._id, owned._id);
        assert.equal(matched.system.uses.spent, 2);
        assert.equal(matched.flags.ddbimporter.retainActivityUseSpent, true);
        assert.deepEqual(matched, owned);
      });
    },
  );

  await t.test(
    "actual installed munch bodies release after close makes _enableButtons throw",
    { skip: !process.env.DDB_760_BUNDLE ? "Set DDB_760_BUNDLE to installed 7.6.0 bundle" : false },
    async () => {
      const src = await readFile(process.env.DDB_760_BUNDLE, "utf8");
      const grab = (name, from = 0) => {
        const i = src.indexOf(`${name}(){`, from);
        assert.ok(i >= 0);
        let depth = 0;
        for (let k = src.indexOf("{", i); k < src.length; k++) {
          if (src[k] === "{") depth++;
          else if (src[k] === "}" && !--depth) return src.slice(i, k + 1);
        }
        throw Error(name);
      };
      const start = src.indexOf("class DDBMuncher extends");
      assert.ok(start >= 0);
      const body = [
        grab("_enableButtons", start),
        grab("_disableButtons", start),
        grab("clearProgressBars"),
      ].join("\n");
      const { default: Munch } = await import(
        `data:text/javascript,${encodeURIComponent(`const disableMunchButtons=()=>{};export default class DDBMuncher{element={querySelector:()=>null,querySelectorAll:()=>[]};clearDetails(){}_expandForDetails(){}${body}}`)}`
      );
      const s = setup();
      await warm(s);
      const app = new Munch();
      s.emit("renderDDBMuncher", app);
      app._disableButtons();
      assert.equal(s.pause.count, 1);
      app.element = null;
      s.emit("closeDDBMuncher", app);
      assert.equal(s.pause.count, 1);
      assert.throws(() => app._enableButtons(), TypeError);
      assert.equal(s.pause.count, 0);
    },
  );
  await t.test(
    "actual public get/configureGet preserves private raw marker through registered backend wrapper",
    async () => {
      const { default: vm } = await import("node:vm");
      const src = await readFile(`${fv}/common/abstract/backend.mjs`, "utf8");
      const Backend = vm.runInNewContext(
        src
          .replace(/^import .*;$/m, "")
          .replace("export default class DatabaseBackend", "class DatabaseBackend") +
          "\nDatabaseBackend",
        { Document: class {} },
      );
      const s = setup();
      await warm(s);
      const wrapper = CONFIG.DatabaseBackend._getDocuments,
        user = game.user;
      class Actual extends Backend {
        getCompendiumScopes() {
          return [PACK];
        }
        async _getDocuments(cls, operation, who) {
          assert.equal(who, user);
          assert.equal(operation[ownRawRead], true);
          assert.equal(operation.broadcast, false);
          assert.equal(operation.action, "get");
          return wrapper(cls, operation, who);
        }
      }
      CONFIG.DatabaseBackend = new Actual();
      Doc.documentName = "Actor";
      const { readRawIndex, readRawDocuments } =
        await import("../../src/systems/dnd5e/ddb-ag/raw-reader.js");
      const index = await readRawIndex(PACK, fields);
      assert.equal(index[0].name, "Goblin");
      const documents = await readRawDocuments(PACK, ["m1"]);
      assert.equal(documents[0].name, "Goblin");
      assert.equal(s.requests.at(-1)[ownRawRead], true);
      assert.equal((await s.pack.getDocument("m1")).name, "Гоблин");
    },
  );
  hooks.deregister();
});
