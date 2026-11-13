import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {getAstrologyRequestKind,resolveAstrologyExecution} from '../../src/features/astrology/astrologyRouting.js';
import {getResponseLengthProfile} from '../../src/features/ai/responseLengthRouting.js';
import {getAstrologyHelpLines,isPrashnaAllowedForPlatform,resolveHelpContextProfile} from '../../src/features/routing/helpContextProfile.js';
const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
test('Telegram prashna is enabled for owner and ordinary group and private users',()=>{
 assert.equal(isPrashnaAllowedForPlatform('telegram'),true);
 for(const isPrivate of [true,false])for(const isOwner of [true,false])
  assert.equal(resolveHelpContextProfile({platform:'telegram',isPrivate,isOwner}).prashnaEnabled,true);
});
test('do not advertise prashna in Telegram help',()=>{
 for(const isPrivate of [true,false])assert.doesNotMatch(getAstrologyHelpLines({platform:'telegram',isPrivate}).join('\n'),/прашн|prashna|horary|хорар/iu);
});
test('Telegram does not reject the actual prashna request before local calculation',()=>{
 assert.doesNotMatch(app,/blockTelegramPrashnaIfNeeded|TELEGRAM PRASHNA BLOCKED|Прашна в Telegram отключена/);
 assert.equal(getAstrologyRequestKind('прашна Воронеж — как пройдёт вечер?'),'prashna');
});
test('prashna local Swiss Ephemeris first, maximum packet, no model primary calculation',()=>{
 const x=resolveAstrologyExecution({kind:'prashna',mode:'default'});
 assert.equal(x.localCalculation,true);assert.equal(x.packet,'maximum');assert.equal(x.modelCalculation,false);
});
test('Telegram default prashna receives detailed output profile',()=>{
 const detailed=getResponseLengthProfile('прашна Воронеж подробно',{prashna:true});
 assert.equal(detailed.name,'prashna-detailed');assert(detailed.maxCompletionTokens>=8000);
 assert.match(app,/telegramPrashnaRequest \? prompt \+ ' подробно' : prompt/);
});
test('Telegram prashna cannot be downgraded to low or medium reasoning',()=>{
 assert.match(app,/const astrologyReasoningEffort = telegramPrashnaRequest \? 'high'/);
 assert.match(app,/if \(telegramPrashnaRequest\) \{\s*requestOptions.reasoningEffort = 'high'/);
 assert.match(app,/requestOptions.reasoningEffortAuto = false/);
 assert.match(app,/requestOptions.modelLadder = requestOptions.modelLadder.map/);
});
test('supplementary derived values are calculated only from verified local inputs',()=>{
 assert.match(app,/локальный Swiss Ephemeris и его аудит — обязательная первичная основа/);
 assert.match(app,/с прозрачными формулами и результатами/);
 assert.match(app,/не выдумывай их/);
});
