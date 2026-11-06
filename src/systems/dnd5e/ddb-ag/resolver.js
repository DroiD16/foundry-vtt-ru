import {canonicalName, canonicalPublication} from "./publications.js";
import {providerEnglishName, providerPresentationCompatible} from "./catalog.js";
import { PHYSICAL_KINDS, identity, matchEntry } from "./identity.js";

export function translationStyle(provider, settings) {
  if (provider === "ag-fifthpendium-ravenloft") return "ag";
  try {
    return settings.get("ag-fifthpendium", "compendiumTranslation") === "dndsu" ? "dndsu" : "ag";
  } catch {
    return "ag";
  }
}

export function redirectUuid(uuid, redirects = {}) {
  const seen = new Set();
  for (;;) {
    const prefix = Object.keys(redirects)
      .filter((key) => uuid === key || uuid.startsWith(`${key}.`))
      .sort((a, b) => b.length - a.length)[0];
    if (!prefix) break;
    if (seen.has(uuid) || seen.size > 100) throw new Error("uuid-redirect-cycle");
    seen.add(uuid);
    const target = redirects[prefix];
    if (typeof target !== "string") throw new Error("unsupported-uuid-redirect");
    uuid = target + uuid.slice(prefix.length);
  }
  return uuid;
}

export class Resolver {
  constructor({
    providers,
    modules,
    readUuid,
    redirects = {},
    settings,
    diagnostics = () => {},
    sources = {},
    anchors = {},
    roles = {},
    readNativeParents,
  }) {
    Object.assign(this, {
      providers,
      modules,
      readUuid,
      redirects,
      settings,
      diagnostics,
      sources,
    });
    this.roles = roles;
    this.readNativeParents = readNativeParents;
    this.cache = new Map();
    this.linkCache = new Map();
    this.byName = new Map();
    this.byUuid = new Map([
      ...Object.entries(anchors),
      ...providers.flatMap((p) => p.entries.map((e) => [e.uuid, e])),
    ]);
    for (const provider of providers)
      for (const entry of provider.entries) {
        if (/\.Actor\.[^.]+\.Item\./.test(entry.uuid ?? "") || (entry.matchStatus && entry.matchStatus !== "semantic-candidate")) continue;
        for (const name of new Set([entry.name, ...(entry.aliases ?? [])])) {
          if (!name) continue;
          if (!this.byName.has(name)) this.byName.set(name, []);
          this.byName.get(name).push({ provider, entry });
        }
      }
  }
  async prepareParents(parents) {
    if (!this.catalog) return;
    this.runGrants = new Map();
    const addGrant = (uuid, grant) => {
      if (!this.runGrants.has(uuid)) this.runGrants.set(uuid, []);
      this.runGrants.get(uuid).push(grant);
    };
    for (const key of parents.filter(p => ["class", "subclass", "race", "species", "background"].includes(p.kind))) {
      const source = this.canonicalSource(key.source, key.rules);
      let rows = (this.byName.get(key.name) ?? []).filter(({entry}) =>
        entry.compatible !== false && matchEntry({...key, source}, entry));
      // DDB and AG identifiers differ ("moon" vs "college-of-moon"); they only break ties.
      if (rows.length > 1) rows = rows.filter(({entry}) => !entry.identifier || entry.identifier === key.identifier);
      if (rows.length !== 1) continue;
      const {entry, provider} = rows[0];
      let doc;
      try {doc = await (this.cache.get(`full:${translationStyle(provider.id, this.settings)}:${entry.uuid}`) ?? this.readUuid(entry.uuid, {provider, style:translationStyle(provider.id, this.settings)}));}
      catch (error) {this.diagnostics({reason:`provider-read: ${error.message}`, name:key.name}); continue;}
      const data = doc?.toObject?.() ?? doc;
      const sourceNow = data?.system?.source;
      if (!data || data.type !== key.kind || providerEnglishName(data, {uuid:entry.uuid, provider:provider.id, style:translationStyle(provider.id, this.settings)}) !== entry.name ||
          sourceNow?.rules !== entry.rules || this.canonicalSource(sourceNow?.book, entry.rules) !== entry.source ||
          (entry.identifier && data.system?.identifier !== entry.identifier) ||
          (entry.classIdentifier && data.system?.classIdentifier !== entry.classIdentifier)) continue;
      this.cache.set(`full:${translationStyle(provider.id, this.settings)}:${entry.uuid}`, Promise.resolve(data));
      const advancements = Array.isArray(data.system?.advancement) ? data.system.advancement : Object.values(data.system?.advancement ?? {});
      for (const advancement of advancements) {
        if (!["ItemGrant", "ItemChoice"].includes(advancement.type)) continue;
        const config = advancement.configuration ?? {};
        for (const target of config.items ?? []) {
          const uuid = typeof target === "string" ? target : target.uuid;
          const child = this.byUuid.get(redirectUuid(uuid, this.redirects));
          if (!child) continue;
          addGrant(child.uuid, {uuid:entry.uuid, role:advancement.type, level:advancement.level});
        }
        // ItemChoice offers `pool`. Only class/race/background features need a proven grant;
        // standalone feats in a pool (origin feats, fighting styles) stay independently identifiable.
        const acquired = (child) => child.kind === "feat" && ["class", "race", "background"].includes(child.subtype);
        const pool = config.pool ?? [];
        for (const target of pool) {
          const uuid = typeof target === "string" ? target : target.uuid;
          const child = this.byUuid.get(redirectUuid(uuid, this.redirects));
          if (child && acquired(child)) addGrant(child.uuid, {uuid:entry.uuid, role:advancement.type, level:advancement.level});
        }
        const targets = [...(config.items ?? []), ...pool];
        // An open ItemChoice (Eldritch Invocations) offers every feat of a typed subtype.
        const restriction = config.restriction;
        if (advancement.type === "ItemChoice" && !targets.length && restriction?.subtype &&
            ["class", "race", "background"].includes(restriction.type))
          for (const provider of this.providers) for (const child of provider.entries)
            if (child.kind === "feat" && child.rules === entry.rules && child.subtype === restriction.type &&
                child.subtypeDetail === restriction.subtype)
              addGrant(child.uuid, {uuid:entry.uuid, role:advancement.type, level:advancement.level});
      }
    }
    // A subclass requires its typed class even when no advancement targets it.
    const classes = new Map();
    for (const provider of this.providers) for (const entry of provider.entries) if (entry.kind === "class" && entry.identifier) {
      if (!classes.has(entry.identifier)) classes.set(entry.identifier, []);
      classes.get(entry.identifier).push(entry);
    }
    for (const provider of this.providers) for (const entry of provider.entries) if (entry.kind === "subclass") {
      const matches = (classes.get(entry.classIdentifier) ?? []).filter(c => c.rules === entry.rules);
      if (matches.length === 1) addGrant(entry.uuid, {uuid:matches[0].uuid, role:"classIdentifier"});
    }
  }

