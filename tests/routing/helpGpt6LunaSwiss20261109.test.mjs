import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {getAstrologyHelpLines,resolveHelpContextProfile} from '../../src/features/routing/helpContextProfile.js';
import {buildModelLadderHelp,DEFAULT_MODEL_LADDER_PROFILES} from '../../src/features/ai/modelLadderProfiles.js';
import {resolveAstrologyExecution} from '../../src/features/astrology/astrologyRouting.js';
test('all platform/DM/owner astrology help is Swiss-local first and never calls obsolete 5.4/5.5 primary models',()=>{
 for(const platform of ['vk','telegram'])for(const isPrivate of [true,false]){
  const text=getAstrologyHelpLines({platform,isPrivate}).join('\n');
  assert.match(text,/Swiss Ephemeris/u);
  assert.match(text,/GPT-6 Luna/u);
  assert.doesNotMatch(text,/gpt54|gpt55|GPT-5\.4|GPT-5\.5|mini\/gpt54|Swiss Ephemeris\/Moshier/iu);
  assert.match(text,/«нелокал» не отключает/u);
  if(platform==='telegram')assert.doesNotMatch(text,/Прашна:/u);
  else assert.match(text,/Прашна:/u);
 }
});
test('local calculation requirement is identical for every named mode and explicit nonlocal cannot bypass it',()=>{
 for(const kind of ['natal','prashna'])for(const mode of ['default','pro','pro2','pro3','astra']){
  const result=resolveAstrologyExecution({kind,mode,nonLocalRequested:true});
  assert.equal(result.localCalculation,true);
  assert.equal(result.packet,'maximum');
  assert.equal(result.modelCalculation,false);
 }
});
test('user-facing owner ladder aliases do not advertise GPT-5.5, while Luna is first',()=>{
 const text=buildModelLadderHelp();
 assert.doesNotMatch(text,/gpt-5\.5:/u);
 assert.match(text,/gpt-6-luna/u);
 for(const p of Object.values(DEFAULT_MODEL_LADDER_PROFILES))assert.equal(p[0].model,'gpt-6-luna');
});
test('chat and DM help source sections label GPT-6 Luna first and omit gpt54/gpt55',()=>{
 const a=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const s=a.slice(a.indexOf('async function sendHelp(context) {'),a.indexOf('\nasync function ',a.indexOf('async function sendHelp(context) {')+50));
 assert.match(s,/GPT-6 Luna/u);
 assert.doesNotMatch(s,/'• gpt54|'\u2022 gpt55/iu);
 assert.match(s,/пиши все активные/u);
});
test('all help contexts still differentiated',()=>{
 assert.equal(resolveHelpContextProfile({platform:'vk',isPrivate:true,isOwner:true}).id,'owner');
 assert.equal(resolveHelpContextProfile({platform:'vk',isPrivate:false,isOwner:false}).id,'vk-chat');
 assert.equal(resolveHelpContextProfile({platform:'telegram',isPrivate:false,isOwner:false}).id,'telegram-chat');
});
