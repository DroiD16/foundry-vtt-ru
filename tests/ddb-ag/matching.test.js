import test from "node:test";
import assert from "node:assert/strict";
import { createAgCatalog } from "../../src/systems/dnd5e/ddb-ag/catalog.js";
import { Resolver } from "../../src/systems/dnd5e/ddb-ag/resolver.js";
import { safeText, set } from "../../src/systems/dnd5e/ddb-ag/projector.js";
import { applyActor } from "../../src/systems/dnd5e/ddb-ag/apply.js";
import { publicationContradicts } from "../../src/systems/dnd5e/ddb-ag/publications.js";
import sources from "../../public/integrations/ddb-ag/sources.json" with { type: "json" };

const PHB = { book: "PHB 2024", rules: "2024" };
const uuid = (pack, id) => `Compendium.ag-fifthpendium.${pack}.Item.${id}`;

// AG documents keyed by uuid; each lands in the pack named in its uuid.
async function world(docs, { links = () => true } = {}) {
  const byPack = new Map();
  for (const [id, doc] of docs) {
    const pack = id.split(".").slice(1, 3).join(".");
    if (!byPack.has(pack)) byPack.set(pack, []);
    byPack.get(pack).push(doc);
  }
  const modules = new Map([["ag-fifthpendium", { active: true }]]);
  const catalog = createAgCatalog({
    game: {
      modules,
      packs: new Map(
        [...byPack].map(([collection, rows]) => [
          collection,
          {
            collection,
            documentName: "Item",
            metadata: { packageName: "ag-fifthpendium" },
            getIndex: async () => new Map(rows.map((d) => [d._id, d])),
          },
        ]),
      ),
    },
  });
  await catalog.ready();
  const resolver = new Resolver({
    providers: catalog.providers,
    modules,
    settings: { get: () => "ag" },
    sources,
    readUuid: async (id, { linkOnly } = {}) =>
      linkOnly ? (links(id) ? {} : null) : structuredClone(docs.get(id) ?? null),
  });
  resolver.catalog = catalog;
  return { resolver, isGM: true };
}

function actorWith(rows, { importId = "session" } = {}) {
  const items = new Map();
  for (const data of rows) {
    const item = {
      id: data._id,
      get flags() {
        return data.flags;
      },
      type: data.type,
      data,
      toObject: () => structuredClone(data),
      getRollData: () => data.rollData,
      update: async (patch) => {
        for (const [key, value] of Object.entries(patch)) set(data, key, value);
      },
      updateEmbeddedDocuments: async () => {},
    };
    items.set(item.id, item);
  }
  items[Symbol.iterator] = function* () {
    yield* this.values();
  };
  return {
    id: "actor",
    type: "character",
    isOwner: true,
    flags: { ddbimporter: { importId, dndbeyond: { characterId: 1 } } },
    items,
    effects: [],
  };
}

const ddb = (id, name, type, system = {}, flags = {}) => ({
  _id: id,
  name,
  type,
  flags: { ddbimporter: { id: 100, importId: "session", originalName: name, is2024: true, ...flags } },
  system: { source: PHB, description: { value: `<p>${name} English.</p>` }, ...system },
});
const ag = (id, name, english, type, system = {}) => ({
  _id: id,
  name: `${name} [${english}]`,
  type,
  system: { source: PHB, description: { value: `<p>${name}.</p>` }, ...system },
});

test("class features resolve through open ItemChoice and pooled grants with DDB naming", async () => {
  const docs = new Map([
    [uuid("classes", "warlock"), ag("warlock", "Колдун", "Warlock", "class", {
      identifier: "warlock",
      advancement: [{ type: "ItemChoice", level: null, configuration: { items: [], pool: [], restriction: { type: "class", subtype: "eldritchInvocation" } } }],
    })],
    [uuid("classes", "repel"), ag("repel", "Отбрасывающий разряд", "Repelling Blast", "feat", { type: { value: "class", subtype: "eldritchInvocation" } })],
    [uuid("origins", "elf"), ag("elf", "Эльф", "Elf", "race", {
      identifier: "elf",
      advancement: [
        { type: "ItemGrant", level: 0, configuration: { items: [uuid("origins", "fey")] } },
        { type: "ItemChoice", level: null, configuration: { items: [], pool: [uuid("origins", "high")] } },
      ],
    })],
    [uuid("origins", "fey"), ag("fey", "Наследие фей", "Fey Ancestry", "feat", { type: { value: "race" } })],
    [uuid("origins", "high"), ag("high", "Высший эльф", "High Elf", "feat", { type: { value: "race" } })],
    [uuid("origins", "noble"), ag("noble", "Благородный", "Noble", "background")],
  ]);
  const actor = actorWith([
    ddb("warlock", "Warlock", "class", { identifier: "warlock", levels: 3 }, { definitionId: 5 }),
    ddb("repel", "Eldritch Invocations: Repelling Blast", "feat",
      { type: { value: "class", subtype: "eldritchInvocation" } },
      { dndbeyond: { class: "Warlock", choice: { choiceId: "c1" } } }),
    ddb("race", "High Elf", "race", { identifier: "high-elf" },
      { type: "race", baseRaceName: "Elf", isLineage: true, isSubRace: true }),
    { ...ddb("fey", "Fey Ancestry", "feat", { type: { value: "race" } }) },
    { ...ddb("lineage", "Elven: High Elf Lineage", "feat", { type: { value: "race" } }, { originalName: "Elven Lineage" }),
      flags: { ddbimporter: { id: 101, importId: "session", originalName: "Elven Lineage", is2024: true,
        dndbeyond: { choice: { choiceId: "8-492823-101201303", parentName: "Elven Lineage", label: "High Elf Lineage" } } },
      species: { isLineage: true, fullRaceName: "High Elf" } } },
    ddb("noble", "Noble", "background", {}, { originalName: "Background: Noble" }),
  ]);
  // Race items carry no import stamp; only the features are translated here.
  delete actor.items.get("race").data.flags.ddbimporter.importId;
  const outcome = await applyActor(actor, await world(docs));
  const name = (id) => actor.items.get(id).data.name;
  assert.equal(name("repel"), "Отбрасывающий разряд [Repelling Blast]");
  assert.equal(name("fey"), "Наследие фей [Fey Ancestry]");
  assert.equal(name("lineage"), "Высший эльф [High Elf]");
  assert.equal(name("noble"), "Благородный [Noble]");
  assert.equal(name("warlock"), "Колдун [Warlock]");
  // The class keeps its English identity for later runs.
  assert.equal(actor.items.get("warlock").data.flags.ddbimporter.originalName, "Warlock");
  assert.equal(outcome.failed, 0);
});

