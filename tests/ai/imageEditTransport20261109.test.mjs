import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {buildImageEditMultipart,postOpenAIImageEdit} from '../../src/features/ai/imageEditTransport.js';
const png='data:image/png;base64,'+Buffer.from([137,80,78,71,13,10,26,10,0,0]).toString('base64');
test('photo edit passes binary source as multipart to /images/edits',async()=>{
 const calls=[];
 const res=await postOpenAIImageEdit({baseUrl:'https://provider.test/v1',apiKey:'test',model:'gpt-image-2.5',prompt:'дорисуй волосы',sourceImageDataUrls:[png],fetchImpl:async(url,options)=>{calls.push({url,options});return new Response('{}',{status:200})}});
 assert.equal(res.status,200);assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://provider.test/v1/images/edits');
 assert.equal(calls[0].options.body.getAll('image').length,1);
 assert.equal(calls[0].options.body.get('prompt'),'дорисуй волосы');
 assert.equal(calls[0].options.headers['Content-Type'],undefined);
});
test('missing/broken photo cannot silently become independent generation',async()=>{
 let calls=0;
 for(const sourceImageDataUrls of [[],['https://vk.ru/wrong'],['data:image/png;base64,aGVsbG8=']]){
  await assert.rejects(postOpenAIImageEdit({baseUrl:'https://provider.test/v1',apiKey:'test',model:'gpt-image-2.5',prompt:'волосы',sourceImageDataUrls,fetchImpl:async()=>{calls++;return new Response('{}')}}),/фото|исходн/iu);
 }
 assert.equal(calls,0);
});
test('alternate image[] form is used only after rejected multipart field',async()=>{
 const attempts=[];const res=await postOpenAIImageEdit({baseUrl:'https://provider.test/v1',apiKey:'test',model:'gpt-image-2.5',prompt:'волосы',sourceImageDataUrls:[png],fetchImpl:async(url,options)=>{attempts.push([...options.body.keys()]);return attempts.length===1?new Response('image[] required',{status:400}):new Response('{}',{status:200})}});
 assert.equal(res.status,200);assert.equal(attempts.length,2);
 assert.ok(attempts[1].includes('image[]'));
});
test('production passes source images to edit endpoint, not image generations',()=>{
 const a=readFileSync(process.env.GIGORAVE_STAGED_APP||new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const edit=a.slice(a.indexOf('async function sendGptEditedImage('),a.indexOf('async function sendGptGeneratedImage('));
 const router=a.slice(a.indexOf('async function generateOpenAIImageForCredential('),a.indexOf('async function generateOpenAIImageStreamEndpoint('));
 assert.match(edit,/sourceImageDataUrls:\s*preparedSourceImages/u);
 assert.doesNotMatch(edit,/userContent:\s*\[/u);
 assert.match(router,/generateOpenAIImageEditNonStream/u);
 assert.match(a,/postOpenAIImageEdit\(/u);
 assert.match(a,/images\/generations не принимает исходное фото/u);
});
