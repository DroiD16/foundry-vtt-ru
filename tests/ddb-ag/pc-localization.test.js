import test from "node:test";
import assert from "node:assert/strict";
import { createAgCatalog } from "../../src/systems/dnd5e/ddb-ag/catalog.js";
import { Resolver } from "../../src/systems/dnd5e/ddb-ag/resolver.js";
import { safeName, set } from "../../src/systems/dnd5e/ddb-ag/projector.js";
import { applyActor } from "../../src/systems/dnd5e/ddb-ag/apply.js";

const original = () => ({
  _id: "world-item",
  type: "weapon",
  name: "Test Sword",
  flags: {
    ddbimporter: {
      id: 17,
      importId: "session",
      definitionId: 42,
      definitionEntityTypeId: 7,
      originalName: "Test Sword",
    },
  },
  system: {
    source: { rules: "2024", book: "PHB 2024" },
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
    source: { rules: "2024", book: "PHB 2024" },
    description: { value: "Описание тестового меча." },
    damage: { formula: "999" },
  },
  flags: { malicious: true, babele: { originalName: "Test Sword" } },
});
function actorFixture() {
  const data = original();
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
    flags: {
      ddbimporter: { importId: "session", dndbeyond: { characterId: 12 } },
    },
    items,
    effects: [{ name: "Applied enchant", disabled: false }],
    update: () => {
      throw new Error("unexpected actor write");
    },
  };
  return { actor, item, data, writes };
}

async function context({ read, duplicate = false } = {}) {
  const collection = "ag-fifthpendium.equipment";
  const donor = translated();
  donor._id = "sword";
  const rows = [donor];
  if (duplicate) rows.push({ ...donor, _id: "second-sword" });
  const modules = new Map([["ag-fifthpendium", { active: true }]]);
  const catalog = createAgCatalog({
    game: {
      modules,
      packs: new Map([
        [
          collection,
          {
            collection,
            documentName: "Item",
            metadata: { packageName: "ag-fifthpendium" },
            getIndex: async () => new Map(rows.map((d) => [d._id, d])),
          },
        ],
      ]),
    },
  });
  await catalog.ready();
  const resolver = new Resolver({
    providers: catalog.providers,
    modules,
    settings: { get: () => "ag" },
    readUuid: async () => (read ? read(donor) : structuredClone(donor)),
  });
  resolver.catalog = catalog;
  return { resolver, isGM: true };
}

test("catalog and PC apply translate text once while preserving mechanics and provenance", async () => {
  const { actor, data, writes } = actorFixture();
  const before = structuredClone(data),
    effects = structuredClone(actor.effects);
  const ctx = await context();
  assert.equal((await applyActor(actor, ctx)).updated, 1);
  assert.equal(data.name, "Тестовый меч");
  assert.equal(data.system.description.value, "Описание тестового меча.");
  const expected = structuredClone(before);
  expected.name = "Тестовый меч";
  expected.system.description.value = "Описание тестового меча.";
  assert.deepEqual(data, expected);
  assert.deepEqual(actor.effects, effects);
  assert.equal((await applyActor(actor, ctx)).unchanged, 1);
  assert.equal(writes.length, 1);
});

test("PC apply excludes protected, foreign-import and compendium-copy items", async () => {
  const valid = actorFixture();
  const protectedItem = actorFixture(),
    foreign = actorFixture(),
    copied = actorFixture();
  protectedItem.data.flags.ddbimporter.ignoreItemImport = true;
  foreign.data.flags.ddbimporter.importId = "other-import";
  copied.item._stats = {
    compendiumSource: "Compendium.other.items.Item.sword",
  };
  const excluded = [protectedItem, foreign, copied];
  for (const [i, f] of excluded.entries()) {
    f.item.id = `excluded-${i}`;
    valid.actor.items.set(f.item.id, f.item);
  }
  const before = excluded.map((f) => structuredClone(f.data));
  const result = await applyActor(valid.actor, await context());
  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 3);
  for (const [i, f] of excluded.entries()) {
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.data, before[i]);
  }
});

