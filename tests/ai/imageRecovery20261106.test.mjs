import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { recoverImagePolicy, applyPromptRepairs, isImagePolicyRefusal, imageRecoveryOwnerMessage } from '../../src/features/ai/imagePolicyRecovery.js';
import { createImageRecoveryAudit } from '../../src/features/ai/imageRecoveryAudit.js';
import { createAutoSummaryIllustration } from '../../src/features/ai/autoSummaryIllustration.js';
import { validateVkPhotoUploadResult, retryVkPhotoUpload } from '../../src/platforms/vk/vkPhotoUploadRecovery.js';
const refusal = () => Object.assign(new Error('content policy violation'), {code:'content_policy_violation'});
const change = (before, after) => ({ changes: [{field:'userPrompt', before, after, reason:'Безопасная замена'}] });
const image = {buffer: Buffer.from('image')};

test('success generates once, without repair or audit', async () => {
    assert.equal(await recoverImagePolicy({userPrompt:'scene'}, { generate:async()=>image, repair:()=>assert.fail(), persist:()=>assert.fail() }), image);
});
test('policy refusal minimally patches prompt, records exact changes and notifies once', async () => {
    const inputs=[], records=[], reports=[];
    const result=await recoverImagePolicy({userPrompt:'Вишня в миске',systemPrompt:'Акварель'}, {
        generate:async options=>{inputs.push(options);if(inputs.length===1)throw refusal();return image;},
        repair:async()=>change('Вишня','Варенье'), persist:r=>records.push(structuredClone(r)), notify:r=>reports.push(r),
    });
    assert.equal(result,image); assert.equal(inputs[1].userPrompt,'Варенье в миске');assert.equal(inputs[1].systemPrompt,'Акварель');
    assert.equal(records.at(-1).status,'generated');assert.equal(records.at(-1).steps[0].changes[0].before,'Вишня');assert.equal(reports.length,1);
    assert.match(imageRecoveryOwnerMessage(reports[0]),/предположения/u);
});
test('five repairs maximum, outer summary ladder cannot restart the cycle',async()=>{
    let generations=0,repairs=0;
    await assert.rejects(createAutoSummaryIllustration({summaryText:'scene',generate:()=>recoverImagePolicy({userPrompt:'scene0'}, {
        generate:async()=>{generations++;throw refusal();}, repair:async()=>{const i=repairs++;return change('scene'+i,'scene'+(i+1));},
    })}),error=>error.imagePolicyRecoveryHandled);
    assert.equal(generations,6);assert.equal(repairs,5);
});
for (const [label,error] of [['network',new Error('fetch failed')],['quota',new Error('HTTP 429 quota')],['invalid',new Error('400 invalid size')],['auth',new Error('403 forbidden API key')]]) {
    test(label+' never rewrites the prompt',async()=>{
        let calls=0;
        await assert.rejects(recoverImagePolicy({userPrompt:'scene'}, {generate:async()=>{calls++;throw error;},repair:()=>assert.fail()}),e=>e===error);
        assert.equal(calls,1);
    });
}
test('unchanged/cyclic repairs stop',async()=>{
    let calls=0;
    await assert.rejects(recoverImagePolicy({userPrompt:'one'}, {generate:async()=>{calls++;throw refusal();},repair:async()=>calls===1?change('one','two'):change('two','one')}),/уже отклонённый/u);
    assert.equal(calls,2);
});
test('ambiguous or invented quotes are not applied',()=>{
    assert.throws(()=>applyPromptRepairs({userPrompt:'one one'},change('one','two')),/неоднозначен/u);
    assert.throws(()=>applyPromptRepairs({userPrompt:'one'},change('missing','two')),/отсутствует/u);
    assert.throws(()=>applyPromptRepairs({userPrompt:'one'},change('one','one')),/Некорректное/u);
});
test('edit input images are preserved and only declared text is changed',()=>{
    const original={userContent:[{type:'text',text:'one'},{type:'image_url',image_url:{url:'https://example.test/image.png'}}]};
    const proposal={changes:[{field:'userContent.0.text',before:'one',after:'two',reason:'safe'}]};
    const next=applyPromptRepairs(original,proposal).options;
    assert.deepEqual(next.userContent[1],original.userContent[1]);assert.equal(original.userContent[0].text,'one');assert.equal(next.userContent[0].text,'two');
});
test('cannot repair input image stops without resubmitting it',async()=>{
    let calls=0;
    await assert.rejects(recoverImagePolicy({userPrompt:'scene'}, {generate:async()=>{calls++;throw refusal();},repair:async()=>({cannotRepair:true,changes:[]})}));
    assert.equal(calls,1);
});
test('cancel during repair prevents another generation and persists cancellation',async()=>{
    const controller=new AbortController();let calls=0,last;
    await assert.rejects(recoverImagePolicy({userPrompt:'one'},{signal:controller.signal,generate:async()=>{calls++;throw refusal();},repair:async()=>{controller.abort();return change('one','two');},persist:r=>{last=structuredClone(r);}}));
    assert.equal(calls,1);assert.equal(last.status,'cancelled');
});
test('notification failure cannot regenerate or lose a paid image',async()=>{
    let calls=0;
    const result=await recoverImagePolicy({userPrompt:'one'},{generate:async()=>{if(++calls===1)throw refusal();return image;},repair:async()=>change('one','two'),notify:async()=>{throw new Error('offline');}});
    assert.equal(result,image);assert.equal(calls,2);
});
test('structured and wrapped provider policy errors recognized',()=>{
    assert.ok(isImagePolicyRefusal(new Error('outer',{cause:refusal()})));
    assert.ok(isImagePolicyRefusal({response:{data:{error:{code:'content_policy_violation'}}}}));
    assert.ok(isImagePolicyRefusal(new Error('GigaChat заблокировал создание изображения.')));
});
test('audit persists history and pending owner delivery across reopen',()=>{
    const directory=mkdtempSync(join(tmpdir(),'image-audit-'));const databasePath=join(directory,'audit.sqlite');
    const old=process.env.GIGORAVE_DB_PATH;process.env.GIGORAVE_DB_PATH=databasePath;
    try {
        const record={id:'test',createdAt:1,status:'generated',notification:'pending',steps:[{changes:[{before:'a',after:'b'}]}]};
        createImageRecoveryAudit({databasePath}).save(record);
        const reopened=createImageRecoveryAudit({databasePath});assert.deepEqual(reopened.pending(),[record]);
        reopened.save({...record,notification:'sent'});assert.deepEqual(reopened.pending(),[]);
    } finally {if(old===undefined)delete process.env.GIGORAVE_DB_PATH;else process.env.GIGORAVE_DB_PATH=old;rmSync(directory,{recursive:true,force:true});}
});
test('VK HTTP200 empty photo is retried before save; fresh successful response accepted',async()=>{
    let calls=0,saves=0;const waits=[];
    const result=await retryVkPhotoUpload(async()=>{
        const raw=++calls<3?{server:1,photo:'',hash:'hash'}:{server:1,photo:'[{"id":1}]',hash:'hash'};
        const valid=validateVkPhotoUploadResult(raw);saves++;return valid;
    },{wait:async ms=>waits.push(ms)});
    assert.equal(calls,3);assert.equal(saves,1);assert.deepEqual(waits,[5000,15000]);assert.equal(result.server,1);
});
test('persistent empty VK response stops after three attempts',async()=>{
    let calls=0;
    await assert.rejects(retryVkPhotoUpload(async()=>{calls++;return validateVkPhotoUploadResult({server:1,photo:'',hash:'h'});},{wait:async()=>{}}),e=>e.code==='VK_UPLOAD_EMPTY_PHOTO');
    assert.equal(calls,3);assert.throws(()=>validateVkPhotoUploadResult({server:1,photo:'[]',hash:'h'}));
});
test('incomplete VK protocol result is rejected without pretending to save',()=>{
    assert.throws(()=>validateVkPhotoUploadResult({server:1,photo:'x'}),e=>e.code==='VK_UPLOAD_INVALID_RESPONSE');
});
const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
const extract=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
test('NVIDIA, external provider and GigaChat use the same recovery path',async()=>{
    const calls=[];const sandbox=vm.createContext({generateImageWithRecovery:async(options,fn)=>{calls.push(options);return fn({...options,prompt:'fixed',userPrompt:'fixed'});},generateNvidiaVisualImageRaw:async(c,p)=>p,runExternalProviderImageRaw:async(p,o)=>o.prompt,generateGigaImageRaw:async p=>p});
    vm.runInContext(extract('async function generateNvidiaVisualImage(config','async function reportImageDeliveryFailure('),sandbox);
    vm.runInContext(extract('async function generateImage(safePrompt)','async function generateGigaImageRaw('),sandbox);
    assert.equal(await vm.runInContext("generateNvidiaVisualImage({}, 'original', {})",sandbox),'fixed');
    assert.equal(await vm.runInContext("runExternalProviderImage('xai', {prompt:'original'})",sandbox),'fixed');
    assert.equal(await vm.runInContext("generateImage('original')",sandbox),'fixed');assert.equal(calls.length,3);
});
test('public error delivery never prints upload paths or provider refusal dumps',async()=>{
    const sent=[];const sandbox=vm.createContext({});
    const start=app.indexOf('async function sendVisibleError(');const end=app.indexOf('\n    const message =',start);
    vm.runInContext(app.slice(start,end)+'\n}',sandbox);
    sandbox.context={send:async s=>sent.push(s)};sandbox.error={filePath:'C:\\secret\\image.png',message:'raw server hash'};
    await vm.runInContext('sendVisibleError(context,error)',sandbox);assert.equal(sent.length,1);assert.doesNotMatch(sent[0],/secret|hash/u);
});
