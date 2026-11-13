import assert from 'node:assert/strict';
import {
 executeOpenAIModelChainRecovery,executeOpenAITextRecovery,
 getNextAdvancedGptModes,isRetryableOpenAITextError,selectOpenAIRetryDelayMs,
} from '../../src/features/ai/openAIRetryRouting.js';

assert.equal(selectOpenAIRetryDelayMs(()=>0),5000);
assert.equal(selectOpenAIRetryDelayMs(()=>0.99999999),30000);
assert.deepEqual(getNextAdvancedGptModes('default'),['pro3','astra']);
assert.deepEqual(getNextAdvancedGptModes('pro3'),['astra']);
assert.deepEqual(getNextAdvancedGptModes('astra'),[]);
assert.equal(isRetryableOpenAITextError(new Error('GPT API 503: upstream busy')),true);
assert.equal(isRetryableOpenAITextError(new Error('GPT network error: fetch failed')),true);
assert.equal(isRetryableOpenAITextError(new Error('GPT API 401: invalid api key')),false);
const attempts=[],events=[];
const recovered=await executeOpenAITextRecovery({
 initialModel:'gpt-6-luna',random:()=>0,sleep:async delay=>assert.equal(delay,5000),
 request:async model=>{attempts.push(model);if(attempts.length<=2)throw Error('GPT API 503: temporarily unavailable');return 'готово';},
 resolveFallback:async()=>({mode:'pro3',model:'gpt-6.1-sol'}),
 onEvent:e=>events.push(e.type),
});
assert.deepEqual(attempts,['gpt-6-luna','gpt-6-luna','gpt-6.1-sol']);
assert.deepEqual(events,['retry','fallback']);
assert.equal(recovered.value,'готово');
assert.equal(recovered.mode,'pro3');
assert.equal(recovered.model,'gpt-6.1-sol');
const chainCalls=[];
const chain=await executeOpenAIModelChainRecovery({
 candidates:[{mode:'default',model:'gpt-6-luna'},
 {mode:'pro3',model:'gpt-6.1-sol'},
 {mode:'astra',model:'gpt-6-astra'}],
 random:()=>0,sleep:async()=>{},
 request:async model=>{chainCalls.push(model);if(model!=='gpt-6-astra')throw Error('GPT vision API 400: unsupported image');return 'изображение распознано';},
});
assert.equal(chain.value,'изображение распознано');
assert.deepEqual(chainCalls,['gpt-6-luna','gpt-6-luna','gpt-6.1-sol','gpt-6.1-sol','gpt-6-astra']);
console.log('OpenAI retry policy tests: OK');