test("ambiguous catalog and changed donor edition leave the PC untouched", async () => {
  for (const options of [
    { duplicate: true },
    {
      read: (d) => {
        d.system.source.rules = "2014";
        return d;
      },
    },
  ]) {
    const { actor, data, writes } = actorFixture();
    const before = structuredClone(data);
    assert.equal((await applyActor(actor, await context(options))).skipped, 1);
    assert.deepEqual(data, before);
    assert.equal(writes.length, 0);
  }
});

test("protecting an item during donor IO aborts the pending PC write", async () => {
  const { actor, data, writes } = actorFixture();
  const ctx = await context({
    read: (d) => {
      data.flags.ddbimporter.ignoreItemImport = true;
      return d;
    },
  });
  assert.equal((await applyActor(actor, ctx)).skipped, 1);
  assert.equal(data.system.description.value, "A test sword.");
  assert.equal(writes.length, 0);
});

test("PC apply preserves inline references and refuses a changed automation reference", async () => {
  const { actor, data } = actorFixture();
  data.system.description.value =
    "English [[/r 1d6]] @UUID[Compendium.test.Item.x]{Sword}";
  const ctx = await context({
    read: (d) => {
      d.system.description.value =
        "Русский [[/r 1d6]] @UUID[Compendium.test.Item.x]{Sword}";
      return d;
    },
  });
  assert.equal((await applyActor(actor, ctx)).updated, 1);
  assert.equal(
    data.system.description.value,
    "Русский [[/r 1d6]] @UUID[Compendium.test.Item.x]{Sword}",
  );
  const other = actorFixture();
  other.data.system.description.value = "English [[/r @mod + 1d6]]";
  await applyActor(
    other.actor,
    await context({
      read: (d) => {
        d.system.description.value = "Русский [[/r @mod + 99d6]]";
        return d;
      },
    }),
  );
  assert.equal(
    other.data.system.description.value,
    "English [[/r @mod + 1d6]]",
  );
});

test("PC parent grants resolve features without leaking into display matching", async () => {
  const collection = "ag-fifthpendium.classes";
  const uuid = (id) => `Compendium.${collection}.Item.${id}`;
  const source = { book: "PHB 2024", rules: "2024" };
  const docs = new Map();
  for (const [id, name] of [
    ["paladin", "Paladin"],
    ["wizard", "Wizard"],
  ]) {
    docs.set(uuid(id), {
      _id: id,
      name,
      type: "class",
      system: {
        source,
        identifier: id,
        advancement: [
          {
            type: "ItemGrant",
            level: 1,
            configuration: { items: [uuid(`${id}-spellcasting`)] },
          },
        ],
      },
    });
    docs.set(uuid(`${id}-spellcasting`), {
      _id: `${id}-spellcasting`,
      name: "Spellcasting",
      type: "feat",
      system: { source, type: { value: "class" } },
    });
  }
  const modules = new Map([["ag-fifthpendium", { active: true }]]);
  const catalog = createAgCatalog({
    game: {
      modules,
      packs: new Map([
        [
          collection,
          {
            collection,
            documentName: "Item",
            metadata: { packageName: "ag-fifthpendium" },
            getIndex: async () =>
              new Map([...docs.values()].map((d) => [d._id, d])),
          },
        ],
      ]),
    },
  });
  await catalog.ready();
  const options = {
    providers: catalog.providers,
    modules,
    readUuid: async (id) => structuredClone(docs.get(id)),
  };
  const pc = new Resolver(options),
    display = new Resolver(options);
  pc.catalog = display.catalog = catalog;
  const feature = {
    ...docs.get(uuid("paladin-spellcasting")),
    flags: { ddbimporter: { originalName: "Spellcasting" } },
  };
  const paladin = {
    name: "Paladin",
    kind: "class",
    identifier: "paladin",
    rules: "2024",
    source: "PHB 2024",
    level: 7,
  };
  await pc.prepareParents([paladin]);
  assert.equal(
    (await pc.resolve(feature, { parents: [paladin] }))?.entry.uuid,
    uuid("paladin-spellcasting"),
  );
  assert.equal(await display.resolve(feature), null);
  const multiclass = [
    paladin,
    { ...paladin, name: "Wizard", identifier: "wizard" },
  ];
  await pc.prepareParents(multiclass);
  assert.equal(await pc.resolve(feature, { parents: multiclass }), null);
  assert.equal(await display.resolve(feature), null);
});

