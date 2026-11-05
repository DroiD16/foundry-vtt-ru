import {project, safeName} from "../../src/systems/dnd5e/ddb-ag/projector.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import vm from 'node:vm';
import {createAgCatalog, AG_PROVIDERS} from '../../src/systems/dnd5e/ddb-ag/catalog.js';
import {Resolver} from '../../src/systems/dnd5e/ddb-ag/resolver.js';
import {readRawIndex, readRawDocuments} from '../../src/systems/dnd5e/ddb-ag/raw-reader.js';
const row=(name='Bless',type='spell')=>({_id:name,name,type,system:{source:{book:'PHB 2024',rules:'2024'}}});
const native=d=>({...d,flags:{ddbimporter:{originalName:d.name}}});
test('two active Bless providers fail closed on unreadable/incompatible pack; inactive optional and proven disjoint names do not block',async()=>{
 for(const mode of ['both','unreadable','incompatible','inactive','disjoint','disjoint-type','disjoint-publication']){
  const ids=AG_PROVIDERS.slice(0,2), packs=new Map(ids.map((id,i)=>{
   const collection=`${id}.spells`;
   return [collection,{collection,metadata:{packageName:id},documentName:'Item',getIndex:async()=>{
    if(i&&mode==='unreadable')throw Error('unavailable');
    const d=row(i&&mode==='disjoint'?'Bane':'Bless',i&&mode==='disjoint-type'?'weapon':'spell');
    if(i&&mode==='disjoint-publication')d.system.source.book='EFA';
    return new Map([[d._id,d],...(i&&['incompatible','disjoint','disjoint-type','disjoint-publication'].includes(mode)?[['bad',row('Class','class')]]:[])]);
   }}];
  }));
  const modules=new Map(ids.map((id,i)=>[id,{active:!(i&&mode==='inactive')}]));
  const catalog=createAgCatalog({game:{packs,modules}});await catalog.ready();assert.equal(catalog.nameFor({name:'No identity'}),null);
  const reasons=[];const resolver=new Resolver({providers:catalog.providers,modules,diagnostics:d=>reasons.push(d.reason),readUuid:async()=>row()});resolver.catalog=catalog;
  const result=await resolver.resolve(native(row()));
  if(['inactive','disjoint','disjoint-type','disjoint-publication'].includes(mode))assert.ok(result,mode);
  else {assert.equal(result,null,mode);assert.equal(reasons.at(-1),mode==='both'?'ambiguous-identity':'provider-incompatible');assert.equal(catalog.nameFor(native(row())),null);}
  if(['unreadable','incompatible'].includes(mode))assert.ok(catalog.status().some(s=>!s.compatible));
 }
});
const backend=process.env.DDB_AG_FOUNDRY_BACKEND, queryEngine=process.env.DDB_AG_FOUNDRY_QUERY;
test('actual Foundry public get configures broadcast, preserves symbol/user, uses native query engine and explicit metadata fields', {skip:!backend||!queryEngine||!existsSync(backend)||!existsSync(queryEngine)?'Set DDB_AG_FOUNDRY_BACKEND and DDB_AG_FOUNDRY_QUERY to actual Foundry sources':false},async t=>{
 const saved=['CONFIG','game'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]);t.after(()=>{for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}});
 const Backend=vm.runInNewContext(readFileSync(backend,'utf8').replace(/^import .*;$/m,'').replace('export default class DatabaseBackend','class DatabaseBackend')+'\nDatabaseBackend',{Document:class{}});
 const Query=vm.runInNewContext(readFileSync(queryEngine,'utf8').replace(/^import.*?;import.*?;/,'').replace('export default class SublevelDatabase','class SublevelDatabase')+';SublevelDatabase',{AbstractSublevel:class {async *values(){yield row();yield row('Bane');}},isPlainObject:v=>v!==null&&typeof v==='object'&&!Array.isArray(v)});
 const engine=new Query(), requests=[], marker=Symbol('ownRawRead'), user={id:'actual-user'};
 class Item {static documentName='Item';}
 class Actual extends Backend {
  getCompendiumScopes(){return ['world.ddb'];}
  // Emulate the future PLUMBING call-site addition without importing its unreviewed runtime.
  async get(cls, operation, who){operation[marker]=true;return super.get(cls,operation,who);}
  async _getDocuments(cls,operation,who){assert.equal(who,user);assert.equal(operation[marker],true);assert.equal(operation.broadcast,false);assert.equal(operation.action,'get');requests.push(structuredClone({...operation,[marker]:undefined}));return engine.find(operation.query);}
 }
 globalThis.CONFIG={DatabaseBackend:new Actual()};globalThis.game={user,packs:new Map([['world.ddb',{documentClass:Item,getIndex:()=>assert.fail('cache write/read'),getDocuments:()=>assert.fail('cache read')}]]),babele:{translatedCompendiumFor:()=>null}};
 const index=await readRawIndex('world.ddb',['type','system.source']);assert.equal(index.length,2);assert.deepEqual(requests[0].indexFields,['name','img','type','system.source']);
 assert.equal((await readRawDocuments('world.ddb',['Bless']))[0]._id,'Bless');assert.equal((await readRawDocuments('world.ddb',['missing'])).length,0);
 assert.equal((await engine.find({_id:{$in:['Bless']}})).length,0); // actual engine rejects Mongo syntax
 game.babele.translatedCompendiumFor=()=>({});await assert.rejects(readRawIndex('world.ddb'),/raw-unavailable/);assert.equal(requests.length,3);
});

