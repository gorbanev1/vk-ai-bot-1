import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runParserWorkTask, parsePublicPostLocallyAsync } from '../../src/features/scrapers/parserWorkAsync.js';
import { parsePublicPostLocally } from '../../src/features/events/publicPostLocalParser.js';
import { createVkFinalDomCapture } from '../../src/features/scrapers/vkDomFinalSnapshot.js';
import { recordParserError, listParserErrors, updateParserError, refreshParserErrorEvidenceAsync } from '../../src/features/scrapers/parserErrorStore.js';
const posts = [
 {text:'31 октября 2026 в 20:00 концерт группы Тест в клубе Aurora. Билеты 500 рублей.', publishedAt:1793000000,referenceNow:1793000000000},
 {text:'31 октября — концерт группы Север. 1 ноября — Halloween, DJ Night.',publishedAt:1793000000,referenceNow:1793000000000},
 {text:'Спасибо всем, кто был вчера на концерте!',publishedAt:1793000000,referenceNow:1793000000000},
];
test('worker local parser produces exactly the existing results, without mutating input', async()=>{
 const copy=structuredClone(posts);
 const expected=posts.map(parsePublicPostLocally);
 assert.deepEqual(await Promise.all(posts.map(parsePublicPostLocallyAsync)),expected);
 assert.deepEqual(posts,copy);
});
test('failed and uncloneable tasks cannot strand the parser queue',async()=>{
 await assert.rejects(runParserWorkTask('unknown',{}),/Unknown parser work task/);
 await assert.rejects(runParserWorkTask('parse-public-post',{fn(){}}));
 assert.deepEqual(await parsePublicPostLocallyAsync(posts[0]),parsePublicPostLocally(posts[0]));
});
test('large DOM persistence leaves the main event loop running and preserves exact bytes',async(t)=>{
 const root=mkdtempSync(join(tmpdir(),'parser-thread-dom-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const html='<html><body>'+('<article>афиша события</article>'.repeat(350000))+'</body></html>';
 let beats=0,last=performance.now(),maxGap=0;
 const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;beats++;},5);
 try {
  const result=await createVkFinalDomCapture({runDirectory:root,runId:'thread'}).capture({
   sourceId:'vk:fixture',sourceKind:'vk-public',direction:'down',preparation:{status:'edge-confirmed-bounded'},
   snapshot:{html,capturedAt:'2026-10-27T00:00:00Z',state:{},structure:{},resources:[]}
  });
  assert.ok(beats>0,'event loop must run before persistence completes');
  assert.equal(readFileSync(join(result.directory,'dom.raw.html'),'utf8'),html);
  assert.equal(JSON.parse(readFileSync(join(result.directory,'page-state.json'),'utf8')).parserInputIdentical,true);
  console.log(JSON.stringify({domBytes:Buffer.byteLength(html),heartbeatCount:beats,maxGapMs:maxGap}));
 }finally{clearInterval(timer);}
});
test('off-thread archive completion preserves concurrent index edits and final evidence',async(t)=>{
 const root=mkdtempSync(join(tmpdir(),'parser-thread-archive-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const run=join(root,'run');mkdirSync(run);
 writeFileSync(join(run,'trace.jsonl'),'old');
 const entry=recordParserError({dataDirectory:root,runDirectory:run,runId:'run',sourceId:'vk:a',itemId:'1',details:{traceRelativePath:'trace.jsonl'}});
 writeFileSync(join(run,'trace.jsonl'),'final');
 writeFileSync(join(run,'large.bin'),Buffer.alloc(12*1024*1024,1));
 const pending=refreshParserErrorEvidenceAsync({dataDirectory:root,runDirectory:run,runId:'run'});
 updateParserError(root,entry.id,{replayAttempt:{ok:true,reason:'concurrent correction'}});
 const other=recordParserError({dataDirectory:root,runId:'other',sourceId:'vk:b',itemId:'2'});
 assert.equal(await pending,1);
 const rows=listParserErrors({dataDirectory:root,includeResolved:true});
 assert.equal(rows.find(row=>row.id===entry.id).replayAttempts.length,1);
 assert.ok(rows.some(row=>row.id===other.id));
 assert.equal(readFileSync(join(entry.archiveDirectory,'trace.jsonl'),'utf8'),'final');
});
