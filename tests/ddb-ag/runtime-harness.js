// Native entrypoint fixtures for exercising the actual integrated ready callback.
export function prepareRuntimeEnvironment(catalogs = []) {
  game.modules.set("ddb-importer", { active: true, version: "7.6.0" });
  const noop = async () => {};
  globalThis.DDBImporter = {
    debug: {
      lib: {
        DDBRunContext: { runWith: noop },
        DDBToolProficiencies: { syncCompendiumItems: noop },
      },
    },
    importCharacter: noop,
    importCharacterById: noop,
    updateAllPCs: { foundry: noop },
    parse: { monsters: noop, items: noop, spells: noop, vehicles: noop },
    updateWorldMonsters: noop,
  };
  for (const [id, pack] of game.packs) {
    pack.collection = id;
    pack.metadata ??= id.startsWith("ag-")
      ? { packageName: id.split(".")[0] }
      : { flags: { ddbimporter: { schema: 1 } } };
    pack.index ??= new Map();
    pack.keys ??= () => [][Symbol.iterator]();
    pack.getIndex ??= async () => pack.index;
    pack.documentName ??= "Item";
  }
  const register = libWrapper.register;
  libWrapper.register = (id, target, fn, type) => {
    if (target === "CONFIG.DatabaseBackend._getDocuments") return register(id, target, fn, type);
  };
  for (const provider of catalogs.flatMap((c) => c.providers)) {
    for (const entry of provider.entries) {
      const parts = entry.uuid.split(".");
      if (parts.length !== 5) continue;
      const id = parts.slice(1, 3).join(".");
      if (!game.packs.has(id))
        game.packs.set(id, {
          collection: id,
          documentName: parts[3],
          metadata: { packageName: provider.id },
          index: new Map(),
          getIndex: async function () {
            return this.index;
          },
        });
      const pack = game.packs.get(id);
      if (!pack.index.has(parts[4]))
        pack.index.set(parts[4], {
          _id: parts[4],
          type: entry.kind,
          name: entry.name,
          flags: { babele: { originalName: entry.name } },
          system: {
            source: { book: entry.source, rules: entry.rules },
            type: { value: entry.context?.subtype },
            identifier: entry.identifier,
            classIdentifier: entry.context?.classIdentifier,
          },
        });
    }
  }
}