test('typed catalog grants allow Paladin 7 and Arcane Trickster 3; multiclass Spellcasting remains ambiguous; grants stay run-local',async()=>{
 const parents=[['Paladin','class',null,7],['Rogue','class',null,3],['Arcane Trickster','subclass','rogue',3],['Wizard','class',null,10],['Druid','class',null,3],['Farmer','background',null,undefined]];
 const docs=new Map();
 const targets=[['Extra Attack','extra','Paladin',5],['Spellcasting','palspell','Paladin',1],['Spellcasting','rogspell','Arcane Trickster',3],['Spellcasting','wizspell','Wizard',1],['Spellcasting','druspell','Druid',1],['Tough','tough','Farmer',0]];
 const uuid=id=>`Compendium.ag-fifthpendium.classes.Item.${id}`;
 for(const [name,kind,classIdentifier]of parents){const d=row(name,kind);d.system.identifier=name.toLowerCase();d.system.classIdentifier=classIdentifier;d.system.advancement=targets.filter(t=>t[2]===name).map(t=>({type:'ItemGrant',level:t[3],configuration:{items:[uuid(t[1])]}}));docs.set(uuid(name),d);}
 for(const[name,id]of targets){const d=row(name,'feat');d._id=id;d.system.type={value:id==='tough'?'background':'class'};docs.set(uuid(id),d);}
 const collection='ag-fifthpendium.classes',modules=new Map([['ag-fifthpendium',{active:true}]]);
 const catalog=createAgCatalog({game:{modules,packs:new Map([[collection,{collection,documentName:'Item',metadata:{packageName:'ag-fifthpendium'},getIndex:async()=>new Map([...docs.values()].map(d=>[d._id,d]))}]])}});await catalog.ready();
 const reasons=[],r=new Resolver({providers:catalog.providers,modules,readUuid:async id=>structuredClone(docs.get(id)),diagnostics:d=>reasons.push(d.reason)});r.catalog=catalog;
 const display=new Resolver({providers:catalog.providers,modules,readUuid:async id=>structuredClone(docs.get(id))});display.catalog=catalog;
 const feature=native(docs.get(uuid('extra')));
 assert.equal(await display.resolve(feature),null);
 const before=structuredClone(catalog.providers);
 const context=names=>parents.filter(p=>names.includes(p[0])).map(([name,kind,classIdentifier,level])=>({name,kind,classIdentifier,level,identifier:name.toLowerCase(),rules:'2024',source:'PHB 2024'}));
 for(const[names,checks]of [[['Paladin'],[['Extra Attack','extra'],['Spellcasting','palspell']]],[['Rogue','Arcane Trickster'],[['Spellcasting','rogspell']]],[['Farmer'],[['Tough','tough']]]]){
  const ps=context(names);await r.prepareParents(ps);
  for(const[name,id]of checks)assert.equal((await r.resolve(native(docs.get(uuid(id))),{parents:ps}))?.entry.uuid,uuid(id));
  assert.equal(await display.resolve(feature),null,"PC grant history cannot change compendium matching");
  assert.equal(display.runGrants,undefined);

 }
 const ps=context(['Wizard','Druid']);await r.prepareParents(ps);assert.equal(await r.resolve(native(docs.get(uuid('wizspell'))),{parents:ps}),null);assert.equal(reasons.at(-1),'ambiguous-identity');
 assert.deepEqual(catalog.providers,before);
 // Missing background level permits exactly the neutral level-zero grant, not invented progression.
 docs.get(uuid('Farmer')).system.advancement[0].level=1;r.cache.clear();await r.prepareParents(context(['Farmer']));assert.equal(await r.resolve(native(docs.get(uuid('tough'))),{parents:context(['Farmer'])}),null);
});

test('native PC names require positive safe integer DDB id and definitionId',()=>{
 const item={name:'Backpack',type:'container',flags:{ddbimporter:{id:17,definitionId:42}},system:{description:{value:'Control.'}}};
 const text={name:'Рюкзак [Backpack]'};
 assert.equal(safeName(item,{nativeRoot:true}),true);
 for(const id of [0,-1,1.5,'17',Number.MAX_SAFE_INTEGER+1,undefined]){
  const invalid=structuredClone(item);invalid.flags.ddbimporter.id=id;
  assert.equal(project(invalid,text,{nativeRoot:true}).name,undefined);
 }
});
