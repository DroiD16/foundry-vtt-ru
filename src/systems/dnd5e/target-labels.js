// Only explicitly marked AG 2024 lookups opt into grammatical agreement.
// Keep the system's prepared target, plural rules and lookup resolution intact.
export function agreeTargetLookup(element, config, options) {
  if (!element || !/(?:^|\s)ag2024(?:\s|$)/.test(config)) return element;
  if (!/^@target\.affects\.labels\.statblock(?:\s|$)/.test(config.trim())) return element;
  const id = config.match(/(?:^|\s)activity=(\w+)(?:\s|$)/)?.[1];
  const activity = options.relativeTo?.system?.activities?.get(id);
  const affects = activity?.getRollData().activity?.target?.affects;
  if (["creature", "object"].includes(affects?.type)) {
    const creature = affects.type === "creature";
    const form = new Intl.PluralRules("ru").select(affects.count || 1);
    const noun = (
      creature
        ? { one: "существо", few: "существа", many: "существ", other: "существа" }
        : { one: "объект", few: "объекта", many: "объектов", other: "объекта" }
    )[form];
    element.innerText = element.innerText.replace(
      /DND5E\.TARGET\.Type\.(?:Creature|Object)\.Counted\.(?:one|few|many|other)/g,
      noun,
    );
    if (creature && affects.count === 1) {
      element.innerText = element.innerText.replace(/^один /, "одно ");
    }
  }
  return element;
}

export function registerTargetAgreement() {
  const lookup = CONFIG.TextEditor.enrichers.find((entry) => entry.id === "dnd5e-lookup");
  if (!lookup) return;
  const original = lookup.enricher;
  lookup.enricher = async (match, options) => {
    const element = await original(match, options);
    if (game.i18n.lang !== "ru" || game.settings.get("ru-ru", "altTranslation")) return element;
    if (match.groups?.type.toLowerCase() !== "lookup") return element;
    return agreeTargetLookup(element, match.groups.config, options);
  };
}
