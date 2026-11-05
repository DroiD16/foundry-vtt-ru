import {prepareRuntimeEnvironment} from "./runtime-harness.js";
import test from "node:test";
import assert from "node:assert/strict";
import { identity, eligibleActor, eligibleItem } from "../../src/systems/dnd5e/ddb-ag/identity.js";
import {
  Resolver,
  redirectUuid,
  translationStyle,
} from "../../src/systems/dnd5e/ddb-ag/resolver.js";
import { project, projectSupplement, set } from "../../src/systems/dnd5e/ddb-ag/projector.js";
import { applyActor } from "../../src/systems/dnd5e/ddb-ag/apply.js";

const entry = {
  kind: "weapon",
  name: "Test Sword",
  rules: "2024",
  source: "Test source",
  uuid: "Compendium.ag-fifthpendium.equipment.Item.sword",
};
const original = () => ({
  _id: "world-item",
  type: "weapon",
  name: "Test Sword",
  flags: {
    ddbimporter: {
      importId: "session",
      definitionId: 42,
      definitionEntityTypeId: 7,
      originalName: "Test Sword",
    },
  },
  system: {
    source: { rules: "2024", book: "Test source" },
    description: { value: "A test sword." },
    damage: { formula: "1d8+@mod" },
    uses: { spent: 3 },
    activities: {
      attack: {
        _id: "attack",
        type: "attack",
        name: "Attack",
        damage: { formula: "1d8" },
        consumption: { targets: [] },
      },
    },
  },
  effects: [
    {
      _id: "source-effect",
      name: "Effect",
      changes: [{ key: "system.test", value: "1" }],
      disabled: false,
    },
  ],
});
const translated = () => ({
  ...original(),
  name: "Тестовый меч",
  system: {
    source: { rules: "2024", book: "Test source" },
    description: { value: "Описание тестового меча." },
    damage: { formula: "999" },
  },
  flags: { malicious: true, babele: { originalName: "Test Sword" } },
});
function resolver(entries = [entry], overrides = {}) {
  return new Resolver({
    providers: [{ id: "ag-fifthpendium", entries }],
    modules: new Map([["ag-fifthpendium", { active: true }]]),
    settings: { get: () => "ag" },
    readUuid: async () => translated(),
    ...overrides,
  });
}
function actorFixture() {
  const data = original();
  data.effects = [];
  const writes = [];
  const item = {
    id: data._id,
    get flags() {
      return data.flags;
    },
    toObject: () => structuredClone(data),
    update: async (patch) => {
      writes.push(patch);
      for (const [key, value] of Object.entries(patch)) set(data, key, value);
    },
    updateEmbeddedDocuments: () => {
      throw new Error("unexpected effects write");
    },
  };
  const items = new Map([[item.id, item]]);
  items[Symbol.iterator] = function* () {
    yield* this.values();
  };
  const actor = {
    id: "actor-1",
    type: "character",
    isOwner: true,
    flags: { ddbimporter: { importId: "session", dndbeyond: { characterId: 12 } } },
    items,
    effects: [{ name: "Applied enchant", disabled: false }],
    update: () => {
      throw new Error("unexpected actor write");
    },
  };
  return { actor, item, data, writes };
}