test("PC apply renames items without definitionId and with inert automation flags", async () => {
  const { actor, data } = actorFixture();
  delete data.flags.ddbimporter.definitionId;
  data.flags["midi-qol"] = { removeAttackDamageButtons: "default", forceCEOff: true, onUseMacroParts: {} };
  data.flags.dae = { alwaysActive: false, activeEquipped: true };
  data.system.activities.attack.flags = { ddbimporter: { noeffect: true } };
  data.effects[0].changes.push({ key: "name", value: "{} (Test Sword)" });
  assert.equal((await applyActor(actor, await context())).updated, 1);
  assert.equal(data.name, "Тестовый меч");
  assert.equal(data.system.description.value, "Описание тестового меча.");
});

test("PC apply keeps the English name when automation can find the item by name", async () => {
  const cases = {
    "midi ItemMacro": (d) => (d.flags["midi-qol"] = { onUseMacroName: "[postActiveEffects]ItemMacro.Test Sword" }),
    "midi macro parts": (d) =>
      (d.flags["midi-qol"] = { onUseMacroParts: { items: [{ macroName: "Sword Macro", option: "postDamageRoll" }] } }),
    "dae macro": (d) => (d.flags.dae = { macro: { command: "return 1;" } }),
    "premade flags": (d) => (d.flags["chris-premades"] = { info: { identifier: "testSword" } }),
    "flag text with name": (d) => (d.flags.custom = { condition: "workflow.item.name === 'Test Sword'" }),
    "display name in flag text": (d) => {
      d.name = "Test Sword [Keen]";
      d.flags.custom = { condition: "actor.items.getName('Test Sword [Keen]')" };
    },
    "macro effect change": (d) => d.effects[0].changes.push({ key: "macro.execute", value: "GM Helper" }),
    "effect macro flags": (d) => (d.effects[0].flags = { effectmacro: { onCreate: { script: "return;" } } }),
    "DDB activity macro": (d) => (d.system.activities.attack.macro = { name: "", function: "ddb.feat.helper", visible: false }),
    "midi activity macro": (d) => (d.system.activities.attack.macroData = { name: "", command: "return 1;" }),
    "midi activity condition": (d) =>
      (d.system.activities.attack.useConditionText = "actor.items.getName('Test Sword')?.system.uses.value > 0"),
    "midi activity onUse": (d) => (d.system.activities.attack.flags = { "midi-qol": { onUseMacroName: "Helper" } }),
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const { actor, data } = actorFixture();
    mutate(data);
    assert.equal((await applyActor(actor, await context())).updated, 1, label);
    assert.notEqual(data.name, "Тестовый меч", label);
    assert.equal(data.system.description.value, "Описание тестового меча.", label);
  }
});

test("PC apply keeps the name when another item on the actor finds it by name", async () => {
  const { actor, data } = actorFixture();
  const other = actorFixture();
  other.item.id = "other-item";
  other.data.flags.ddbimporter.importId = "session";
  other.data.flags.ddbimporter.ignoreItemImport = true;
  other.data.effects[0].changes.push({ key: "flags.midi-qol.optional.strike.count", value: "ItemUses.Test Sword" });
  actor.items.set(other.item.id, other.item);
  assert.equal((await applyActor(actor, await context())).updated, 1);
  assert.equal(data.name, "Test Sword");
  assert.equal(data.system.description.value, "Описание тестового меча.");
});

test("PC apply keeps midi-qol hard-coded and inert macro names safe", async () => {
  const { actor, data } = actorFixture();
  data.effects[0].changes.push({ key: "macro.CE", value: "Blinded" }, { key: "macro.tokenMagic", value: "glow" });
  data.system.activities.attack.macro = { name: "", function: "", visible: true };
  data.system.activities.attack.macroData = { name: "", command: "" };
  assert.equal((await applyActor(actor, await context())).updated, 1);
  assert.equal(data.name, "Тестовый меч");
  const resist = original();
  resist.name = resist.flags.ddbimporter.originalName = "Magic Resistance";
  assert.equal(safeName(resist), false);
});