  async resolve(data, context = {}) {
    if (context.kind === "RollTable" && !data.system?.source)
      return context.indexOnly ? null : this.resolveTable(data, context);
    let key = identity(data, context);
    if (!key) return this.skip("missing-identity", data);
    const publications = (this.sources.sources ?? []).filter(s => s.rules === key.rules &&
      (s.ddb.name === key.source || s.ag === key.source));
    if (publications.length && key.sourceIds.length && !publications.some(p => key.sourceIds.includes(p.ddb.id)))
      return this.skip("publication-contradiction", data);
    key.source = this.canonicalSource(key.source, key.rules);
    // Curated bindings keep DDB's own spelling ("Eldritch Invocations: Armor of Shadows").
    const ddbName = key.name;
    key.name = canonicalName(key);
    if (this.catalog?.incompatibleFor(key, context.kind === "Actor" ? "Actor" : "Item")) return this.skip("provider-incompatible", data);
    const bindingKey = {...key, name: ddbName};
    const subtypeBindings = (this.roles.subtypeBindings ?? []).filter(b => this.subtypeBindingMatches(data, bindingKey, b));
    const binding = [...(this.roles.bindings ?? []).filter((b) => this.bindingMatches(data, bindingKey, b)), ...subtypeBindings];
    const strictSubtype = subtypeBindings.length === 1;
    if (binding.length > 1) return this.skip("ambiguous-binding", data);
    if (binding.length)
      key = {
        ...key,
        name: binding[0].agName,
        kind: binding[0].kind ?? key.kind,
        // The complete, captured choice path proves this AG subtype even where DDB
        // leaves its optional display subtype empty. Conflicting explicit values fail.
        subtype: binding[0].sourceContext ? binding[0].context?.subtype : key.subtype,
        subtypeDetail: strictSubtype ? binding[0].context.subtypeDetail : key.subtypeDetail || binding[0].context?.subtypeDetail,
      };
    // Only active compatible providers participate in ambiguity detection.
    const actorRows = context.kind === "Actor" && data.type === "npc" && this.catalog
      ? this.catalog.actorCandidates({...key, english:key.name, publication:key.source})
          .map(entry => ({entry, provider:this.providers.find(p => p.id === entry.provider)}))
          .filter(row => row.provider)
      : null;
    let candidates = (actorRows ?? this.byName.get(key.name) ?? []).filter(({ entry }) =>
      (!this.catalog || binding.length || key.kind !== "feat" || !key.subtype || !entry.subtype || entry.subtype === key.subtype) &&
      matchEntry(key, { ...entry, source: this.canonicalSource(entry.source, entry.rules) }),
    );
    // Equipment named differently ("Leather" vs "Leather Armor") shares the dnd5e identifier.
    if (!candidates.length && !binding.length && !actorRows && PHYSICAL_KINDS.has(key.kind) && key.identifier)
      candidates = this.providers.flatMap((provider) => provider.entries
        .filter((entry) => entry.identifier === key.identifier &&
          matchEntry({ ...key, name: entry.name }, { ...entry, source: this.canonicalSource(entry.source, entry.rules) }))
        .map((entry) => ({ provider, entry })));
    const available = candidates.filter(({ provider, entry }) => {
      const installed = this.modules.get(provider.id);
      return (
        installed?.active && entry.compatible !== false &&
        provider.compatible !== false
      );
    });
    const contextual = [];
    for (const candidate of available)
      if (
        (!binding.length ||
          (candidate.entry.uuid === binding[0].uuid &&
            (strictSubtype
              ? ["subtype", "subtypeDetail"].every(field => (candidate.entry.context?.[field] ?? "") === binding[0].context[field])
              : Object.entries(binding[0].context ?? {}).filter(([field]) => field !== "grants").every(([field, value]) => (candidate.entry.context?.[field] ?? "") === value)))) &&
        (binding.length || (await this.parentMatches(key, candidate.entry, context)))
      )
        contextual.push(candidate);
    if (candidates.length && !available.length) return this.skip("provider-not-installed", data);
    const unique = [...new Map(contextual.map((c) => [c.entry.uuid, c])).values()];
    if (unique.length !== 1)
      return this.skip(unique.length ? "ambiguous-identity" : "no-exact-match", data);
    const { provider, entry } = unique[0];
    if (!this.modules.get(provider.id)?.active) return this.skip("provider-not-installed", data);
    const installed = this.modules.get(provider.id);

    const style = translationStyle(provider.id, this.settings);
    const cacheKey = `${context.indexOnly ? "index" : "full"}:${style}:${entry.uuid}`;
    try {
      if (!this.cache.has(cacheKey))
        this.cache.set(
          cacheKey,
          (async () => {
            for (const address of [entry.uuid, ...(entry.context?.uuidAliases ?? [])]) {
              const document = await this.readUuid(redirectUuid(address, this.redirects), {
                provider,
                style,
                indexOnly: Boolean(context.indexOnly),
              });
              if (document) return document;
            }
            return null;
          })(),
        );
      const document = await this.cache.get(cacheKey);
      const text = document?.toObject ? document.toObject() : document;
      const currentSource = text?.system?.source ?? text?.system?.details?.source;
      const source = key.kind === "RollTable" && context.provenTableSource
        ? { ...currentSource, book: currentSource?.book || context.provenTableSource.source,
            rules: currentSource?.rules || context.provenTableSource.rules }
        : currentSource;
      if (
        !text ||
        (text.type ?? context.kind) !== key.kind ||
        (source?.rules && source.rules !== key.rules)
      )
        return this.skip("provider-type-or-edition", data);
      const english = providerEnglishName(text, {uuid:entry.uuid, provider:provider.id, style});
      if (english !== entry.name && !(entry.aliases ?? []).includes(english))
        return this.skip("provider-label-changed", data);
      if (
        this.canonicalSource(source?.book, entry.rules) !==
          this.canonicalSource(entry.source, entry.rules) ||
        source?.rules !== entry.rules ||
        (entry.identifier && text.system?.identifier !== entry.identifier) ||
        Object.entries({
          subtype: text.system?.type?.value,
          subtypeDetail: text.system?.type?.subtype,
          classIdentifier: text.system?.classIdentifier,
        }).some(([field, value]) => entry.context?.[field] && entry.context[field] !== value) ||
        (strictSubtype && ["subtype", "subtypeDetail"].some(field => {
          const value = field === "subtype" ? text.system?.type?.value : text.system?.type?.subtype;
          return (value ?? "") !== binding[0].context[field];
        }))
      )
        return this.skip("provider-discriminators-changed", data);
      if (!providerPresentationCompatible(entry.uuid, entry.name, text.name))
        return this.skip("provider-presentation-numbers", data);
      return {
        entry,
        text,
        style,
        provider: provider.id,
        descriptionRoles: context.indexOnly ? [] : this.descriptionRoles(data, entry),
        rootData: data,
        rootText: text,
        rootEntry: entry,
        nativeRoot: Boolean(context.nativeRoot),
        childRoles: (this.roles.children ?? []).filter(
          (r) =>
            r.parent === entry.uuid &&
            data.type === "spell" &&
            String(data.flags.ddbimporter.definitionId) === String(r.ddb.definitionId),
        ),
        projectOptions: {
          validatedLinks: context.indexOnly ? new Set() : await this.validatedLinks(text),
          validatedReferences: context.indexOnly ? new Set() : await this.validatedReferences(text),
        },
        match: entry.ddb ? "catalog-pair" : "exact-semantic",
      };
    } catch (error) {
      this.cache.delete(cacheKey);
      return this.skip(`provider-read: ${error.message}`, data);
    }
  }
  descriptionRoles(data, entry) {
    const key = identity(data), f = data.flags?.ddbimporter;
    if (!key) return [];
    return (this.roles.descriptionRoles ?? []).filter(row => {
      if (row.parent !== entry.uuid || row.name !== key.name || row.rules !== key.rules ||
          row.source !== this.canonicalSource(key.source, key.rules) || !key.sourceIds.includes(row.sourceId)) return false;
      const publication = (this.sources.sources ?? []).some(s => s.rules === row.rules &&
        s.ddb.id === row.sourceId && this.canonicalSource(s.ag, s.rules) === row.source);
      if (!publication) return false;
      if (row.ddb.namespace === "equipment") return data.type === entry.kind && !["npc", "character"].includes(data.type) &&
        f.definitionId === row.ddb.definitionId && f.definitionEntityTypeId === row.ddb.definitionEntityTypeId;
      if (row.ddb.namespace === "monster") return data.type === "npc" &&
        f.id === row.ddb.definitionId && f.entityTypeId === row.ddb.definitionEntityTypeId;
      return row.ddb.namespace === "spell" && data.type === "spell" && f.definitionId === row.ddb.definitionId;
    }).map(row => ({ ...row, books: [...new Set((this.sources.sources ?? []).filter(s =>
      s.rules === row.rules && s.ddb.id === row.sourceId && this.canonicalSource(s.ag, s.rules) === row.source)
      .flatMap(s => [s.ag, s.ddb.name]))] }));
  }
  subtypeBindingMatches(data, key, binding) {
    const f = data.flags?.ddbimporter, ddb = binding.ddb;
    const publication = (this.sources.sources ?? []).find(s => s.rules === binding.rules &&
      this.canonicalSource(s.ag, s.rules) === binding.source && s.ddb.id === binding.sourceId);
    return Boolean(publication && ddb?.namespace === "equipment" &&
      Number.isSafeInteger(f?.definitionId) && f.definitionId > 0 &&
      Number.isSafeInteger(f?.definitionEntityTypeId) && f.definitionEntityTypeId > 0 &&
      f.definitionId === ddb.definitionId && f.definitionEntityTypeId === ddb.definitionEntityTypeId &&
      data.type === binding.kind && key.name === binding.originalName && key.rules === binding.rules &&
      key.source === binding.source && key.sourceIds.includes(binding.sourceId) &&
      typeof binding.sourceContext?.subtype === "string" && binding.sourceContext.subtype &&
      typeof binding.sourceContext.subtypeDetail === "string" &&
      typeof binding.context?.subtype === "string" && binding.context.subtype &&
      typeof binding.context.subtypeDetail === "string" &&
      key.subtype === binding.sourceContext.subtype && (key.subtypeDetail ?? "") === binding.sourceContext.subtypeDetail);
  }
  bindingMatches(data, key, binding) {
    if (
      key.name !== binding.originalName ||
      key.source !== binding.source ||
      key.rules !== binding.rules
    )
      return false;
    if (
      binding.sourceContext &&
      Object.entries(binding.sourceContext).some(([k, v]) => key[k] !== v)
    )
      return false;
    const f = data.flags.ddbimporter,
      ddb = binding.ddb;
    if (ddb.namespace === "class-feature-choice-path") {
      const choice = f.dndbeyond?.choice;
      return (
        data.type === "feat" &&
        f.id === ddb.parentDefinitionId &&
        f.entityTypeId === ddb.parentDefinitionEntityTypeId &&
        f.dndbeyond?.classId === ddb.classDefinitionId &&
        choice &&
        (!choice.optionId || ddb.optionIds.includes(choice.optionId)) &&
        Object.entries(ddb.choicePath).every(([k, v]) => (choice[k] ?? null) === v)
      );
    }
    return (
      data.type === ddb.namespace &&
      (f.definitionId ?? f.id) === ddb.definitionId &&
      (f.definitionEntityTypeId ?? f.entityTypeId) === ddb.definitionEntityTypeId
    );
  }
  documentLinks(data) {
    return [...JSON.stringify(data).matchAll(/@(?:UUID|Embed|RollTable)\[([^\] ]+)/g)].map(
      (m) => m[1],
    );
  }
  async resolveTable(data, context) {
    if (!this.readNativeParents) return this.skip("missing-table-parent-read", data);
    const flags = data.flags?.ddbimporter;
    const rows = (this.roles.tables ?? []).filter(
      (r) =>
        r.name === data.name &&
        r.parentName === flags?.parentName &&
        JSON.stringify(r.keys) === JSON.stringify(flags?.keys),
    );
    const survivors = [];
    for (const row of rows) {
      const parents = await this.readNativeParents(row.parent);
      const tableUuid = `Compendium.${context.pack}.RollTable.${data._id}`;
      for (const parent of parents) {
        const key = identity(parent);
        if (!key || !matchEntry(key, row.parent)) continue;
        if (!this.documentLinks(parent).includes(tableUuid)) continue;
        const matchedParent = await this.resolve(parent);
        if (
          !matchedParent ||
          matchedParent.entry.uuid !== row.parent.uuid ||
          !this.documentLinks(matchedParent.text).includes(row.uuid)
        )
          continue;
        const descriptor = this.byUuid.get(row.uuid);
        if (!descriptor) {
          const provider = this.providers.find((p) => row.uuid.startsWith(`Compendium.${p.id}.`));
          const installed = provider && this.modules.get(provider.id);
          if (!installed?.active)
            continue;
          const style = translationStyle(provider.id, this.settings);
          const document = await this.readUuid(row.uuid, { provider, style });
          const text = document?.toObject?.() ?? document;
          if (
            !text ||
            (text.type && text.type !== "RollTable") ||
            (text.system?.source?.book && this.canonicalSource(text.system.source.book, row.parent.rules) !== this.canonicalSource(matchedParent.entry.source, row.parent.rules)) ||
            (text.system?.source?.rules && text.system.source.rules !== matchedParent.entry.rules)
          )
            continue;
          survivors.push({
            entry: {
              kind: "RollTable",
              name: row.name,
              source: row.parent.source,
              rules: row.parent.rules,
              uuid: row.uuid,
            },
            text,
            style,
            provider: provider.id,
            projectOptions: {
              validatedLinks: await this.validatedLinks(text),
              validatedReferences: await this.validatedReferences(text),
            },
          });
          break;
        }
        const probe = {
          ...data,
          type: "RollTable",
          name: descriptor.name,
          flags: { ...data.flags, ddbimporter: { ...flags, originalName: descriptor.name } },
          system: { source: { book: descriptor.source, rules: descriptor.rules } },
        };
        const match = await this.resolve(probe, { ...context, kind: "RollTable", provenTableSource: matchedParent.entry });
        if (match) survivors.push(match);
        break;
      }
    }
    const unique = [...new Map(survivors.map((m) => [m.entry.uuid, m])).values()];
    return unique.length === 1 ? unique[0] : this.skip("ambiguous-or-unproven-table", data);
  }
  canonicalSource(book, rules) {
    const canonical = canonicalPublication(book, rules);
    if (canonical) return canonical;
    const publication = (this.sources.sources ?? []).find(
      (s) => s.rules === rules && (s.ag === book || s.ddb?.name === book),
    );
    if (publication)
      return this.sources.sources.find(
        (s) =>
          s.rules === publication.rules &&
          s.ddb.id === publication.ddb.id &&
          s.ddb.name === publication.ddb.name,
      ).ag;
    const aliases = this.sources.aliases ?? [];
    const row = aliases.find(
      (a) => a.rules === rules && (a.canonical === book || a.aliases?.includes(book)),
    );
    return row?.canonical ?? book;
  }
  async parentDescriptor(uuid, indexOnly = false) {
    if (this.byUuid.has(uuid)) return this.byUuid.get(uuid);
    const provider = this.providers.find((p) => uuid.startsWith(`Compendium.${p.id}.`));
    const installed = provider && this.modules.get(provider.id);
    if (
      !installed?.active || provider.compatible === false
    )
      return null;
    const doc = await this.readUuid(redirectUuid(uuid, this.redirects), {
      provider,
      style: translationStyle(provider.id, this.settings),
      indexOnly,
    });
    const d = doc?.toObject?.() ?? doc;
    const name = d && providerEnglishName(d, {uuid, provider:provider.id, style:translationStyle(provider.id, this.settings)});
    if (
      !name ||
      !d.type ||
      !d.system?.source?.book ||
      !["2014", "2024"].includes(d.system?.source?.rules)
    )
      return null;
    return {
      kind: d.type,
      name,
      source: d.system.source.book,
      rules: d.system.source.rules,
      classIdentifier: d.system.classIdentifier,
    };
  }
  async parentMatches(key, entry, context, seen = new Set()) {
    if (seen.has(entry)) return false;
    seen = new Set([...seen, entry]);
    const contexts = [...(context.parents ?? [])];
    if (key.parent)
      contexts.push({
        kind: "class",
        name: key.parent,
        rules: key.rules,
        source: key.source,
        level: key.requiredLevel,
      });
    const matches = async (uuid, grant) => {
      const parent = await this.parentDescriptor(uuid, Boolean(context.indexOnly));
      if (!parent || parent.rules !== key.rules) return false;
      for (const p of contexts) {
        if (
          p.kind !== parent.kind ||
          p.rules !== parent.rules ||
          this.canonicalSource(p.source, p.rules) !==
            this.canonicalSource(parent.source, parent.rules)
        )
          continue;
        if (p.name !== parent.name) continue;
        if (
          parent.kind === "subclass" && parent.classIdentifier &&
          p.classIdentifier !== parent.classIdentifier &&
          p.identifier !== parent.classIdentifier
        )
          continue;
        if (grant && p.role && p.role !== grant.role) continue;
        if (grant?.level != null && !(Number(grant.level) === 0 && ["background", "race", "species"].includes(p.kind)) && (p.level == null || Number(p.level) < Number(grant.level)))
          continue;
        if (grant?.role === "ItemChoice" && !key.choice) continue;
        if (
          grant &&
          !["ItemGrant", "ItemChoice", "classIdentifier", "AbilityScoreImprovement"].includes(
            grant.role,
          )
        )
          continue;
        if (await this.parentMatches(p, parent, context, seen)) return true;
      }
      return false;
    };
    if (entry.parent && !(await matches(entry.parent))) return false;
    const grants = this.catalog ? (this.runGrants?.get(entry.uuid) ?? []) : (entry.context?.grants ?? entry.parents ?? entry.context?.grantParents ?? []);
    // Reverse grants describe acquisition, not containment. Standalone spells/items remain
    // independently identifiable. Class features need one proven acquisition context.
    if (!grants.length && this.catalog && entry.kind === "feat" && ["class", "race", "background"].some(t => t === entry.subtype || t === key.subtype)) return false;
    if (!grants.length || !["feat", "subclass"].includes(entry.kind)) return true;
    for (const grant of grants) if (await matches(grant.uuid, grant)) return true;
    return false;
  }
  readLink(uuid) {
    if (!this.linkCache.has(uuid)) this.linkCache.set(uuid, Promise.resolve().then(() => this.readUuid(uuid, {linkOnly:true})));
    return this.linkCache.get(uuid);
  }
  async validatedReferences(text) {
    const valid = new Set();
    const config = globalThis.CONFIG?.DND5E;
    if (!config?.ruleTypes) return valid;
    const decoded = JSON.stringify(text).replace(/&amp;|&#0*38;|&#x0*26;/gi, "&");
    for (const [, input] of decoded.matchAll(/(?:&|@)Reference\[([^\]]+)\]/gi)) {
      const parts = input.split(/\s+/),
        first = parts.shift();
      const explicit = first.split("=");
      const slug = explicit
        .at(-1)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
      for (const [type, rule] of Object.entries(config.ruleTypes)) {
        if (explicit.length > 1 && type !== explicit[0]) continue;
        const source = rule.references?.split(".").reduce((v, k) => v?.[k], config)?.[slug];
        const uuid = typeof source === "string" ? source : source?.reference;
        if (!uuid) continue;
        if (parts.some((p) => !["apply=false", "apply=true"].includes(p))) continue;
        try {
          if (await this.readLink(redirectUuid(uuid, this.redirects))) {
            valid.add(input);
            valid.add(
              input.replace(/apply=true/g, "apply=false") +
                (parts.some((p) => p.startsWith("apply=")) ? "" : " apply=false"),
            );
          }
        } catch {
          /* unavailable rule */
        }
      }
    }
    return valid;
  }
  async validatedLinks(text) {
    const links = new Set();
    const strings = JSON.stringify(text);
    for (const [, uuid] of strings.matchAll(/@(?:UUID|Embed)\[([^\] ]+)/g)) {
      try {
        // Foundry's parseUuid keeps "#anchor" in the embedded id; the enricher strips it.
        const target = redirectUuid(uuid.split("#")[0], this.redirects);
        if (!target.startsWith("Compendium.ag-") && !target.startsWith("Compendium.dnd5e."))
          continue;
        if (await this.readLink(target)) links.add(uuid);
      } catch {
        /* Unavailable link: the projector keeps the original field. */
      }
    }
    return links;
  }
  skip(reason, data) {
    this.diagnostics({ reason, name: data.name });
    return null;
  }
}