test("semantic identity is independent of world ids, pack names and inventory instance ids", async () => {
  const a = original(),
    b = original();
  b._id = "other-world";
  b.pack = "custom.ddb-library";
  b.flags.ddbimporter.id = 9000;
  assert.deepEqual(identity(a), identity(b));
  assert.equal((await resolver().resolve(b)).match, "exact-semantic");
});
test("namespace, edition, parent and duplicate matches fail closed", async () => {
  assert.equal(await resolver([{ ...entry, rules: "2014" }]).resolve(original()), null);
  assert.equal(await resolver([{ ...entry, parent: "Wizard" }]).resolve(original()), null);
  assert.equal(
    await resolver([{ ...entry, ddb: { definitionId: 42, namespace: 8 } }]).resolve(original()),
    null,
  );
  assert.equal(await resolver([entry, { ...entry, uuid: "other" }]).resolve(original()), null);
  assert.equal(
    (await resolver([{ ...entry, ddb: { definitionId: 42, namespace: 7 } }]).resolve(original()))
      .match,
    "catalog-pair",
  );
});
test("explicit aliases only, no fuzzy or identifier fallback", async () => {
  assert.equal(await resolver([{ ...entry, name: "Test sword" }]).resolve(original()), null);
  assert.ok(
    await resolver([{ ...entry, name: "Canonical", aliases: ["Test Sword"] }]).resolve(original()),
  );
});
test("partial provider and unresolved catalog entries skip with diagnostics", async () => {
  const reasons = [];
  assert.equal(
    await resolver([entry], {
      modules: new Map(),
      diagnostics: (d) => reasons.push(d.reason),
    }).resolve(original()),
    null,
  );
  assert.deepEqual(reasons, ["provider-not-installed"]);
  assert.equal(await resolver([{ ...entry, matchStatus: "unresolved" }]).resolve(original()), null);
});
test("UUID redirects detect cycles and enforce final edition", async () => {
  assert.equal(redirectUuid("old", { old: "new" }), "new");
  assert.equal(
    redirectUuid("old.Item.x", { "old": "new", "old.Item": "specific.Item" }),
    "specific.Item.x",
  );
  assert.throws(() => redirectUuid("a", { a: "b", b: "a" }), /cycle/);
  assert.equal(
    await resolver([entry], {
      readUuid: async () => ({ ...translated(), system: { source: { rules: "2014" } } }),
    }).resolve(original()),
    null,
  );
});
test("AG style inherits core setting; Ravenloft stays AG; ru-ru setting is never queried", () => {
  const settings = {
    get: (module, key) => {
      assert.equal(module, "ag-fifthpendium");
      assert.equal(key, "compendiumTranslation");
      return "dndsu";
    },
  };
  for (const id of [
    "ag-fifthpendium",
    "ag-fifthpendium-eberron",
    "ag-fifthpendium-forgotten-realms",
    "ag-fifthpendium-dndbeyond",
  ])
    assert.equal(translationStyle(id, settings), "dndsu");
  assert.equal(translationStyle("ag-fifthpendium-ravenloft", settings), "ag");
});
test("manual, compendium-derived and protected Items skip; reverse sync guard does not protect import", () => {
  const { actor, item, data } = actorFixture();
  assert.ok(eligibleActor(actor));
  assert.ok(eligibleItem(actor, item));
  for (const key of ["ignoreItemImport", "ddbCustomAdded", "isCustomItem", "custom"]) {
    data.flags.ddbimporter[key] = true;
    assert.equal(eligibleItem(actor, item), false);
    delete data.flags.ddbimporter[key];
  }
  data.flags.ddbimporter.ignoreItemUpdate = true;
  assert.ok(eligibleItem(actor, item));
  data.flags.ddbimporter.importId = "other";
  assert.equal(eligibleItem(actor, item), false);
  data.flags.ddbimporter.importId = "session";
  item._stats = { compendiumSource: "Compendium.old.pack.Item.source" };
  assert.equal(eligibleItem(actor, item), false);
  delete item._stats;
  actor._stats = { duplicateSource: "Actor.old" };
  assert.equal(eligibleActor(actor), false);
});
test("projection preserves all mechanics and metadata, protects automation names", () => {
  const before = original(),
    after = translated();
  const delta = project(before, after);
  assert.deepEqual(delta, {
    "name": "Тестовый меч",
    "system.description.value": "Описание тестового меча.",
  });
  const copy = structuredClone(before);
  for (const [path, value] of Object.entries(delta)) set(copy, path, value);
  copy.name = before.name;
  copy.system.description.value = before.system.description.value;
  assert.deepEqual(copy, before);
  for (const name of [
    "Monk's Focus",
    "Sorcery Points",
    "Mighty Summoner",
    "Moonbeam",
    "Hunter's Mark",
  ]) {
    const item = original();
    item.name = name;
    item.flags.ddbimporter.originalName = name;
    item.effects = [];
    assert.equal(project(item, after).name, undefined);
  }
});
test("inline syntax and links are preserved exactly; differing syntax skips", () => {
  const a = original(),
    b = translated();
  for (const syntax of [
    "@UUID[Compendium.test.Item.x]{Sword}",
    "[[/r 1d6]]",
    "{{formula}}",
    '<a href="https://example.com">link</a>',
  ]) {
    a.system.description.value = `English ${syntax}`;
    b.system.description.value = `Русский ${syntax}`;
    assert.ok(project(a, b)["system.description.value"]);
    b.system.description.value += " @UUID[other]";
    assert.equal(project(a, b)["system.description.value"], undefined);
  }
});
test("apply writes only changed text; second run is a no-op; actor effects and metadata stay intact", async () => {
  const { actor, data, writes } = actorFixture();
  const baseline = structuredClone(data),
    effects = structuredClone(actor.effects);
  const progress = [];
  const context = { resolver: resolver(), supplement: { entries: [] }, isGM: true,
    onProgress: (update) => progress.push(update) };
  assert.equal((await applyActor(actor, context)).updated, 1);
  const expected = [
    { phase: "prepare", completed: 0, total: 1 },
    { phase: "prepare", completed: 1, total: 1 },
    { phase: "apply", completed: 0, total: 1 },
    { phase: "apply", completed: 1, total: 1 },
  ];
  assert.deepEqual(progress, expected);
  progress.length = 0;
  assert.equal((await applyActor(actor, context)).unchanged, 1);
  assert.deepEqual(progress, expected);
  assert.equal(writes.length, 1);
  assert.deepEqual(actor.effects, effects);
  assert.deepEqual(data.flags, baseline.flags);
  assert.deepEqual(data.system.damage, baseline.system.damage);
  data.system.description.value = "Ручная правка";
  data.flags.ddbimporter.ignoreItemImport = true;
  await assert.rejects(applyActor(actor, context));
  assert.equal(writes.length, 1);
});
test("guard changes during provider fetch abort the write", async () => {
  const { actor, data, writes } = actorFixture();
  const progress = [];
  const r = resolver([entry], {
    readUuid: async () => {
      data.flags.ddbimporter.ignoreItemImport = true;
      return translated();
    },
  });
  const result = await applyActor(actor, { resolver: r, supplement: { entries: [] }, isGM: true,
    onProgress: (update) => progress.push(update) });
  assert.equal(result.skipped, 1);
  assert.deepEqual(progress.at(-1), { phase: "apply", completed: 1, total: 1 });
  assert.equal(writes.length, 0);
});
test("progress completes on resolve and update failures without changing outcome counters", async () => {
  for (const phase of ["resolve", "update"]) {
    const { actor, item, writes } = actorFixture();
    const progress = [];
    const reasons = [];
    const fail = () => { throw new Error("controlled failure"); };
    const r = resolver([entry], { diagnostics: ({ reason }) => reasons.push(reason) });
    if (phase === "resolve") r.resolve = fail;
    else item.update = fail;
    const outcome = await applyActor(actor, { resolver: r, supplement: { entries: [] }, isGM: true,
      onProgress: (update) => progress.push(update) });
    assert.deepEqual(outcome, { updated: 0, unchanged: 0, skipped: 0, failed: 1 });
    assert.deepEqual(progress[0], { phase: "prepare", completed: 0, total: 1 });
    const total = phase === "resolve" ? 0 : 1;
    assert.deepEqual(progress.at(-1), { phase: "apply", completed: total, total });
    assert.deepEqual(reasons, [`${phase}-failed: controlled failure`]);
    assert.equal(writes.length, 0);
  }
});
test("source supplements require exact role; applied enchant copies are untouched", () => {
  const item = original();
  item.effects[0].type = "base";
  item.effects[0].origin = "Actor.x.Item.y";
  const supplement = {
    entries: [
      {
        parent: entry.name,
        kind: entry.kind,
        source: entry.source,
        rules: entry.rules,
        role: "source-effect",
        name: "Effect",
        type: "base",
        safeName: true,
        translations: { ag: { name: "Эффект" } },
      },
    ],
  };
  assert.deepEqual(projectSupplement(item, { entry, style: "ag" }, supplement), {
    activityDelta: {},
    effectDeltas: [],
  });
});
test("non-GM cannot invoke apply even with an eligible Actor", async () => {
  const progress = [];
  await assert.rejects(
    applyActor(actorFixture().actor, {
      resolver: resolver(),
      supplement: { entries: [] },
      isGM: false,
      onProgress: (update) => progress.push(update),
    }),
  );
  assert.deepEqual(progress, []);
});

