import { presentationEqual } from "./presentation.js";
import { matchesDescriptionRole } from "./description-roles.js";

// This whitelist is deliberately independent of Babele's generic object mappings.
const paths = [
  "system.description.value",
  "system.description.chat",
  "system.description.unidentified",
  "system.details.biography.value",
  "description",
];
export const get = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
export function set(object, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  for (const key of keys) object = object[key] ??= {};
  object[last] = value;
}
// Known automation keys; effect/activity names are always retained unless a contextual supplement explicitly permits them.
const protectedNames = new Set([
  "Hunter's Mark",
  "Hex",
  "Moonbeam",
  "Spirit Guardians",
  "Bless",
  "Bane",
  "Rage",
  "Sneak Attack",
  "Wild Shape",
  "Concentration",
  "Monk's Focus",
  "Sorcery Points",
  "Mighty Summoner",
  "Arcane Ward",
  "Improved Circle Forms",
  "Lunar Form",
  "Blighted Shape",
  "Apex Predator",
  "Antimagic Susceptibility",
  "Tokens of the Departed",
  "Poison Splash",
  "Regeneration",
  "Tentacles",
  "Deathly Choir",
  "Warding Bond",
  "Vestige Companion (Celestial)",
  "Vestige Companion (Fiend)",
  "Vestige Companion (Undead)",
  "Armor of Agathys",
  "Eye Rays",
  "Multiattack",
  // midi-qol checkMagicResistance finds this feat by its untranslated name.
  "Magic Resistance",
]);
// Literal BehaviorHelper activityName consumers in the current DDB support profile.
const protectedActivityNames = new Set([
  "Activate Carpet",
  "Activate Miasma",
  "Activate Snapfrost",
  "Activate Sword",
  "Astral Caltrops Save",
  "Aura Damage",
  "Aura Save",
  "Aura of Cold Damage",
  "Aura of Retribution Damage",
  "Babbling Save",
  "Ball Bearings Save",
  "Bear Trap: Damage",
  "Become Goat",
  "Blinding Glory",
  "Blizzard Save",
  "Bolstering Whispers",
  "Boon of Beleth Save",
  "Branches of the Tree",
  "Bubbles Burst Save",
  "Call Swarm of Rats",
  "Caltrooze Save",
  "Caltrops Save",
  "Corrosive Haze Save",
  "Create Golem",
  "Create Whip",
  "Crown Damage",
  "Damage",
  "Diamond Light Damage",
  "Disruption Save",
  "Draw Card",
  "Dust Vortex Drift",
  "Dust Vortex Save",
  "End of Turn Save vs Damage",
  "Entropic Radiance Damage",
  "Eruption",
  "Fear Aura Save",
  "Force Save",
  "Frigid Air Save",
  "Gravity Well: Damage",
  "Halo of Spores",
  "Healing Light",
  "Hellfire Damage",
  "Inner Radiance Damage",
  "Invoke Rune",
  "King of All: Enticement",
  "Lifesink Damage",
  "Lightning Save",
  "Maddening Whispers",
  "Mist Damage",
  "Movement Damage",
  "Nature's Wrath",
  "Noxious Gas Save",
  "Ongoing Damage",
  "Ongoing Heal",
  "Ongoing Save",
  "Ooze Save",
  "Pull and Throw",
  "Pulled Back Save",
  "Reaping Curse",
  "Release Creature",
  "Ring Save",
  "Sacrificial Flame Damage",
  "Sandstorm Save",
  "Sapphire Blindsight Damage",
  "Save to Travel Through Wall",
  "Save vs Damage",
  "Save vs Damage and Deafness",
  "Save vs Spore Damage",
  "Searing Light",
  "Shadow Smoke: Obscured",
  "Sickening Vapors Save",
  "Slick Ice Save",
  "Slip Save",
  "Start of Turn Damage",
  "Summon Dust Mephits",
  "Summon Elemental",
  "Summon Vermin",
  "Summon Warriors",
  "Telekinetic Seal",
  "Temp HP",
  "Thunderstruck",
  "Transform into Snake",
  "Turn End Damage",
  "Unfold Boat",
  "Unholy Aura Damage",
  "Valorous Stride",
  "Venomous Aura: Poison",
  "Vilesmog Exposure",
  "Voices of the Damned Save",
  "Volcanic Ground Save",
  "Wall Damage",
  "War Oil Slip Save",
]);
// A string, or any nested string, with visible content.
const hasText = (value) =>
  typeof value === "string"
    ? value.trim() !== ""
    : Array.isArray(value)
      ? value.some(hasText)
      : Boolean(value) && typeof value === "object" && Object.values(value).some(hasText);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Modules whose flags are scripted automation. Any content blocks renaming.
