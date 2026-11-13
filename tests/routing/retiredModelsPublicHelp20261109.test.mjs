import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {extractExplicitGptMode,resolvePrashnaGptMode} from '../../src/features/ai/gptModeRouting.js';
import {getModelAliasCatalog,resolveModelAlias,validateModelLadderProfiles,DEFAULT_MODEL_LADDER_PROFILES,parseModelLadderCommand} from '../../src/features/ai/modelLadderProfiles.js';
import {getTopicHelpDirectoryLines,formatTopicHelp} from '../../src/features/routing/topicHelpRouting.js';
import {getAstrologyHelpLines} from '../../src/features/routing/helpContextProfile.js';
test('obsolete GPT versions are no longer selectable and stale ladders are sanitized',()=>{
 for(const input of ['gpt54 анализ','gpt55 анализ','GPT-5.4 анализ','GPT-5.5 анализ']){const r=extractExplicitGptMode(input);assert.equal(r.mode,'default');assert.equal(r.body,input)}
 for(const model of ['gpt54','gpt55','gpt-5.4','gpt-5.5','5.5'])assert.equal(resolveModelAlias(model),null);
 assert.equal(resolvePrashnaGptMode('gpt54'),'default');
 assert.equal(parseModelLadderCommand('лестница изменить\nчат:\ngpt-5.5 1').action,'invalid');
 const profiles=validateModelLadderProfiles({chat:[{model:'gpt-5.5',attempts:1},{model:'gpt-6-luna',attempts:1}],conversation:[{model:'gpt-5.4',attempts:2}]});
 assert.deepEqual(profiles.chat.map(x=>x.model),['gpt-6-luna']);
 assert.equal(profiles.conversation[0].model,'gpt-6-luna');
 assert.equal(getModelAliasCatalog().some(x=>x.id==='gpt-5.5'),false);
 for(const steps of Object.values(DEFAULT_MODEL_LADDER_PROFILES))assert.equal(steps[0].model,'gpt-6-luna');
});
test('public help highlights HuEnglish but hides technical parser and owner operations',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const chat=app.slice(app.indexOf('const chatCommands = ['),app.indexOf('const dmCommands = ['));
 assert.match(chat,/ХУИНГЛИШ/u);assert.match(chat,/GPT-6 Luna/u);assert.match(chat,/пиши все активные/u);
 assert.doesNotMatch(chat,/лс участникам|моноанонс|дедуп|парсер все/iu);
 assert.doesNotMatch(app,/gpt54|gpt55|gpt-5\.4|gpt-5\.5/iu);
 assert.match(chat,/ownerMode \? \[/u);
});
test('topic help restricts parser, API, process commands to owner DM',()=>{
 const chat=getTopicHelpDirectoryLines({isPrivate:false,isOwner:false,platform:'vk'}).join('\n');
 assert.match(chat,/хуинглиш/u);assert.doesNotMatch(chat,/парсер помощь|api помощь|процессы помощь/iu);
 assert.match(getTopicHelpDirectoryLines({isPrivate:true,isOwner:true}).join('\n'),/парсер помощь/u);
 assert.match(formatTopicHelp('parsers',{isPrivate:false,isOwner:true}),/только владельцу в личных сообщениях/u);
 assert.match(formatTopicHelp('parsers',{isPrivate:true,isOwner:true}),/ИСТОЧНИКИ/u);
 assert.match(formatTopicHelp('huinglish'),/хуинглиш далее/u);
});
test('Swiss Ephemeris remains local-first regardless of platform',()=>{
 for(const platform of ['vk','telegram']){const lines=getAstrologyHelpLines({platform}).join('\n');
 assert.match(lines,/Swiss Ephemeris/u);assert.match(lines,/GPT-6 Luna/u);
 if(platform==='telegram')assert.doesNotMatch(lines,/прашн/iu);
 }
});
