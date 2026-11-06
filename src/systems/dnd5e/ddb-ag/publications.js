// Small reviewed publication vocabulary, symmetric across AG and DDB spellings.
import sourceData from "../../../../public/integrations/ddb-ag/sources.json" with {type:"json"};
export const publicationTuples = [];
for (const row of sourceData.sources) {
  let tuple = publicationTuples.find(t => t.rules === row.rules && t.sourceIds.includes(row.ddb.id));
  if (!tuple) publicationTuples.push(tuple = {canonical:row.ag, rules:row.rules, agAliases:[], ddbAliases:[], sourceIds:[row.ddb.id]});
  if (!tuple.agAliases.includes(row.ag)) tuple.agAliases.push(row.ag);
  if (!tuple.ddbAliases.includes(row.ddb.name)) tuple.ddbAliases.push(row.ddb.name);
}
export const bookFolders = new Map([
  ["Книга игрока (2024)", "PHB 2024"], ["Player's Handbook (2024)", "PHB 2024"],
  ["Руководство мастера подземелий (2024)", "DMG 2024"], ["Dungeon Master's Guide (2024)", "DMG 2024"],
  ["Бестиарий (2024)", "MM 2024"], ["Monster Manual (2024)", "MM 2024"],
]);
export function publicationTuple(book, rules) {
  if (rules !== "2024" || typeof book !== "string" || !book) return null;
  return publicationTuples.find(t => t.rules === rules && [...t.agAliases, ...t.ddbAliases].includes(book)) ?? null;
}
export function canonicalPublication(book, rules) {
  return publicationTuple(book, rules)?.canonical ?? null;
}
// A book can come from several DDB sources (PHB 2024 and the Free Rules 2024 subset).
export function publicationContradicts(key) {
  const book = key.source ?? key.publication;
  if (key.rules !== "2024" || typeof book !== "string" || !book || !key.sourceIds?.length) return false;
  const tuples = publicationTuples.filter(t => t.rules === key.rules && [...t.agAliases, ...t.ddbAliases].includes(book));
  return tuples.length > 0 && !tuples.some(t => t.sourceIds.some(id => key.sourceIds.includes(id)));
}
// DDB prefixes some names with their grouping; AG names the item alone.
function unprefixed(key, name) {
  if (typeof name !== "string") return name;
  name = name.replace(/[’‘]/g, "'");
  if (key.kind === "background") return name.replace(/^Background:\s+/, "");
  if (key.kind === "feat" && key.subtypeDetail === "eldritchInvocation")
    return name.replace(/^Eldritch Invocations?:\s+/, "");
  return name;
}
export function canonicalName(key) {
  const name = unprefixed(key, key.english ?? key.name);
  if ((key.publication ?? key.source) !== "PHB 2024" || key.rules !== "2024") return name;
  if (key.kind === "feat" && key.subtype === "class" && name === "Lay On Hands") return "Lay on Hands";
  if (key.kind === "spell" && name === "Locate Animals or Plants") return "Locate Animals Or Plants";
  return name;
}