const scriptedFlagModules = ["chris-premades", "gambits-premades", "itemacro", "effectmacro"];
// Flags that never hold item references and are not collected as automation text.
// `species` is DDB Importer race metadata (baseName, fullRaceName, groupName).
const identityFlagModules = new Set(["ddbimporter", "species", "babele", "core", "ru-ru"]);
// Effect change keys handled by modules that never look an item up by name.
const inertMacroChange = /^macro\.(?:CE|CUB|tokenMagic|StatusEffect)$/i;
const collect = (value, out) => {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collect(v, out);
  return out;
};
const collectFlags = (flags, out) => {
  for (const [key, value] of Object.entries(flags ?? {})) if (!identityFlagModules.has(key)) collect(value, out);
  return out;
};
// Strings automation reads at runtime: module flags, effect changes and flags,
// activity macros and midi-qol conditions. midi-qol finds items by name from any
// of them (`ItemMacro.<Name>`, `ItemUses.<Name>`, `ActivityUses.<Name>.<Activity>`,
// `actor.items.getName(...)`), including from a different item on the same actor.
export function automationStrings(data) {
  const out = collectFlags(data?.flags, []);
  for (const effect of Array.isArray(data?.effects) ? data.effects : []) {
    if (!effect) continue;
    collectFlags(effect.flags, out);
    // A `name` change is an enchantment label such as "{} (True Strike)", not a lookup.
    // Inert macro changes carry condition names ("Dodge"), not item lookups.
    for (const change of Array.isArray(effect.changes) ? effect.changes : [])
      if (change && change.key !== "name" && !inertMacroChange.test(change.key ?? "")) collect(change.value, out);
  }
  for (const activity of Object.values(data?.system?.activities ?? {})) {
    if (!activity || typeof activity !== "object") continue;
    collectFlags(activity.flags, out);
    for (const key of ["macro", "macroData", "midiProperties", "useConditionText", "effectConditionText"])
      collect(activity[key], out);
  }
  return out;
}
// Scripted automation on the item itself blocks renaming even without a visible name.
function scriptedAutomation(data) {
  const flags = data.flags ?? {};
  const midi = flags["midi-qol"] ?? {};
  if (hasText(midi.onUseMacroName) || hasText(midi.onUseMacroParts)) return true;
  if (hasText(flags.dae?.macro)) return true;
  if (scriptedFlagModules.some((key) => hasText(flags[key]))) return true;
  for (const effect of Array.isArray(data.effects) ? data.effects : []) {
    if (!effect) continue;
    if (scriptedFlagModules.some((key) => hasText(effect.flags?.[key]))) return true;
    if ((Array.isArray(effect.changes) ? effect.changes : []).some((c) => c && /macro/i.test(c.key ?? "") && !inertMacroChange.test(c.key))) return true;
  }
  return Object.values(data.system?.activities ?? {}).some(
    (a) =>
      a &&
      typeof a === "object" &&
      (hasText(a.macro) ||
        hasText(a.macroData?.command) ||
        hasText(a.flags?.["midi-qol"]?.onUseMacroName) ||
        hasText(a.flags?.["midi-qol"]?.onUseMacroParts) ||
        scriptedFlagModules.some((key) => hasText(a.flags?.[key]))),
  );
}
// True when automation text names the item or uses its Item Macro.
function nameReferenced(data, names, automation) {
  const named = names.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`, "u")
    : null;
  if (automationStrings(data).some((text) => /ItemMacro/i.test(text))) return true;
  return Boolean(named) && automation.some((text) => named.test(text));
}
// DDB 7.6 findMatchedDDBItem matches items without definitionId by exact name, so a
// later DDB sync recreates renamed class features in English. That is accepted:
// imports are rare, and the translation button is run again after one.
export function safeName(data, { automation } = {}) {
  const names = [...new Set([data.flags?.ddbimporter?.originalName, data.name])].filter(
    (name) => typeof name === "string" && name.trim(),
  );
  return (
    data.type !== "class" &&
    !names.some((name) => protectedNames.has(name)) &&
    !data.flags?.ddbimporter?.dndbeyond?.isCustomItem &&
    !["cachedFor", "enchantment", "enchantmentId", "rider"].some(
      (key) => data.flags?.dnd5e?.[key],
    ) &&
    !scriptedAutomation(data) &&
    // `automation` holds the strings of every item on the actor; default to this item.
    !nameReferenced(data, names, automation ?? automationStrings(data))
  );
}
// Parse attributes without DOM dependencies, including unquoted values and mixed casing.
export const decodeReferences = (text) => text.replace(/&amp;|&#0*38;|&#x0*26;/gi, "&");
function syntax(text) {
  // Executable and attribute anchors retain their raw bytes; decode only Reference inputs elsewhere.
  // dnd5e enrichLookup reads the current document's rollData name and renders a span.
  // No donor activity/item selector or arbitrary property lookup is accepted here.
  const anchors =
    text.match(/@(?:Macro|Script)\[[^\]]*\]|\{\{[\s\S]*?\}\}|<script\b[\s\S]*?(?:<\/script\s*>|$)/gi) ??
    [];
  for (const tag of text.matchAll(/<[a-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    for (const attr of tag[0].matchAll(/([^\s<>/="']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      const name = attr[1].toLowerCase();
      if (/^(?:href|src|on[\w-]+|data-[\w-]+)$/.test(name))
        anchors.push(`${name}=${attr[2] ?? attr[3] ?? attr[4]}`);
    }
  }
  for (const token of text.matchAll(/@(\w+)\[([^\]]*)\]|\[\[([\s\S]*?)\]\]/g)) {
    if (["UUID", "Embed", "Reference"].includes(token[1])) continue;
    if (token[3] && /^\s*lookup\s+@name(?:\s+lowercase)?\s*$/i.test(token[3])) continue;
    // Explicit presentation rolls are independent of system formulas. References into the
    // current Item or automation commands must remain byte-identical.
    if (
      token[3] &&
      /^\/(?:r|roll|damage|heal)\s+(?!.*@)(?!.*(?:activity|macro|script))[\ddkhl+*/(). ,a-z=-]+$/i.test(
        token[3],
      )
    )
      continue;
    anchors.push(token[0]);
  }
  for (const token of text.matchAll(/@[A-Za-z_][\w.]*/g)) {
    if (text[token.index + token[0].length] !== "[" && token[0].replace(/\.+$/, "").toLowerCase() !== "@name") anchors.push(token[0]);
  }
  return anchors.sort();
}
export function safeText(
  before,
  after,
  { validatedLinks = new Set(), validatedReferences = new Set(), allowEqual = false } = {},
) {
  if (
    typeof before !== "string" ||
    typeof after !== "string" ||
    (!allowEqual && before === after) ||
    !/[А-Яа-яЁё]/.test(after)
  )
    return false;
  const beforeReferences = new Set(
    [...decodeReferences(before).matchAll(/(?:&|@)Reference\[([^\]]+)\]/gi)].map((m) => m[1]),
  );
  const afterReferences = new Set(
    [...decodeReferences(after).matchAll(/(?:&|@)Reference\[([^\]]+)\]/gi)].map((m) => m[1]),
  );
  if (
    [...beforeReferences].some(
      (input) => !afterReferences.has(input) && !validatedReferences.has(input),
    )
  )
    return false;
  if (
    [...decodeReferences(after).matchAll(/(?:&|@)Reference\[([^\]]+)\]/gi)].some(
      (m) => !beforeReferences.has(m[1]) && !validatedReferences.has(m[1]),
    )
  )
    return false;
  // RollTable links are executable targets, even when expressed as ordinary UUID enrichers.
  const tables = text => [...text.matchAll(/@(?:UUID|Embed|RollTable)\[([^\] ]+)/g)]
    .map(m => m[1]).filter(uuid => uuid.includes(".RollTable.")).sort();
  if (JSON.stringify(tables(before)) !== JSON.stringify(tables(after))) return false;
  const existing = new Set([...before.matchAll(/@(?:UUID|Embed)\[([^\] ]+)/g)].map((m) => m[1]));
  if (
    [...after.matchAll(/@(?:UUID|Embed)\[([^\] ]+)/g)].some(
      (m) => !existing.has(m[1]) && !validatedLinks.has(m[1]),
    )
  )
    return false;
  return JSON.stringify(syntax(before)) === JSON.stringify(syntax(after)) &&
    (allowEqual || !presentationEqual(before, after));
}
export function presentationText(before, after) {
  if (typeof after !== "string") return after;
  const existing = new Set(
    [...decodeReferences(before ?? "").matchAll(/(?:&|@)Reference\[([^\]]+)\]/gi)].map((m) => m[1]),
  );
  return after.replace(/(?:&amp;|&#0*38;|&#x0*26;|&|@)Reference\[([^\]]+)\]/gi, (token, input) =>
    existing.has(input) || /\bapply=false\b/.test(input)
      ? token
      : token
          .replace(/\]$/, `${/\bapply=true\b/.test(input) ? "" : " apply=false"}]`)
          .replace(/apply=true/g, "apply=false"),
  );
}
function projectedText(before, after, options) {
  after = presentationText(before, after);
  if (typeof after !== "string") return after;
  const valid = options?.validatedReferences ?? new Set();
  const existing = new Set(
    [...decodeReferences(before ?? "").matchAll(/(?:&|@)Reference\[([^\]]+)\]/gi)].map((m) => m[1]),
  );
  // References to the same glossary slug may differ in case or readonly options.
  // Reuse the DDB token so its target and application behavior stay exact.
  const readonlySlug = input => /^(?:(?:rule|condition|action)=)?[a-z]+(?: apply=false)?$/i.test(input)
    ? input.replace(/ apply=false$/i, "").toLowerCase() : null;
  const originals = new Map();
  for (const m of (before ?? "").matchAll(/(?:&amp;|&#0*38;|&#x0*26;|&|@)Reference\[([^\]]+)\]/gi)) {
    const slug = readonlySlug(m[1]);
    if (slug) originals.set(slug, m[0]);
  }
  after = after.replace(/(?:&amp;|&#0*38;|&#x0*26;|&|@)Reference\[([^\]]+)\]/gi,
    (token, input) => originals.get(readonlySlug(input)) ?? token);
  // An unavailable glossary page becomes a visible label, never a dangling command.
  after = after.replace(
    /(?:&amp;|&#0*38;|&#x0*26;|&|@)Reference\[([^\]]+)\](?:\{([^}]+)\})?/gi,
    (token, input, label) => {
      if (valid.has(input) || existing.has(input)) return token;
      if (!/^(?:(?:rule|condition|action)=)?[a-z]+(?: apply=false)?$/i.test(input)) return token;
      return (
        label ?? input.split(/[= ]/).filter((p) => !["rule", "condition", "action"].includes(p))[0]
      );
    },
  );
  // DDB's save controls are useful executable UI. Preserve them when AG prose omits them.
  const saves = [...(before ?? "").matchAll(/\[\[\/save[^\]]*\]\]/g)].map((m) => m[0]);
  for (const token of new Set(saves)) {
    const count = text => text.split(token).length - 1;
    const missing = count(before) - count(after);
    for (let i = 0; i < missing; i++) after += `<p>${token}</p>`;
  }
  return after;
}
export function project(data, translated, { diagnostics = () => {}, ...options } = {}) {
  const delta = {};
  if (safeName(data, options) && safeText(data.name, translated.name)) delta.name = translated.name;
  for (const path of paths) {
    const before = get(data, path),
      after = projectedText(before, get(translated, path), options);
    if (safeText(before, after, options)) delta[path] = after;
    else if (typeof after === "string" && before !== after)
      diagnostics({ reason: "inline-syntax-or-missing-field", name: data.name, path });
  }
  return delta;
}

// Supplement entries require a semantic parent and an exact role/name/type; never map by array position or Foundry id.
export function projectSupplement(item, match, supplement, reservations = {}) {
  const activityDelta = {},
    effectDeltas = [], reservedActivities = new Set(), reservedEffects = new Map();
  Object.assign(reservations, { reservedActivities, reservedEffects });
  for (const entry of supplement.entries ?? []) {
    if (
      entry.parent !== match.entry.name ||
      entry.kind !== item.type ||
      entry.rules !== match.entry.rules ||
      entry.source !== match.entry.source
    )
      continue;
    const text = entry.translations?.[match.style];
    if (!text) continue;
    const children =
      entry.role === "activity"
        ? Object.values(item.system?.activities ?? {})
        : entry.role === "source-effect"
          ? (item.effects ?? [])
          : [];
    const candidates = children.filter((c) => c.name === entry.name && c.type === entry.type);
    if (candidates.length !== 1) continue;
    const child = candidates[0];
    if (appliedCopy(child)) continue;
    // Applied enchant copies can live on owned Items too. Only explicit source effects are supported.
    if (entry.role === "source-effect" && appliedCopy(child)) continue;
    const patch = {};
    if (entry.safeName === true && safeText(child.name, text.name)) patch.name = text.name;
    const path = entry.role === "activity" ? "description.chatFlavor" : "description";
    const before = get(child, path), candidate = get(text, path);
    if (safeText(before, candidate, { ...match.projectOptions, allowEqual: true })) {
      if (entry.role === "activity") reservedActivities.add(`system.activities.${child._id}.${path}`);
      else {
        if (!reservedEffects.has(child._id)) reservedEffects.set(child._id, new Set());
        reservedEffects.get(child._id).add(path);
      }
      if (!presentationEqual(before, candidate)) patch[path] = candidate;
    }
    if (entry.role === "activity") {
      for (const [key, value] of Object.entries(patch))
        activityDelta[`system.activities.${child._id}.${key}`] = value;
    } else if (Object.keys(patch).length) effectDeltas.push({ _id: child._id, ...patch });
  }
  return { activityDelta, effectDeltas };
}

export function appliedCopy(child, sourceParent) {
  const origin = child.system?.origin;
  const ownSource =
    sourceParent?.startsWith("Compendium.ag-") &&
    origin &&
    typeof origin === "object" &&
    origin.item === sourceParent &&
    Object.entries(origin).every(([key, value]) => key === "item" || !value);
  return Boolean(
    child.origin ||
    (!ownSource && origin && Object.values(origin).some(Boolean)) ||
    child._stats?.duplicateSource ||
    child._stats?.compendiumSource ||
    child.flags?.dnd5e?.cachedFor ||
    child.flags?.dnd5e?.enchantment ||
    child.flags?.dnd5e?.enchantmentId ||
    child.flags?.dnd5e?.rider,
  );
}
const englishLabel = (c) =>
  c.flags?.ddbimporter?.originalName ??
  c.flags?.babele?.originalName ??
  c.name?.match(/\[([^\]]+)\]$/)?.[1] ??
  c.name ??
  c.title;
function activityMarkers(c, parent) {
  if (!c.damage?.parts?.length && !c.save?.ability?.length && !c.healing && !c.attack?.type?.value)
    return null;
  const markers = [
    c.activation?.type,
    c.save?.ability && [...c.save.ability].sort().join(","),
    ...(c.damage?.parts ?? []).flatMap((p) => p.types ?? []),
  ].filter(Boolean);
  const effects = ((c.effects?.length ?? 0) > 1 ? c.effects : []).map((link) =>
    (parent?.effects ?? []).find((e) => e._id === link._id),
  );
  if (effects.some((e) => !e)) return null;
  return markers.length
    ? JSON.stringify([c.type, ...markers, effects.map(effectRole).sort()])
    : null;
}
const sorted = (values) => [...(values ?? [])].sort();
function effectRole(effect) {
  const statuses = sorted(effect.statuses);
  return statuses.length ? `status:${statuses.join(",")}` : `spell-effect:${englishLabel(effect)}`;
}
function compactDamage(part) {
  return {
    number: part.number ?? null,
    denomination: part.denomination ?? null,
    bonus: part.bonus ?? "",
    types: sorted(part.types),
  };
}
function matchesChildRole(child, role, parent) {
  if (typeof role === "string") return effectRole(child) === role;
  if (child.type !== role.type || child.activation?.type !== role.activation) return false;
  if (
    role.save &&
    JSON.stringify(sorted(child.save?.ability)) !== JSON.stringify(sorted(role.save))
  )
    return false;
  if (
    role.damage &&
    JSON.stringify((child.damage?.parts ?? []).map(compactDamage)) !==
      JSON.stringify(role.damage.map(compactDamage))
  )
    return false;
  if (
    role.damageTypes &&
    JSON.stringify(sorted(new Set((child.damage?.parts ?? []).flatMap((p) => p.types ?? [])))) !==
      JSON.stringify(sorted(role.damageTypes))
  )
    return false;
  if (
    role.healingTypes &&
    JSON.stringify(sorted(child.healing?.types)) !== JSON.stringify(sorted(role.healingTypes))
  )
    return false;
  if (role.effects) {
    const linked = (child.effects ?? [])
      .map((link) => (parent.effects ?? []).find((e) => e._id === link._id))
      .filter(Boolean)
      .map(effectRole)
      .sort();
    if (JSON.stringify(linked) !== JSON.stringify(sorted(role.effects))) return false;
  }
  return true;
}
function advancementMarkers(child) {
  const c = child.configuration;
  if (!c) return null;
  if (child.type === "Size" && Number.isInteger(child.level) && child.level >= 0 &&
      Array.isArray(c.sizes) && c.sizes.length && c.sizes.every(size => typeof size === "string" && size))
    return JSON.stringify([child.type, child.level, [...new Set(c.sizes)].sort()]);
  if (child.type === "Trait" && (c.grants?.length || c.choices?.length)) {
    return JSON.stringify([
      child.type,
      child.level,
      c.mode,
      [...(c.grants ?? [])].sort(),
      (c.choices ?? []).map((choice) => [choice.count, [...(choice.pool ?? [])].sort()]).sort(),
    ]);
  }
  if (child.type === "ScaleValue" && c.identifier)
    return JSON.stringify([child.type, child.level, c.identifier, c.type]);
  return null;
}
// Only proven source Actors expose this traversal. Owned identities never become global bindings.
function ownedSourceCopy(child, provenAddress) {
  if (child.flags?.ddbimporter?.ignoreItemImport || child.flags?.ddbimporter?.dndbeyond?.isCustomItem) return true;
  const source = child._stats?.compendiumSource;
  if ((source === provenAddress && /^Compendium\.ag-[^.]+\.[^.]+\.Actor\.[^.]+\.Item\.[^.]+$/.test(provenAddress ?? "")) ||
      /^Compendium\.ag-[^.]+\.[^.]+\.Item\.[^.]+$/.test(source ?? ""))
    return appliedCopy({ ...child, _stats: { ...child._stats, compendiumSource: null } });
  return appliedCopy(child);
}
function profileRootCopy(root, address, native = false) {
  if (!root) return true;
  const source = root._stats?.compendiumSource;
  return appliedCopy({ ...root, _stats: { ...root._stats,
    compendiumSource: native || source === address ? null : source } });
}
function nameConsumed(item, child) {
  const ignored = new Set(["id", "_id", "_stats", "uuid", "origin", "compendiumSource",
    "duplicateSource", "exportSource", "folder", "img"]);
  function scan(value) {
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([key, v]) => {
      if (ignored.has(key) || (value === child && key === "name")) return false;
      if (typeof v === "string") return v.includes(child.name);
      return scan(v);
    });
  }
  return scan(item);
}
// Pair children only inside the proven parent. Local child IDs and positions never join.
export function projectChildren(item, match) {
  const delta = {},
    effectDeltas = [],
    resultDeltas = [],
    itemDeltas = [];
  for (const role of ["activity", "source-effect", "advancement", "table-result"]) {
    const values = (data) =>
      role === "activity"
        ? Object.values(data.system?.activities ?? {})
        : role === "source-effect"
          ? (data.effects ?? [])
          : role === "table-result"
            ? Object.values(data.results ?? {})
            : Object.values(data.system?.advancement ?? {});
    const source = values(item),
      targets = values(match.text);
    for (const child of source) {
      if (appliedCopy(child)) continue;
      const precise = (match.descriptionRoles ?? []).filter(r =>
        r.kind === (role === "source-effect" ? "effect" : role) &&
        (r.owned ? match.ownedPath?.length === 1 && match.ownedPath[0] === r.owned &&
          item.type === (r.ownedType ?? "feat") && match.text.type === (r.ownedType ?? "feat") : !match.ownedPath?.length));
      if (precise.length) {
        const currentSources = [item, match.text].map(d => d.system?.source ?? d.system?.details?.source ?? {});
        if (precise.some(r => currentSources.some(s => (s.rules && s.rules !== r.rules) ||
            (s.book && !r.books?.includes(s.book))))) continue;
        if (profileRootCopy(match.rootData ?? item, undefined, match.nativeRoot) ||
            profileRootCopy(match.rootText ?? match.text, (match.rootEntry ?? match.entry)?.uuid)) continue;
        const applicable = precise.filter(r => matchesDescriptionRole(r.role, child, item));
        if (applicable.length !== 1) continue;
        const candidates = [...new Set(applicable.flatMap(r => targets.filter(c => matchesDescriptionRole(r.role, c, match.text, true))))];
        const peers = [...new Set(applicable.flatMap(r => source.filter(c => matchesDescriptionRole(r.role, c, item))))];
        if (candidates.length !== 1 || peers.length !== 1 || appliedCopy(candidates[0], match.entry?.uuid)) continue;
        const path = applicable[0].field ?? (role === "activity" ? "description.value" : "description");
        if (!(role === "activity" ? ["description.value", "description.chatFlavor"] : ["description"]).includes(path)) continue;
        const after = projectedText(get(child, path) ?? "", get(candidates[0], path), match.projectOptions);
        if (safeText(get(child, path) ?? "", after, match.projectOptions)) {
          if (role === "source-effect") effectDeltas.push({ _id: child._id, description: after });
          else delta[`system.activities.${child._id}.${path}`] = after;
        }
        continue;
      }
      const label = englishLabel(child);
      const equal = (c) =>
        label &&
        /\p{Script=Latin}/u.test(label) &&
        c.type === child.type &&
        englishLabel(c) === label;
      const curated = (match.childRoles ?? []).filter(
        (r) => r.kind === (role === "source-effect" ? "effect" : role),
      );
      const proven = curated.filter((r) => matchesChildRole(child, r.role, item));
      let candidates = curated.length
        ? [
            ...new Set(
              proven.flatMap((r) => targets.filter((c) => matchesChildRole(c, r.role, match.text))),
            ),
          ]
        : targets.filter(equal);
      let peers = curated.length
        ? [
            ...new Set(
              proven.flatMap((r) => source.filter((c) => matchesChildRole(c, r.role, item))),
            ),
          ]
        : source.filter(equal);
      if (
        !curated.length &&
        !candidates.length &&
        role === "activity" &&
        activityMarkers(child, item)
      ) {
        candidates = targets.filter(
          (c) => activityMarkers(c, match.text) === activityMarkers(child, item),
        );
        peers = source.filter((c) => activityMarkers(c, item) === activityMarkers(child, item));
      }
      if (!curated.length && !candidates.length && role === "source-effect" && child.statuses?.length) {
        const statusRole = effectRole(child);
        candidates = targets.filter(c => c.type === child.type && effectRole(c) === statusRole);
        peers = source.filter(c => c.type === child.type && effectRole(c) === statusRole);
      }
      if (!candidates.length && role === "advancement" && advancementMarkers(child)) {
        candidates = targets.filter((c) => advancementMarkers(c) === advancementMarkers(child));
        peers = source.filter((c) => advancementMarkers(c) === advancementMarkers(child));
      }
      if (
        candidates.length !== 1 ||
        peers.length !== 1 ||
        appliedCopy(candidates[0], match.entry?.uuid)
      )
        continue;
      const target = candidates[0],
        patch = {};
      const fields =
        role === "activity"
          ? ["description.chatFlavor", "description.value"]
          : role === "source-effect"
            ? ["description"]
            : role === "table-result"
              ? ["name", "description"]
              : ["title", "hint"];
      if (
        role === "activity" &&
        child.name &&
        !protectedNames.has(child.name) &&
        !protectedActivityNames.has(child.name) &&
        !child.macro &&
        !child.macroData?.command &&
        !nameConsumed(item, child)
      )
        fields.push("name");
      // Activity names can be exact machine keys in DDB behaviors. Effects with changes/macros
      // keep names too; their descriptions remain eligible.
      if (
        role === "source-effect" &&
        !child.changes?.length &&
        !child.flags?.dae &&
        !child.flags?.["midi-qol"]
      )
        fields.push("name");
      for (const path of fields) {
        const candidate =
          role === "activity" &&
          path === "description.chatFlavor" &&
          !get(target, path) &&
          /[А-Яа-яЁё]/.test(target.name ?? "")
            ? target.name
            : get(target, path);
        const after = projectedText(get(child, path), candidate, match.projectOptions);
        if (safeText(get(child, path) ?? "", after, match.projectOptions)) patch[path] = after;
      }
      if (role === "table-result") {
        if (Object.keys(patch).length) resultDeltas.push({ _id: child._id, ...patch });
      } else if (role === "source-effect") {
        if (Object.keys(patch).length) effectDeltas.push({ _id: child._id, ...patch });
      } else {
        const base =
          role === "activity"
            ? `system.activities.${child._id}`
            : `system.advancement.${Object.keys(item.system.advancement).find((k) => item.system.advancement[k] === child)}`;
        for (const [path, value] of Object.entries(patch)) delta[`${base}.${path}`] = value;
      }
    }
  }
  if (/^Compendium\.ag-[^.]+\.[^.]+\.Actor\.[^.]+$/.test(match.entry?.uuid ?? "") && Array.isArray(item.items) && Array.isArray(match.text.items)) {
    const equal = (a, b) => a.type === b.type && /\p{Script=Latin}/u.test(englishLabel(a) ?? "") &&
      englishLabel(a) === englishLabel(b) &&
      (!a.system?.source?.rules || !b.system?.source?.rules || a.system.source.rules === b.system.source.rules) &&
      (!a.system?.source?.book || !b.system?.source?.book || a.system.source.book === b.system.source.book);
    for (const child of item.items) {
      const targets = match.text.items.filter(c => equal(child, c));
      if (targets.length !== 1 || item.items.filter(c => equal(c, targets[0])).length !== 1 ||
          ownedSourceCopy(child) || ownedSourceCopy(targets[0], `${match.entry.uuid}.Item.${targets[0]._id}`)) continue;
      const target = targets[0];
      const nested = { ...match, ownedPath: [...(match.ownedPath ?? []), englishLabel(target)], text: target, entry: { ...match.entry, uuid: `${match.entry.uuid}.Item.${target._id}` }, childRoles: [] };
      const children = projectChildren(child, nested);
      const fields = { ...project(child, target, match.projectOptions), ...children.delta };
      if (Object.keys(fields).length || children.effectDeltas.length || children.resultDeltas.length || children.itemDeltas.length)
        itemDeltas.push({ _id: child._id, ...children, delta: fields });
    }
  }
  return { delta, effectDeltas, resultDeltas, itemDeltas };
}

// Shared by runtime get and PC apply: validated contextual text owns its path even
// when already equal. Equality only decides whether the selected candidate writes.
export function projectCandidates(item, match, supplement) {
  const reservations = {};
  const extra = projectSupplement(item, match, supplement, reservations);
  const children = projectChildren(item, match);
  for (const path of reservations.reservedActivities) delete children.delta[path];
  children.effectDeltas = children.effectDeltas.flatMap(delta => {
    const filtered = Object.fromEntries(Object.entries(delta).filter(([path]) =>
      !reservations.reservedEffects.get(delta._id)?.has(path)));
    return Object.keys(filtered).length > 1 ? [filtered] : [];
  });
  return { extra, children };
}