test("both datasets retain parent/context discrimination and unknown fields fail closed", async () => {
  for (const fields of [
    { parents: [{ uuid: "Compendium.ag.classes.Item.parent", role: "ItemGrant", level: 2 }] },
    { context: { grantParents: [{ name: "Fighter" }] } },
    { context: { classIdentifier: "fighter" } },
    { context: { subtype: "martialM" } },
    { context: { subtypeDetail: "restricted" } },
    { parent: { kind: "npc", name: "Example", rules: "2024", source: "Test source" } },
    { issues: ["missing-class-parent"] },
    { matchStatus: "child-anchor" },
    { rules: "" },
    { source: "" },
  ])
    assert.equal(await resolver([{ ...entry, ...fields }]).resolve(original()), null);
  const item = original();
  item.system.type = { value: "martialM" };
  assert.ok(await resolver([{ ...entry, context: { subtype: "martialM" } }], { readUuid: async () => { const donor = translated(); donor.system.type = { value: "martialM" }; return donor; } }).resolve(item));
});
test("installed provider version and source mutations are not silently accepted", async () => {
  assert.equal(
    await resolver([entry], {
      readUuid: async () => {
        const d = translated();
        d.system.source.book = "Other";
        return d;
      },
    }).resolve(original()),
    null,
  );
  assert.equal(
    await resolver([entry], {
      readUuid: async () => {
        const d = translated();
        d.flags.babele.originalName = "Different Sword";
        return d;
      },
    }).resolve(original()),
    null,
  );
});
test("AG UUID aliases locate missing targets, never match a DDB id", async () => {
  const reads = [];
  const r = resolver(
    [{ ...entry, context: { uuidAliases: ["Compendium.ag-fifthpendium.equipment.Item.alias"] } }],
    {
      readUuid: async (uuid) => {
        reads.push(uuid);
        return uuid.endsWith(".alias") ? translated() : null;
      },
    },
  );
  assert.ok(await r.resolve(original()));
  assert.equal(reads.length, 2);
});

