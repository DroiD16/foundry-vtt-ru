// Used only by the main AG 2024 pack mappings. Release and migrated data use
// different advancement containers; retain the caller's shape and mechanics.
export function translateAdvancement(value, translations) {
  if (!value || typeof value !== "object" || !translations) return value;
  const translate = (entry, key) => {
    const text = translations[entry._id ?? key];
    if (!text) return entry;
    const result = { ...entry };
    for (const field of ["title", "hint"]) {
      if (typeof entry[field] === "string" && typeof text[field] === "string") {
        result[field] = text[field];
      }
    }
    return result;
  };
  return Array.isArray(value)
    ? value.map(translate)
    : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, translate(entry, key)]));
}

// Legacy ZIP changes acquire fresh IDs during Foundry migration. Property keys
// provide a stable fallback for their explicitly translated display values.
export function translateEffectChanges(value, translations) {
  if (!Array.isArray(value) || !translations) return value;
  const displayKeys = new Set([
    "name",
    "system.description.value",
    "system.unidentified.name",
    "system.unidentified.description",
    "activities[attack].description.chatFlavor",
    "system.traits.languages.custom",
    "system.attributes.senses.special",
  ]);
  return value.map((entry) => {
    const text = translations[entry._id] ?? translations[entry.key];
    if (
      entry.key === "system.target" &&
      typeof text?.targetSpecial === "string" &&
      typeof entry.value?.affects?.special === "string"
    ) {
      return {
        ...entry,
        value: {
          ...entry.value,
          affects: {
            ...entry.value.affects,
            special: text.targetSpecial,
          },
        },
      };
    }
    if (!displayKeys.has(entry.key) || typeof text?.value !== "string") return entry;
    return { ...entry, value: text.value };
  });
}

// Babele prunes objects recursively, but treats embedded arrays atomically.
// A partial local effect override can therefore restore its English siblings
// over an exact-source translation. Fill only unchanged leaves from that same
// source, retaining the actor's array order, IDs and local mechanical values.
export const actorItemsConverter = {
  translate(context) {
    const converter =
      context.contextCompendium.documentMappings.converterRegistry.named("document");
    const translated = converter.translate(context);
    const runtime =
      typeof context.runtime.runtime === "function" ? context.runtime.runtime() : context.runtime;
    return translated.map((item, index) => {
      const source = context.value[index];
      const uuid = source.flags?.core?.sourceId ?? source._stats?.compendiumSource;
      const match = uuid?.match(/^Compendium\.([^.]+\.[^.]+)\.(?:Item\.)?([^.]+)$/);
      const pack = match && runtime.mappedCompendiumFor(match[1]);

      // Embedded compendium and world references are not canonical pack Items.
      // A cold cache can also return only an index row. Never require hydration
      // or allow resolver exceptions to abort translation of the whole Actor.
      let canonical = null;
      if (match) {
        try {
          canonical = globalThis.fromUuidSync?.(uuid, { strict: false }) ?? null;
        } catch {
          canonical = null;
        }
      }
      const canonicalSource = canonical?.toObject ? canonical.toObject() : canonical;
      const hasFallback = pack?.hasTranslation(
        canonicalSource ?? { ...source, _id: match[2] },
        "Item",
      );
      const fallback = hasFallback
        ? pack.translate(canonicalSource ?? { ...source, _id: match[2] }, false, runtime)
        : source;
      const fill = (original, result, inherited, canonicalEnglish) => {
        if (Array.isArray(original)) {
          return result.map((child, position) => {
            const before =
              original.find((entry) => entry?._id && entry._id === child?._id) ??
              original[position];
            const base =
              inherited?.find?.((entry) => entry?._id && entry._id === child?._id) ??
              inherited?.[position];
            const english =
              canonicalEnglish?.find?.((entry) => entry?._id && entry._id === child?._id) ??
              canonicalEnglish?.[position];
            return fill(before, child, base, english);
          });
        }
        if (original && typeof original === "object" && result && typeof result === "object") {
          return Object.fromEntries(
            Object.entries(result).map(([key, child]) => [
              key,
              fill(original[key], child, inherited?.[key], canonicalEnglish?.[key]),
            ]),
          );
        }
        // A canonical translation cannot stand in for different local rules.
        // Restore that release leaf; an explicit local translation is applied below.
        if (
          typeof original === "string" &&
          typeof canonicalEnglish === "string" &&
          original !== canonicalEnglish
        )
          return original;
        return typeof original === "string" &&
          original === canonicalEnglish &&
          result === original &&
          typeof inherited === "string"
          ? inherited
          : result;
      };
      const result = fill(source, item, fallback, canonicalSource ?? source);
      result._id = source._id;
      const local = context.translation?.[source._id];
      if (!local) {
        if (
          source.type === "weapon" &&
          typeof canonicalSource?.system?.description?.value !== "string" &&
          /\[\[\/attack\b/.test(source.system?.description?.value ?? "") &&
          /\[\[\/damage\b/.test(source.system?.description?.value ?? "")
        ) {
          result.system.description.value = source.system.description.value;
        }
        return result;
      }
      const payload = context.contextCompendium.documentMappings
        .mappingFor("Item", context.params.mapping)
        .map(source, local, runtime);
      // Explicit local display leaves win; unchanged siblings in document
      // converter arrays must not replace inherited translations.
      const apply = (before, current, override) => {
        if (Array.isArray(current))
          return current.map((child, position) => {
            const original =
              before?.find?.((entry) => entry?._id && entry._id === child?._id) ??
              before?.[position];
            const text =
              override?.find?.((entry) => entry?._id && entry._id === child?._id) ??
              override?.[position];
            return apply(original, child, text);
          });
        if (current && typeof current === "object")
          return Object.fromEntries(
            Object.entries(current).map(([key, child]) => [
              key,
              key === "_id" ? child : apply(before?.[key], child, override?.[key]),
            ]),
          );
        return typeof override === "string" && override !== before ? override : current;
      };
      const output = apply(source, result, payload);
      // Without canonical English, retain the local native attack/damage
      // presentation rather than substituting generic equipment properties.
      if (
        source.type === "weapon" &&
        typeof canonicalSource?.system?.description?.value !== "string" &&
        /\[\[\/attack\b/.test(source.system?.description?.value ?? "") &&
        /\[\[\/damage\b/.test(source.system?.description?.value ?? "") &&
        typeof local.description !== "string"
      )
        output.system.description.value = source.system.description.value;
      return output;
    });
  },
  extract(context) {
    return context.contextCompendium.documentMappings.converterRegistry
      .named("document")
      .extract(context);
  },
};

// Structured singleton conversion retains untranslated siblings. Return only
// changed leaves so it cannot overwrite the separate biography mapping.
export const actorDetailsConverter = {
  translate(context) {
    const converted = context.contextCompendium.documentMappings.converterRegistry
      .named("structured")
      .translate(context);
    const prune = (before, after) => {
      if (JSON.stringify(before) === JSON.stringify(after)) return undefined;
      if (!after || typeof after !== "object" || Array.isArray(after)) return after;
      return Object.fromEntries(
        Object.entries(after)
          .map(([key, value]) => [key, prune(before?.[key], value)])
          .filter(([, value]) => value !== undefined),
      );
    };
    return prune(context.value, converted);
  },
};