// Bounded technical presentation evidence, checked against raw AG records and the
// native dndsu dictionaries. Names only; no descriptions or mechanics are shipped.
// All rows are rules 2024. Tuple: pack, id, type, book, English identity, raw label,
// dndsu label, identifier, subtype, subtypeDetail, classIdentifier.
export const agStyleEvidence = new Map([
  ["ag-fifthpendium.spells","phbsplAntipathyS","spell","PHB 2024","Antipathy/Sympathy","Антипатия/симпатия [Antipathy/Sympathy]","Антипатия/симпатия [Antipathy/sympathy]","antipathysympathy",null,null,null],
  ["ag-fifthpendium.spells","phbsplEldritchBl","spell","PHB 2024","Eldritch Blast","Потусторонний разряд [Eldritch Blast]","Мистический заряд [Eldrich Blast]","eldritch-blast",null,null,null],
  ["ag-fifthpendium.spells","phbsplEnlargeRed","spell","PHB 2024","Enlarge/Reduce","Увеличение/уменьшение [Enlarge/Reduce]","Увеличение/уменьшение [Enlarge/reduce]","enlargereduce",null,null,null],
  ["ag-fifthpendium.spells","phbsplMelfsAcidA","spell","PHB 2024","Melf's Acid Arrow","Кислотная стрела Мелфа [Melf's Acid Arrow]","Кислотная стрела Мельфа [Melf’s Acid Arrow]","acid-arrow",null,null,null],
  ["ag-fifthpendium.spells","phbsplOtilukesRe","spell","PHB 2024","Otiluke's Resilient Sphere","Силовая сфера Отилюка [Otiluke's Resilient Sphere]","Упругий шар Отилюка [Otiluke’s Resilient Sphere]","otilukes-resilient-sphere",null,null,null],
  ["ag-fifthpendium.spells","phbsplTensersFlo","spell","PHB 2024","Tenser's Floating Disk","Парящий диск Тензера [Tenser's Floating Disk]","Парящий диск Тензера [Tenser’s Floating Disk]","tensers-floating-disk",null,null,null],
  ["ag-fifthpendium.spells","phbswdMordenkain","spell","PHB 2024","Mordenkainen's Sword","Меч Морденкайнена [Mordenkainen's Sword]","Меч Морденкайнена [Mordenkainen’s Sword]","mordenkainens-sword",null,null,null],
  ["ag-fifthpendium.equipment","dmgAmmunitionPl1","consumable","DMG 2024","Ammunition +1","Боеприпас +1 [Ammunition +1]","Боеприпас +1, +2, +3 [Ammunition, +1, +2, or +3]","ammunition-1","ammo","",null],
  ["ag-fifthpendium.equipment","dmgAmmunitionPl2","consumable","DMG 2024","Ammunition +2","Боеприпас +2 [Ammunition +2]","Боеприпас +1, +2, +3 [Ammunition, +1, +2, or +3]","ammunition-2","ammo","",null],
  ["ag-fifthpendium.equipment","dmgAmmunitionPl3","consumable","DMG 2024","Ammunition +3","Боеприпас +3 [Ammunition +3]","Боеприпас +1, +2, +3 [Ammunition, +1, +2, or +3]","ammunition-3","ammo","",null],
  ["ag-fifthpendium.equipment","dmgArmorPlus1000","equipment","DMG 2024","Armor +1","Броня +1 [Armor +1]","Доспех +1, +2 или +3 [Armor +1,+2, or +3]","armor-1","",null,null],
  ["ag-fifthpendium.equipment","dmgArmorPlus2000","equipment","DMG 2024","Armor +2","Броня +2 [Armor +2]","Доспех +1, +2 или +3 [Armor +1,+2, or +3]","armor-2","",null,null],
  ["ag-fifthpendium.equipment","dmgArmorPlus3000","equipment","DMG 2024","Armor +3","Броня +3 [Armor +3]","Доспех +1, +2 или +3 [Armor +1,+2, or +3]","armor-3","",null,null],
  ["ag-fifthpendium.equipment","dmgBlueElemental","equipment","DMG 2024","Elemental Gem (Blue Sapphire)","Самоцвет элементаля (синий сапфир) [Elemental Gem (Blue Sapphire)]","Камень элементаля (синий сапфир) [Elemental Gem (blue sapphire)]","elemental-gem-blue-sapphire","wondrous",null,null],
  ["ag-fifthpendium.equipment","dmgBracersOfDefe","equipment","DMG 2024","Bracers of Defense","Наручи защиты [Bracers of Defense]","Наручи защиты [Bracers of Defence]","bracers-of-Defense","wondrous",null,null],
  ["ag-fifthpendium.equipment","dmgCloakOfBillow","equipment","DMG 2024","Cloak of Billowing","Развевающийся плащ [Cloak of Billowing]","Развевающийся плащ [Cloak  of Billowing]","cloak-of-billowing","wondrous",null,null],
  ["ag-fifthpendium.equipment","dmgEnergyCell000","consumable","DMG 2024","Energy Cell","Ячейка энергии [Energy Cell]","Батарея [Energy cell]","energy-cell","ammo","energyCell",null],
  ["ag-fifthpendium.equipment","dmgGrenadeFragme","consumable","DMG 2024","Fragmentation Grenade","Граната, осколочная [Fragmentation Grenade]","Граната, осколочная [Grenade, fragmentation]","grenade-fragmentation","","",null],
  ["ag-fifthpendium.equipment","dmgGrenadeSmoke0","consumable","DMG 2024","Smoke Grenade","Граната, дымовая [Smoke Grenade]","Граната, дымовая [Grenade, smoke]","grenade-smoke","","",null],
  ["ag-fifthpendium.equipment","dmgRedElementalG","equipment","DMG 2024","Elemental Gem (Red Corundum)","Самоцвет элементаля (красный корунд) [Elemental Gem (Red Corundum)]","Камень элементаля (красный корунд) [Elemental Gem (red corundum)]","elemental-gem-red-corundum","wondrous",null,null],
  ["ag-fifthpendium.equipment","gemBlackOpal0000","loot","DMG 2024","Black Opal","Чёрный опал [Black Opal]","Чёрный опал [Black opal]","black-opal","gem","",null],
  ["ag-fifthpendium.equipment","gemBlackPearl000","loot","DMG 2024","Black Pearl","Чёрный жемчуг [Black Pearl]","Чёрный жемчуг [Black pearl]","black-pearl","gem","",null],
  ["ag-fifthpendium.equipment","gemBlackSapphire","loot","DMG 2024","Black Sapphire","Чёрный сапфир [Black Sapphire]","Чёрный сапфир [Black sapphire]","black-sapphire","gem","",null],
  ["ag-fifthpendium.equipment","gemBlueQuartz000","loot","DMG 2024","Blue Quartz","Голубой кварц [Blue Quartz]","Синий кварц [Blue quartz]","blue-quartz","gem","",null],
  ["ag-fifthpendium.equipment","gemBlueSapphire0","loot","DMG 2024","Blue Sapphire","Синий сапфир [Blue Sapphire]","Синий сапфир [Blue sapphire]","blue-sapphire","gem","",null],
  ["ag-fifthpendium.equipment","gemBlueSpinel000","loot","DMG 2024","Blue Spinel","Сапфировая шпинель [Blue Spinel]","Синяя шпинель [Blue spinel]","blue-spinel","gem","",null],
  ["ag-fifthpendium.equipment","gemEyeAgate00000","loot","DMG 2024","Eye Agate","Агат глазковый [Eye Agate]","Глазковый агат [Eye agate]","eye-agate","gem","",null],
  ["ag-fifthpendium.equipment","gemFireOpal00000","loot","DMG 2024","Fire Opal","Огненный опал [Fire Opal]","Огненный опал [Fire opal]","fire-opal","gem","",null],
  ["ag-fifthpendium.equipment","gemLapisLazuli00","loot","DMG 2024","Lapis Lazuli","Лазурит [Lapis Lazuli]","Лазурит [Lapis lazuli]","lapis-lazuli","gem","",null],
  ["ag-fifthpendium.equipment","gemMossAgate0000","loot","DMG 2024","Moss Agate","Моховой агат [Moss Agate]","Моховой агат [Moss agate]","moss-agate","gem","",null],
  ["ag-fifthpendium.equipment","gemStarRoseQuart","loot","DMG 2024","Star Rose Quartz","Звёздчатый розовый кварц [Star Rose Quartz]","Звёздчатый розовый кварц [Star rose quartz]","star-rose-quartz","gem","",null],
  ["ag-fifthpendium.equipment","gemStarRuby00000","loot","DMG 2024","Star Ruby","Звёздчатый рубин [Star Ruby]","Звёздчатый рубин [Star ruby]","star-ruby","gem","",null],
  ["ag-fifthpendium.equipment","gemStarSapphire0","loot","DMG 2024","Star Sapphire","Звёздчатый сапфир [Star Sapphire]","Звёздчатый сапфир [Star sapphire]","star-sapphire","gem","",null],
  ["ag-fifthpendium.equipment","gemTigerEye00000","loot","DMG 2024","Tiger Eye","Тигровый глаз [Tiger Eye]","Тигровый глаз [Tiger eye]","tiger-eye","gem","",null],
  ["ag-fifthpendium.equipment","gemYellowSapphir","loot","DMG 2024","Yellow Sapphire","Жёлтый сапфир [Yellow Sapphire]","Жёлтый сапфир [Yellow sapphire]","yellow-sapphire","gem","",null],
  ["ag-fifthpendium.equipment","phbagArcaneFocus","loot","PHB 2024","Arcane Focus (Varies)","Мистический фокусирующий предмет (различный) [Arcane Focus (Varies)]","Магическая фокусировка [Arcane Focus]","arcane-focus-varies","gear","",null],
  ["ag-fifthpendium.equipment","phbagBottleGlass","container","PHB 2024","Bottle, Glass","Стеклянная бутылка [Bottle, Glass]","Стеклянная бутылка [Glass Bottle]","bottle-glass",null,null,null],
  ["ag-fifthpendium.equipment","phbagCaseCrossbo","container","PHB 2024","Case, Crossbow Bolt","Колчан для арбалетных болтов [Case, Crossbow Bolt]","Футляр для арбалетных болтов [Crossbow Bolt Case]","case-crossbow-bolt",null,null,null],
  ["ag-fifthpendium.equipment","phbagClothesTrav","equipment","PHB 2024","Clothes, Traveler's","Одежда путешественника [Clothes, Traveler's]","Дорожная одежда [Traveler's Clothes]","clothes-travelers","clothing",null,null],
  ["ag-fifthpendium.equipment","phbagDruidicFocu","loot","PHB 2024","Druidic Focus (Varies)","Фокусирующий предмет друида (различный) [Druidic Focus (Varies)]","Фокусировка друидов [Druidic Focus]","druidic-focus-varies","gear","",null],
  ["ag-fifthpendium.equipment","phbagHolySymbolV","loot","PHB 2024","Holy Symbol (Varies)","Символ религии (различный) [Holy Symbol (Varies)]","Священный символ [Holy Symbol]","holy-symbol-varies","gear","",null],
  ["ag-fifthpendium.equipment","phbagPoisonBasic","consumable","PHB 2024","Poison, Basic","Обычный яд [Poison, Basic]","Простой яд [Basic Poison]","basic-poison","poison","contact",null],
  ["ag-fifthpendium.equipment","phbagPotIron0000","container","PHB 2024","Pot, Iron","Чугунный котелок [Pot, Iron]","Железный горшок [Iron Pot]","pot-iron",null,null,null],
  ["ag-fifthpendium.equipment","phbagRamPortable","consumable","PHB 2024","Ram, Portable","Ручной таран [Ram, Portable]","Портативный таран [Portable Ram]","ram-portable","","",null],
  ["ag-fifthpendium.equipment","phbagSpikesIron0","consumable","PHB 2024","Spikes, Iron","Железные гвозди [Spikes, Iron]","Железные шипы [Iron Spikes]","spikes-iron","","",null],
  ["ag-fifthpendium.equipment","phbamoBolts00000","consumable","PHB 2024","Bolts","Арбалетные болты [Bolts]","Болты [Crossbow Bolts]","bolts","ammo","crossbowBolt",null],
  ["ag-fifthpendium.equipment","phbamoBulletsFir","consumable","PHB 2024","Bullets, Firearm","Пули для огнестрельного оружия [Bullets, Firearm]","Пули [Firearm Bullets]","bullets-firearm","ammo","firearmBullet",null],
  ["ag-fifthpendium.equipment","phbamoBulletsSli","consumable","PHB 2024","Bullets, Sling","Ядра для пращи [Bullets, Sling]","Снаряды для пращи [Sling Bullets]","bullets-sling","ammo","slingBullet",null],
  ["ag-fifthpendium.equipment","phbdfcYewwand000","equipment","PHB 2024","Yew Wand","Тисовый жезл [Yew Wand]","Тисовая палочка [Yew wand]","yew-wand","",null,null],
  ["ag-fifthpendium.equipment","phbgstDragonches","tool","PHB 2024","Dragonchess","Драконьи шахматы [Dragonchess]","Драконьи шахматы [Dragon Chess]","dragonchess","game",null,null],
  ["ag-fifthpendium.equipment","phbgstPlayingcar","tool","PHB 2024","Playing Cards","Игральные карты [Playing Cards]","Игральные карты [Gaming Cards]","playing-cards","game",null,null],
  ["ag-fifthpendium.feats","phbBoonofSkill00","feat","PHB 2024","Boon of Skill","Дар умения в навыках [Boon of Skill]","Дар умелости [Boon of Skill Proficiency]","epic-boon-of-skill-proficiency","feat","epicBoon",null],
  ["ag-fifthpendium.feats","phbftFeyTouched0","feat","PHB 2024","Fey-Touched","Отмеченный феями [Fey-Touched]","Затронутый феями [Fey Touched]","fey-touched","feat","general",null],
  ["ag-fifthpendium.feats","phbftShadowTouch","feat","PHB 2024","Shadow-Touched","Отмеченный тенями [Shadow-Touched]","Затронутый тенью [Shadow Touched]","shadow-touched","feat","general",null],
  ["ag-fifthpendium.classes","phbinvEldritchSm","feat","PHB 2024","Eldritch Smite","Потусторонняя кара [Eldritch Smite]","Мистическая кара [Eldrich Smite]","eldritch-smite","class","eldritchInvocation",null],
  ["ag-fifthpendium.classes","phbinvEldritchSp","feat","PHB 2024","Eldritch Spear","Потустороннее копьё [Eldritch Spear]","Мистическое копьё [Eldrich Spear]","eldritch-spear","class","eldritchInvocation",null],
  ["ag-fifthpendium.classes","phbinvGiftoftheD","feat","PHB 2024","Gift of the Depths","Дар глубин [Gift of the Depths]","Дар глубин [Gift of The Depth]","gift-of-the-depths","class","eldritchInvocation",null],
  ["ag-fifthpendium.classes","phbinvGiftoftheP","feat","PHB 2024","Gift of the Protectors","Дар защитников [Gift of the Protectors]","Дар защитников [Gift of The Protectors]","gift-of-the-protectors","class","eldritchInvocation",null],
  ["ag-fifthpendium.classes","phbinvInvestment","feat","PHB 2024","Investment of the Chain Master","Дар мастера цепи [Investment of the Chain Master]","Облачение хозяина цепи [Investment of The Chain Master]","investment-of-the-chain-master","class","eldritchInvocation",null],
  ["ag-fifthpendium.classes","phbinvLessonsoft","feat","PHB 2024","Lessons of the First Ones","Уроки Первых [Lessons of the First Ones]","Уроки древних [Lessons of The First One]","lessons-of-the-first-ones","class","eldritchInvocation",null],
  ["ag-fifthpendium.classes","phbinvOnewithSha","feat","PHB 2024","One with Shadows","Единство с тенями [One with Shadows]","Один среди теней [One With Shadows]","one-with-shadows","class","eldritchInvocation",null],
  ["ag-fifthpendium.classes","phbinvPactChain0","feat","PHB 2024","Pact of the Chain","Договор цепи [Pact of the Chain]","Договор цепи [Pact of The Chain]","pact-of-the-chain","class","eldritchInvocation",null],
  ["ag-fifthpendium.classes","phbinvPactTome00","feat","PHB 2024","Pact of the Tome","Договор книги [Pact of the Tome]","Договор гримуара [Pact of The Tome]","pact-of-the-tome","class","eldritchInvocation",null],
  ["ag-fifthpendium.classes","phbinvWhispersOf","feat","PHB 2024","Whispers of the Grave","Загробный шёпот [Whispers of the Grave]","Могильный шёпот [Whispers of The Grave]","whispers-of-the-grave","class","eldritchInvocation",null],
  ["ag-fifthpendium-forgotten-realms.options","abohTreacheousAl","feat","ABoH","Treacherous Allure","Коварное обаяние [Treacherous Allure]","Коварное обаяние [Treacheous Allure]","treacherous-allure","feat","general",null],
  ["ag-fifthpendium-forgotten-realms.options","hofChondatanFree","background","HoF","Chondathan Freebooter","Чондатский флибустьер [Chondathan Freebooter]","Чондатский флибустьер [Chondatan Freebooter]","chondatan-freebooter",null,null,null],
  ["ag-fifthpendium-forgotten-realms.options","hofOathOfNobleGe","subclass","HoF","Oath of the Noble Genies","Клятва благородных гениев [Oath of the Noble Genies]","Клятва благородных гениев [Oath of Noble Genies]","noble-genies",null,null,"paladin"],
  ["ag-fifthpendium-forgotten-realms.items","hofAdventurersRi","equipment","HoF","Adventurer's Ring","Кольцо искателя приключений [Adventurer's Ring]","Кольцо искателя приключений [Ring of Adventurer]","ring-of-adventurer","ring",null,null],
].map(row => [`Compendium.${row[0]}.Item.${row[1]}`, row]));
