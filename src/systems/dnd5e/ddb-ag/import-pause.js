import { get, set } from "./projector.js";

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function leaves(value, prefix = "", out = {}) {
  if (value && typeof value === "object" && Object.keys(value).length) {
    for (const [key, child] of Object.entries(value))
      leaves(child, prefix ? `${prefix}.${key}` : key, out);
  } else if (prefix) out[prefix] = value;
  return out;
}

// One controller for the display runtime. No state is borrowed from DDBRunContext.
export function createImportPause({ packs, refresh = () => {} }) {
  let count = 0;
  const rows = new Map();
  function redraw(pack) {
    for (const app of Object.values(pack.apps ?? {})) {
      try {
        Promise.resolve(app.render?.(false)).catch(() => {});
      } catch {
        /* display only */
      }
    }
  }
  function remember(pack, raw, localized) {
    let records = rows.get(pack);
    if (!records) rows.set(pack, (records = new Map()));
    const paths = Object.fromEntries(
      Object.entries(leaves(localized)).filter(([p, v]) => !equal(v, get(raw, p))),
    );
    const previous = records.get(raw._id);
    // Index reads may carry only names. Keep document paths for indexDocument.
    const record = previous ?? { raw: {}, ru: {}, metadata: {} };
    for (const [p, v] of Object.entries(leaves(raw))) {
      if (!(p in paths)) record.metadata[p] = structuredClone(v);
    }
    for (const [p, v] of Object.entries(paths)) {
      record.raw[p] = structuredClone(get(raw, p));
      record.ru[p] = structuredClone(v);
      delete record.metadata[p];
    }
    records.set(raw._id, record);
  }
  function evict(pack) {
    for (const id of [...pack.keys()]) {
      const row = pack.index.get(id);
      pack.delete(id); // Collection cache removal, never Document.delete / database.delete.
      if (row) pack.index.set(id, row);
    }
  }
  function switchRows(display) {
    for (const pack of packs()) {
      evict(pack); // includes documents retained by open sheets
      for (const [id, row] of pack.index.entries()) {
        const rec = rows.get(pack)?.get(id);
        if (!rec) continue;
        const current = leaves(row);
        // A native write changed identity or raw text. Never resurrect an old view.
        const stale = Object.entries(current).some(([p, v]) =>
          p in rec.ru
            ? !equal(v, rec.raw[p]) && !equal(v, rec.ru[p])
            : p in rec.metadata && !equal(v, rec.metadata[p]),
        );
        const next = structuredClone(row);
        for (const p of Object.keys(rec.ru)) {
          if (!(p in current)) continue;
          if (!display && equal(current[p], rec.ru[p])) set(next, p, structuredClone(rec.raw[p]));
          if (display && !stale && equal(current[p], rec.raw[p]))
            set(next, p, structuredClone(rec.ru[p]));
        }
        pack.index.set(id, next); // retain Collection identity, replace row identity
        if (stale) rows.get(pack).delete(id);
      }
      redraw(pack);
    }
  }
  function acquire() {
    if (count++ === 0) {
      switchRows(false);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--count === 0) {
        switchRows(true);
        // The caller checks active again after its final await.
        Promise.resolve()
          .then(refresh)
          .catch((error) => console.warn("ru-ru DDB index", error));
      }
    };
  }
  async function bracket(fn) {
    const release = acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
  function holds() {
    const held = new WeakMap();
    return {
      acquire(key) {
        if (!held.has(key)) held.set(key, acquire());
      },
      release(key) {
        const end = held.get(key);
        held.delete(key);
        end?.();
      },
    };
  }
  return {
    get active() {
      return count > 0;
    },
    get count() {
      return count;
    },
    remember,
    reset() {
      switchRows(false);
      rows.clear();
    },
    acquire,
    bracket,
    holds,
  };
}

export function installImportEntrypoints({
  pause,
  game,
  Hooks,
  libWrapper,
  notice,
}) {
  const root = globalThis.DDBImporter;
  const paths = [
    "debug.lib.DDBRunContext.runWith",
    "debug.lib.DDBToolProficiencies.syncCompendiumItems",
  ];
  if (
    !game.modules.get("ddb-importer")?.active ||
    typeof libWrapper?.register !== "function" ||
    paths.some((p) => typeof get(root, p) !== "function")
  )
    return false;
  // Register S4 synchronously before projection, including DDB's ready background call.
  for (const path of [paths[1], paths[0]]) {
    libWrapper.register(
      "ru-ru",
      `DDBImporter.${path}`,
      function (wrapped, ...args) {
        return pause.bracket(() => wrapped(...args));
      },
      "WRAPPER",
    );
  }
  const munch = pause.holds(),
    patched = new WeakSet();
  Hooks.on("renderDDBMuncher", (app) => {
    const proto = app.constructor.prototype;
    if (patched.has(proto)) return;
    if (["_disableButtons", "_enableButtons"].some((p) => typeof proto[p] !== "function")) {
      // An unexpected private capability cannot safely resume display until reload.
      pause.acquire();
      notice(
        "DDB: методы muncher изменились. Компендиумы останутся на английском до перезагрузки.",
      );
      return;
    }
    patched.add(proto);
    for (const [key, start] of [
      ["_disableButtons", true],
      ["_enableButtons", false],
    ]) {
      const original = proto[key];
      proto[key] = function (...args) {
        if (start) munch.acquire(this);
        try {
          return original.apply(this, args);
        } finally {
          if (!start) munch.release(this);
        }
      };
    }
  });
  return true;
}
