// Five reviewed description roles. These predicates only inspect mechanics; none are copied.
const sorted = values => [...(values ?? [])].sort();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const empty = value => value == null || value === '' || value === '{}' ||
  (typeof value === 'object' && !Object.keys(value).length);
const changesFor = role => role === 'ring-of-swimming'
  ? [['system.attributes.movement.swim', 'upgrade', 40]]
  : role === 'ring-of-protection'
    ? [['system.attributes.ac.bonus', 'add', 1], ['system.bonuses.abilities.save', 'add', 1]]
    : role === 'shield-of-erasmus'
      ? ['force', 'poison', 'psychic'].map(type => ['system.traits.dr.value', 'add', type])
      : null;
function effectMatches(role, child) {
  const expected = changesFor(role);
  if (!expected || child.type !== 'base' || sorted(child.statuses).length) return false;
  const views = [child.system?.changes, child.changes].filter(v => v !== undefined);
  return views.length > 0 && views.every(view => {
    const changes = Object.values(view);
    return changes.every(c => empty(c.conditions) && empty(c.replacement)) &&
      equal(changes.map(c => [c.key, c.type, c.value]).sort(), expected.toSorted());
  });
}
function sunbeamMatches(role, child, parent, donor) {
  if (!['sunbeam-initial', 'sunbeam-repeat'].includes(role)) return false;
  const part = child.damage?.parts?.[0], slot = role === 'sunbeam-initial';
  if (child.type !== 'save' || child.activation?.type !== 'action' ||
      !equal(sorted(child.save?.ability), ['con']) || child.save?.dc?.calculation !== 'spellcasting' ||
      !['', '0'].includes(child.save.dc.formula ?? '') || child.damage?.parts?.length !== 1 ||
      part.number !== 6 || part.denomination !== 8 || (part.bonus ?? '') !== '' ||
      !equal(sorted(part.types), ['radiant']) || part.custom?.enabled !== false ||
      (part.scaling?.mode ?? '') !== '' || (part.modifiers?.length ?? 0) || child.damage.onSave !== 'half' ||
      child.consumption?.spellSlot !== slot || child.consumption.targets?.length !== 0 ||
      child.consumption.scaling?.allowed !== false || child.duration?.units !== 'inst' ||
      !(parent.system?.properties ?? []).includes('concentration') ||
      String(parent.system.duration?.value) !== '1' || parent.system.duration.units !== 'minute') return false;
  const template = child.target?.override ? child.target.template : parent.system.target?.template;
  const range = child.range?.override ? child.range : parent.system.range;
  if (template?.type !== 'line' || String(template.size) !== '60' || template.units !== 'ft' ||
      !(donor ? ['5'] : ['', '5']).includes(String(template.width ?? '')) || range?.units !== 'self' || child.effects?.length !== 1) return false;
  const link = child.effects[0], effect = parent.effects?.find(e => e._id === link._id);
  if (!effect || link.onSave !== false || !equal(sorted(effect.statuses), ['blinded']) ||
      Object.values(effect.system?.changes ?? effect.changes ?? {}).length) return false;
  // The foreign AG linked effect is diagnostic only. It never becomes a text donor.
  return donor || (effect.duration?.expiry === 'sourceStart' && effect.duration.value == null);
}
export function matchesDescriptionRole(role, child, parent, donor = false) {
  return effectMatches(role, child) || sunbeamMatches(role, child, parent, donor) || reviewedExtra(role, child, parent, donor);
}

// Reviewed parent-scoped roles. Text comes from the installed, version-checked AG donor.
// These do not claim to validate arbitrary future prose edits by meaning or keywords.
function reviewedExtra(role, c, parent, donor) {
  const changes = Object.values(c.system?.changes ?? c.changes ?? {});
  const triples = changes.map(x => [x.key, x.type, x.value]).sort();
  const base = c.type === 'base';
  if (base && (!empty(c.system?.conditions) || changes.some(x => !empty(x.conditions) || !empty(x.replacement)))) return false;
  if (role === 'vampire-sunlight-20-radiant') {
    const p = c.damage?.parts?.[0];
    return c.type === 'damage' && c.damage.parts.length === 1 && !p.number && !p.denomination &&
      p.bonus === '20' && equal(sorted(p.types), ['radiant']) && p.custom?.enabled === false &&
      !(p.scaling?.mode) && (donor ? c.activation?.type === '' : c.activation?.type === 'turnStart');
  }
  if (role === 'transform-under-proven-spell')
    return c.type === 'transform' && c.activation?.type === 'action';
  if (role === 'sword-domination-until-demand-met')
    return base && !sorted(c.statuses).length && !changes.length;
  if (role === 'no-reactions')
    return base && !sorted(c.statuses).length && (donor ? !changes.length :
      equal(triples, [['flags.midi-qol.noReaction', 'custom', 1]]) && changes.every(x => empty(x.conditions) && empty(x.replacement)));
  const serum = {
    'serum-4d4-acid': {roll:'4d4',type:'acid',source:[['system.attributes.movement.bonus','add',-10]],extra:[['system.attributes.movement.walk','subtract',10]],statuses:['poisoned']},
    'serum-2d10-necrotic': {roll:'2d10',type:'necrotic',source:[['system.traits.di.value','add','healing']],extra:[],statuses:[]},
    'serum-3d6-psychic': {roll:'3d6',type:'psychic',source:[['system.attributes.concentration.roll.mode','add',-1]],extra:[['system.attributes.concentration.roll.mode','add',-1]],statuses:[]},
  }[role];
  if (!serum || !base || c.duration?.value !== 60 || c.duration.units !== 'seconds') return false;
  if (!donor) return equal(sorted(c.statuses), ['poisoned']) && equal(triples, serum.source) &&
    changes.every(x => empty(x.conditions) && empty(x.replacement));
  if (!equal(sorted(c.statuses), serum.statuses)) return false;
  const overtime = changes.filter(x => x.key === 'flags.midi-qol.OverTime' && x.type === 'custom');
  if (overtime.length !== 2 || changes.length !== overtime.length + serum.extra.length ||
      !equal(changes.filter(x => !overtime.includes(x)).map(x => [x.key,x.type,x.value]).sort(),serum.extra)) return false;
  // Parse only mechanical OverTime key/value fields, never natural-language claims or labels.
  const records = overtime.map(x => Object.fromEntries(String(x.value).split(',').map(part => part.trim().split('='))));
  return records.filter(x => x.turn === 'start' && x.rollType === 'damage' && x.damageRoll === serum.roll && x.damageType === serum.type).length === 1 &&
    records.filter(x => x.turn === 'end' && x.saveAbility === 'con' && x.saveDC === '16').length === 1;
}
