import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {collectRuntimeModelCredentials,resolveProviderModel} from '../../src/features/ai/modelProviderFailover.js';
import {isOfflineModelAllowed} from '../../src/features/ai/offlineModelReliability.js';
const source=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
test('explicit GPT image generation selects a validated compatible-model route',()=>{
 assert.match(source,/const nativeImageModel = Boolean\(/u);
 assert.match(source,/modelLadder: pinnedImageModel \? \[\{ model: requestedModel, mode: 'default', attempts: 1 \}\] : null/u);
 assert.match(source,/useCredentialHealth: !enrichedOptions\?\.exactModel/u);
});
test('all previously audited summary image models have candidate credentials',()=>{
 const credentials=collectRuntimeModelCredentials({OPENAI_COMPAT_API_KEY:'synthetic-key-only-for-test',OPENAI_COMPAT_BASE_URL:'https://router.cheap/v1'});
 assert.equal(credentials.length,1);
 for(const model of ['gpt-image-2.5','gpt-image-2','gpt-image-2.5-flare','gpt-image-2.5-sunburst']){
  const found=resolveProviderModel({credential:credentials[0],capability:'image',mode:'default',requestedModel:model});
  assert.equal(found,model);
  assert.equal(isOfflineModelAllowed({provider:'openai-compatible',envName:'OPENAI_COMPAT_API_KEY',model,capability:'image'}),true,model);
 }
});