test("equipment ignores pack copies, DDB subtypes and apostrophes, and falls back to the identifier", async () => {
  const docs = new Map([
    [uuid("equipment", "lamp"), ag("lamp", "Лампа", "Lamp", "consumable", { type: { value: "", subtype: "lamp" } })],
    [uuid("equipment", "lampcopy"), { ...ag("lampcopy", "Лампа", "Lamp", "consumable", { type: { value: "", subtype: "lamp" } }), system: { ...ag("x", "Лампа", "Lamp", "consumable").system, container: "pack" } }],
    [uuid("equipment", "cook"), ag("cook", "Инструменты повара", "Cook’s Utensils", "tool", { type: { value: "art" } })],
    [uuid("equipment", "leather"), ag("leather", "Кожаный доспех", "Leather Armor", "equipment", { identifier: "leather", type: { value: "light" } })],
  ]);
  const actor = actorWith([
    ddb("lamp", "Lamp", "consumable", { type: { value: "trinket", subtype: "" } }, { importId: "earlier" }),
    ddb("cook", "Cook's Utensils", "tool", { type: { value: "art" } }),
    ddb("leather", "Leather", "equipment", { identifier: "leather", type: { value: "light" } }),
  ]);
  await applyActor(actor, await world(docs));
  const name = (id) => actor.items.get(id).data.name;
  assert.equal(name("lamp"), "Лампа [Lamp]");
  assert.equal(name("cook"), "Инструменты повара [Cook’s Utensils]");
  assert.equal(name("leather"), "Кожаный доспех [Leather Armor]");
});

test("Free Rules 2024 items are PHB 2024 publications", () => {
  const key = { rules: "2024", source: "PHB 2024", sourceIds: [148, 1] };
  assert.equal(publicationContradicts(key), false);
  assert.equal(publicationContradicts({ ...key, sourceIds: [146] }), true);
});

test("links with a page anchor are validated without the anchor", async () => {
  const seen = [];
  const { resolver } = await world(new Map(), { links: (id) => (seen.push(id), !id.includes("#")) });
  const page = "Compendium.ag-fifthpendium.phb.JournalEntry.j.JournalEntryPage.p#anchor";
  const links = await resolver.validatedLinks({ value: `@UUID[${page}]{Глава}` });
  assert.ok(links.has(page));
  assert.deepEqual(seen, [page.split("#")[0]]);
});

test("safeText accepts AG presentation and lookups the item can resolve", () => {
  const before = "<p>English &amp;Reference[prone] text.</p>";
  const rollData = { scale: { warlock: { "invocations-known": { value: 3 } } }, item: { level: 1 } };
  const ok = (after, data = rollData) => safeText(before, after, { rollData: data });
  // Table layout, literal buttons, dropped glossary tooltips.
  assert.equal(ok('<table><col data-colwidth="231"></table><p>Русский [[/award 4GP]] [[/skill slt]]</p>'), true);
  // Roll-data lookups the actor defines.
  assert.equal(ok("<p>Русский [[lookup @scale.warlock.invocations-known]] [[@item.level]]</p>"), true);
  // An undefined scale, an AG module flag, or a macro stays refused.
  assert.equal(ok("<p>Русский [[lookup @scale.warlock.prepared-spells]]</p>"), false);
  assert.equal(ok("<p>Русский [[/r (@flags.ag-fifthpendium.x)d6]]</p>"), false);
  assert.equal(ok("<p>Русский [[lookup @scale.warlock.invocations-known]]</p>", null), false);
  assert.equal(ok("<p>Русский @Macro[Helper]</p>"), false);
  // A reference with options beyond `apply` must survive.
  assert.equal(safeText("<p>&Reference[prone apply=true extra=1]</p>", "<p>Русский</p>"), false);
  // A link to the DDB website is DDB presentation.
  assert.equal(safeText('<p><a href="https://www.dndbeyond.com/sources/x">x</a></p>', "<p>Русский</p>"), true);
});