test("legacy compendium projection contract awaits compendium scope integration", {}, async () => {
  const { initDdbAg } = await import("../../src/systems/dnd5e/ddb-ag/index.js");
  const previous = Object.fromEntries(
    ["Hooks", "game", "foundry", "CONFIG", "libWrapper", "fromUuid"].map((key) => [
      key,
      globalThis[key],
    ]),
  );
  const hooks = new Map();
  let wrapper;
  let babeleCalls = 0, donorReads = 0;
  try {
    globalThis.Hooks = {
      once: (name, fn) => hooks.set(name, fn),
      on: (name, fn) => hooks.set(name, fn),
    };
    globalThis.game = {
      modules: new Map([
        ["ag-fifthpendium", { active: true }],
        ["lib-wrapper", { active: true }],
      ]),
      settings: { get: () => "ag" },
      packs: new Map([["renamed.ddb-pack", { documentName: "Item" }]]),
      babele: {
        translate: (_pack, data) => {
          babeleCalls++;
          return data;
        },
      },
    };
    globalThis.foundry = {
      utils: {
        getRoute: (path) => path,
        fetchJsonWithTimeout: async (path) =>
          path.endsWith("supplement.json") || path.endsWith("roles.json")
            ? { schemaVersion: 1, entries: [] }
            : {
                schemaVersion: 2,
                providers: path.endsWith("core.json")
                  ? [{ id: "ag-fifthpendium", entries: [entry] }]
                  : [],
              },
      },
    };
    globalThis.CONFIG = { compendium: { uuidRedirects: {} } };
    globalThis.libWrapper = {
      register: (_module, _target, fn) => {
        wrapper = fn;
      },
    };
    globalThis.game.packs.set("ag-fifthpendium.equipment", { getIndex: async () => new Map([["sword", translated()]]) });
    globalThis.fromUuid = async () => { donorReads++; return { pack: "ag-fifthpendium.equipment", toObject: translated }; };
    prepareRuntimeEnvironment(); initDdbAg();
    hooks.get("ready")();
    hooks.get("dnd5e.ready")();
    const source = original(),
      baseline = structuredClone(source);
    const wrapped = async () => [source];
    assert.equal(typeof wrapper, "function");
    hooks.get("babele.ready")();
    const [result] = await wrapper(wrapped, class {static fromSource(d){return d;}}, { pack: "renamed.ddb-pack" });
    assert.equal(result.system.description.value, "Описание тестового меча.");
    assert.deepEqual(source, baseline);
    assert.deepEqual(result.flags, source.flags);
    assert.equal(babeleCalls, 0);
    assert.strictEqual((await wrapper(wrapped, class {static fromSource(d){return d;}}, {}))[0], source);
    const [index] = await wrapper(wrapped, class {static fromSource(d){return d;}}, { pack: "renamed.ddb-pack", index: true });
    assert.equal(index.name, source.name, "unknown publication remains raw in metadata naming");
    assert.equal(index.system.description.value, source.system.description.value);
    let reconstructed = 0;
    class NonStrict {
      constructor() {
        throw new Error("strict constructor must not be used");
      }
      static fromSource(data) {
        reconstructed++;
        if (data._id === "bad") throw new Error("invalid legacy document");
        return { ...data, reconstructed: true };
      }
    }
    const bad = { ...structuredClone(source), _id: "bad" };
    const mixed = await wrapper(async () => [bad, source], NonStrict, { pack: "renamed.ddb-pack" });
    assert.strictEqual(mixed[0], bad);
    assert.equal(mixed[1].reconstructed, true);
    assert.equal(reconstructed, 2);
    const priorCalls = babeleCalls, priorReads = donorReads;
    hooks.get("babele.ready")();
    await wrapper(wrapped, class {static fromSource(d){return d;}}, { pack: "renamed.ddb-pack" });
    assert.equal(babeleCalls, priorCalls, "fromUuid already traverses the provider chain");
    assert.ok(donorReads > priorReads, "source refresh invalidates provider cache");
    let fields;
    await wrapper(
      async (_cls, request) => {
        fields = request.indexFields;
        return [source];
      },
      null,
      { pack: "renamed.ddb-pack", index: true },
    );
    assert.ok(fields.includes("flags.ddbimporter"));
    assert.ok(fields.includes("system.source"));
    assert.ok(!fields.includes("system.activities"));
    assert.ok(!fields.includes("effects"));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("generic publication tokens are not evidence of a shared publication", async () => {
  const data = original();
  data.system.source.book = "UA";
  assert.equal(identity(data), null);
  assert.equal(await resolver([{ ...entry, source: "UA" }]).resolve(data), null);
});

test("throwing progress callbacks preserve two Item writes, counters and repeat no-op", async () => {
  const run = async (throwsAt) => {
    const first = actorFixture(), second = actorFixture();
    second.item.id = second.data._id = "second-item";
    first.actor.items.set(second.item.id, second.item);
    const context = { resolver: resolver(), supplement: { entries: [] }, isGM: true };
    let thrown = 0;
    if (throwsAt) context.onProgress = ({ phase, completed }) => {
      if (`${phase}:${completed}` === throwsAt) {
        thrown++;
        throw new Error("notification failed");
      }
    };
    const outcome = await applyActor(first.actor, context);
    const count = first.writes.length + second.writes.length;
    const repeat = await applyActor(first.actor, context);
    assert.equal(first.writes.length + second.writes.length, count);
    if (throwsAt) assert.equal(thrown, 2);
    return { outcome, repeat, count, data: [first.data, second.data] };
  };
  const baseline = await run();
  assert.deepEqual(baseline.outcome, { updated: 2, unchanged: 0, skipped: 0, failed: 0 });
  assert.deepEqual(baseline.repeat, { updated: 0, unchanged: 2, skipped: 0, failed: 0 });
  assert.equal(baseline.count, 2);
  for (const event of ["prepare:0", "apply:0", "apply:1", "apply:2"])
    assert.deepEqual(await run(event), baseline, event);
});

test("native notification exceptions preserve batch totals and restore the settings button", async () => {
  const keys = ["Hooks", "HTMLElement", "document", "Option", "game", "ui", "foundry", "CONFIG"];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class Element {
    children = []; dataset = {}; attributes = {};
    append(...children) { this.children.push(...children); }
    add(child) { this.append(child); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(_event, callback) { this.click = callback; }
  }
  try {
    const hooks = {};
    globalThis.Hooks = { on: (name, fn) => { hooks[name] = fn; }, once: () => {} };
    globalThis.HTMLElement = Element;
    globalThis.document = { createElement: () => new Element() };
    globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
    const fixtures = [actorFixture(), actorFixture()];
    const actors = fixtures.map((f) => f.actor);
    actors.get = (id) => actors.find((a) => a.id === id);
    globalThis.game = { user: { isGM: true }, actors,
      packs: new Map(), modules: new Map([["ddb-importer", { active: true }], ["ag-fifthpendium", { active: true }]]), settings: { get: () => "ag" } };
    globalThis.CONFIG = { compendium: { uuidRedirects: {} } };
    globalThis.foundry = { utils: { getRoute: (s) => s, fetchJsonWithTimeout: async (path) => ({
      schemaVersion: /\/(supplement|roles)\.json$/.test(path) ? 1 : 2,
      providers: [], entries: [],
    }) } };
    const { initDdbAg } = await import("../../src/systems/dnd5e/ddb-ag/index.js");
    initDdbAg();
    hooks["babele.ready"]();
    const tab = new Element(), root = new Element();
    tab.querySelector = () => null;
    root.querySelector = () => tab;
    hooks.renderSettingsConfig({}, root);
    const button = tab.children[0].children[1].children[1];
    assert.equal(button.disabled, false);
    for (const missing of ["ddb-importer", "ag-fifthpendium"]) {
      game.modules.get(missing).active = false;
      const disabledTab = new Element();
      disabledTab.querySelector = () => null;
      root.querySelector = () => disabledTab;
      hooks.renderSettingsConfig({}, root);
      assert.equal(disabledTab.children.length, 1, "GM block remains visible");
      const [select, disabledButton] = disabledTab.children[0].children[1].children;
      assert.equal(disabledButton.disabled, true);
      assert.equal(select.disabled, true);
      assert.match(disabledTab.children[0].children[2].textContent, /Включите/);
      await disabledButton.click(); // No notifications or data work without dependencies.
      game.modules.get(missing).active = true;
    }

    let fault, failures, summaries;
    const fail = (at) => { if (fault === at) { failures++; throw new Error(at); } };
    const notification = { update: ({ pct }) => { fail(pct === 1 ? "final" : "update"); } };
    globalThis.ui = { notifications: {
      info: (message, options) => {
        if (options.progress) { fail("create"); return notification; }
        summaries.push({ message, options }); fail("summary");
      },
      has: () => { fail("has"); return true; },
      remove: () => fail("remove"),
    } };
    for (fault of ["create", "has", "update", "final", "remove", "summary"]) {
      failures = 0; summaries = [];
      await button.click();
      assert.ok(failures > 0, fault);
      assert.equal(summaries.length, 1, fault);
      assert.match(summaries[0].message, /обновлено 0, без изменений 0, пропущено 2 \(старый или чужой импорт: 0, несовместимый поставщик: 0\), ошибок 0/);
      assert.deepEqual(summaries[0].options, { permanent: true });
      assert.equal(button.disabled, false, fault);
      assert.equal(button.textContent, "Перевести", fault);
      assert.equal(button.attributes["aria-busy"], undefined, fault);
      assert.equal(fixtures.flatMap((f) => f.writes).length, 0);
    }
    // A subsequent click also proves that the private running guard was released.
    fault = undefined; summaries = [];
    await button.click();
    assert.equal(summaries.length, 1);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
