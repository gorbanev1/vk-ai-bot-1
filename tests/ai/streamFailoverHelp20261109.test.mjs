import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createExplicitStreamProviderError,finalizeChatStreamFailure} from '../../src/features/ai/streamProviderFailure.js';
import {isTechnicalModelFailure,executeRuntimeModelFailover,resetRuntimeModelCredentialHealth} from '../../src/features/ai/modelProviderFailover.js';
import {isRetryableOpenAITextError} from '../../src/features/ai/openAIRetryRouting.js';
import {resolveHelpContextProfile} from '../../src/features/routing/helpContextProfile.js';
import {parseTopicHelp,formatTopicHelp} from '../../src/features/routing/topicHelpRouting.js';

test('original GPT Team/Plus SSE 500 with no output can advance model ladder',async()=>{
 const error=finalizeChatStreamFailure(createExplicitStreamProviderError({
  error:{message:'Внешний провайдер временно недоступен (статус 500). Попробуйте позже. (request id: 202611090822149460396048268d9d6JLMakWoh)'}
 }),{accumulatedText:'',requestTimeout:false,streamBytesReceived:348});
 assert.equal(error.status,500);
 assert.equal(error.code,'GPT_STREAM_ERROR');
 assert.equal(error.inferenceMayHaveStarted,false);
 assert.equal(error.retryable,true);
 assert.equal(isTechnicalModelFailure(error),true);
 assert.equal(isRetryableOpenAITextError(error),true);
 resetRuntimeModelCredentialHealth();
 const candidates=[{name:'key1',secret:'one',provider:'compat',baseUrl:'https://one.test'},
                   {name:'key2',secret:'two',provider:'compat',baseUrl:'https://two.test'}];
 const calls=[];
 const result=await executeRuntimeModelFailover({
   candidates,request:async c=>{calls.push(c.name);if(c.name==='key1')throw error;return 'answer-from-second-model';},
   shouldRetry:isTechnicalModelFailure,attemptsForCandidate:()=>1,
   maxRounds:1,useCredentialHealth:false,sleep:async()=>{}
 });
 assert.equal(result.value,'answer-from-second-model');
 assert.deepEqual(calls,['key1','key2']);
});
test('SSE 500 after partial output or with responseId never triggers another paid request',()=>{
 for(const options of [{accumulatedText:'частичный ответ'},{accumulatedText:'',responseId:'resp_123'}]){
  const error=createExplicitStreamProviderError({error:{status:500,message:'temporary overload'}});
  if(options.responseId)error.responseId=options.responseId;
  finalizeChatStreamFailure(error,{accumulatedText:options.accumulatedText});
  assert.equal(error.inferenceMayHaveStarted,true,'partial output OR durable response ID is already an inference');
  if(options.responseId)assert.equal(isTechnicalModelFailure(error),false);
  else assert.equal(isTechnicalModelFailure(error),false);
 }
});
test('HTTP 400 is not retried as an infrastructure failure; 503 is',()=>{
 const invalid=finalizeChatStreamFailure(createExplicitStreamProviderError({error:{status:400,message:'bad request'}}));
 assert.equal(invalid.retryable,undefined);
 assert.equal(isTechnicalModelFailure(invalid),false);
 const retry=finalizeChatStreamFailure(createExplicitStreamProviderError({error:{status:503,message:'upstream unavailable'}}));
 assert.equal(retry.retryable,true);
});
test('owner help in group differs from public and private; owner DM still privileged',()=>{
 const pub=resolveHelpContextProfile({platform:'vk',isPrivate:false,isOwner:false});
 const ownerChat=resolveHelpContextProfile({platform:'vk',isPrivate:false,isOwner:true});
 const ownerDm=resolveHelpContextProfile({platform:'vk',isPrivate:true,isOwner:true});
 const dm=resolveHelpContextProfile({platform:'vk',isPrivate:true,isOwner:false});
 assert.equal(pub.id,'vk-chat');
 assert.equal(ownerChat.id,'vk-owner-chat');
 assert.equal(ownerDm.id,'owner');
 assert.equal(dm.id,'vk-dm');
 assert.match(ownerChat.title,/ВЛАДЕЛЬЦА/u);
 assert.match(ownerDm.title,/ЛС/u);
});
test('topic help documents live parties, schedule and statistics commands',()=>{
 assert.equal(parseTopicHelp('Гигорейв справка тусы'),'parties');
 assert.equal(parseTopicHelp('авторезюме помощь'),'summary');
 const parties=formatTopicHelp('parties',{isPrivate:false});
 assert.match(parties,/где кураж/u);
 assert.match(parties,/без QTickets|БЕЗ QTickets/u);
 const summary=formatTopicHelp('summary',{isPrivate:false});
 assert.match(summary,/9:00 17:00 22:00/u);
 assert.match(summary,/средне/u);
 const stats=formatTopicHelp('stats',{isPrivate:false});
 assert.match(stats,/статистика выкл/u);
 const dossier=formatTopicHelp('dossier',{isPrivate:false});
 assert.match(dossier,/VK user_id/u);
});
test('main production paths actually integrate group mini dossier, safe SSE fallback and separated help',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(app,/function getCrossChatMiniPrompt\(/u);
 assert.equal((app.match(/getCrossChatMiniPrompt\(context\),/gu)||[]).length,2);
 assert.match(app,/throw createExplicitStreamProviderError\(payload\)/u);
 assert.match(app,/finalizeChatStreamFailure\(error, \{ accumulatedText, requestTimeout, streamBytesReceived: textStreamBytes \}\)/u);
    assert.match(app, /КОМАНДЫ В БЕСЕДЕ/u);
 assert.match(app,/ownerCommands/u);
});
