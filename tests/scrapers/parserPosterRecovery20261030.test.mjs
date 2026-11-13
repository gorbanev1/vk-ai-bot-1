import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {createParserPosterRetryStore,mergePosterRepairItems} from '../../src/infrastructure/database/parserPosterRetry.js';
import {evaluatePosterFactForEvent} from '../../src/features/events/eventPosterMatching.js';
import {shouldSkipUnchangedCapturedItem} from '../../src/features/scrapers/manualParserCleanSkip.js';
import {runParserWorkTask} from '../../src/features/scrapers/parserWorkAsync.js';

const poster={index:1,poster:true,imageType:'poster',posterConfidence:99,
 title:'Литера 10 лет',dates:'21 ноября',participants:'',
 recognizedText:'АФИША МЕРОПРИЯТИЙ НА НОЯБРЬ\n21 НОЯБРЯ\nНАМ 10 ЛЕТ!\n22 ВОСКРЕСЕНЬЕ\nСЕРЁГА СЕРЁГИН\n27 ПЯТНИЦА\nИНДИГО\n29 ВОСКРЕСЕНЬЕ\nАНТОН ТЕПЛЯКОВ'};
const event={id:1,sourceType:'vk',title:'Сергей Серёгин',participants:'Сергей Серёгин',eventDate:'2026-11-22',isMultiAnnouncement:true};
test('monthly OCR binds the date to its own performer despite incomplete scalar fields',()=>{
 assert.equal(evaluatePosterFactForEvent(event,poster).accepted,true);
 assert.equal(evaluatePosterFactForEvent({...event,title:'ИНДИГО',participants:'ИНДИГО',eventDate:'2026-11-27'},poster).accepted,true);
 assert.equal(evaluatePosterFactForEvent({...event,eventDate:'2026-11-27'},poster).accepted,false);
});
test('October image cannot inherit November dates and artists from joint-gate context',()=>{
 const contaminated={...poster,title:'Сергей Серёгин',dates:'22 ноября',participants:'Сергей Серёгин',recognizedText:'АФИША МЕРОПРИЯТИЙ НА ОКТЯБРЬ\n22 ЧЕТВЕРГ\nДАРИ'};
 assert.equal(evaluatePosterFactForEvent(event,contaminated).reason,'poster-calendar-month-conflict');
 assert.equal(evaluatePosterFactForEvent({...event,eventDate:'2026-10-22'},contaminated).accepted,false);
});
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'poster-retry-')),db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE manual_parser_seen_items(source_id TEXT,item_id TEXT,source_url TEXT,raw_text TEXT,attachments_json TEXT,parse_status TEXT,last_error TEXT,processed_at INTEGER,PRIMARY KEY(source_id,item_id)); CREATE TABLE vk_source_posts(screen_name TEXT,post_id INTEGER,source_url TEXT,raw_text TEXT,published_at INTEGER,image_urls_json TEXT,image_media_json TEXT); CREATE TABLE vk_events(screen_name TEXT,post_id INTEGER,event_date TEXT,event_end_date TEXT,status TEXT,image_paths_json TEXT);");
 db.prepare('INSERT INTO vk_source_posts VALUES (?,?,?,?,?,?,?)').run('test',7,'https://vk.ru/wall-1_7','22 ноября Сергей Серёгин',1,'[]',JSON.stringify([{url:'https://image/one'}]));
 db.prepare('INSERT INTO vk_events VALUES (?,?,?,?,?,?)').run('test',7,'2026-11-22','','approved','[]');
 db.prepare('INSERT INTO manual_parser_seen_items VALUES (?,?,?,?,?,?,?,?)').run('vk:test','7','','','[]','processed_event','',123);
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 return {root,db,store:createParserPosterRetryStore(db,root,()=> '2026-10-30')};
}
test('posterless completed record becomes retryable and survives outside captured feed',t=>{
 const {store,db}=fixture(t);
 assert.equal(store.missing('vk:test','7'),true);
 store.reopen([{sourceId:'vk:test',itemId:'7'}]);
 const row=db.prepare('SELECT * FROM manual_parser_seen_items').get();
 assert.equal(row.parse_status,'failed_retryable');assert.equal(row.processed_at,0);
 assert.equal(shouldSkipUnchangedCapturedItem({incrementalOnly:true,previous:{parseStatus:row.parse_status,contentHash:'same'},contentHash:'same',isFinalStatus:s=>s==='processed_event'}),false);
 const merged=mergePosterRepairItems([{postId:9,text:'fresh'}],store.pending('vk:test'),'postId');
 assert.deepEqual(merged.map(x=>x.postId),[7,9]);
 assert.deepEqual(merged[0].imageUrls,['https://image/one']);
 assert.equal(merged[0].__posterRepairNeeded,true);
});
test('current capture wins over old body; no duplicate jobs or dropped media',t=>{
 const {store}=fixture(t);store.reopen([{sourceId:'vk:test',itemId:'7'}]);
 const merged=mergePosterRepairItems([{postId:7,text:'updated',imageUrls:[]}],store.pending('vk:test'),'postId');
 assert.equal(merged.length,1);assert.equal(merged[0].text,'updated');assert.equal(merged[0].imageUrls.length,1);
});
test('readable restored file ends missing state; deleted file reopens it',t=>{
 const {store,db,root}=fixture(t);
 writeFileSync(join(root,'poster.jpg'),Buffer.alloc(100));
 db.prepare('UPDATE vk_events SET image_paths_json=?').run('["poster.jpg"]');
 assert.equal(store.missing('vk:test','7'),false);
 rmSync(join(root,'poster.jpg'));assert.equal(store.missing('vk:test','7'),true);
 db.prepare("UPDATE vk_events SET event_date='2026-10-01'").run();
 assert.equal(store.missing('vk:test','7'),false);
});
test('reopen does not steal a source currently owned by a processing worker',t=>{
 const {store,db}=fixture(t);db.exec("UPDATE manual_parser_seen_items SET parse_status='processing'");
 assert.equal(store.reopen([{sourceId:'vk:test',itemId:'7'}]),0);
 assert.equal(store.pending('vk:test').length,0);
});
test('production finalizer cannot mark a posterless event as processed',()=>{
 const source=readFileSync(new URL('../../src/infrastructure/database/index.js',import.meta.url),'utf8');
 const start=source.indexOf('export function finalizeManualParserSeenItem('),end=source.indexOf('\nexport function markManualParserSeenItemFailed',start);
 let values;
 const fn=vm.runInNewContext(source.slice(start,end).replace('export function','function')+'\nfinalizeManualParserSeenItem;',{
 parserPosterRetryStore:{missing:()=>true},MISSING_POSTER_RETRY:'MISSING_USABLE_POSTER',
 finalizeManualParserSeenItemStatement:{run(...v){values=v;return {changes:1}}}
 });
 fn({sourceId:'vk:test',itemId:'7',parseStatus:'processed_event'});
 assert.equal(values[0],'failed_retryable');assert.equal(values[1],0);assert.equal(values[2],'MISSING_USABLE_POSTER');
});
test('archive worker restores exact bytes and facts even without an error-row archive pointer',async t=>{
 const root=mkdtempSync(join(tmpdir(),'poster-archive-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const archive=join(root,'parser-forensic-archives','2026-10-29_run'),raw=join(archive,'raw-images');
 mkdirSync(raw,{recursive:true});
 const bytes=Buffer.alloc(2048);bytes.set([0x89,0x50,0x4e,0x47]);bytes.writeUInt32BE(800,16);bytes.writeUInt32BE(1200,20);
 writeFileSync(join(raw,'poster.image'),bytes);
 writeFileSync(join(raw,'manifest.json'),JSON.stringify([['https://image/one',{path:join(root,'deleted','poster.image'),byteLength:bytes.length,mimeType:'image/png'}]]));
 writeFileSync(join(archive,'vk-test.raw-cache.json'),JSON.stringify({items:[{postId:7,sourceUrl:'https://vk.ru/wall-1_7',imageUrls:['https://image/one']}]}));
 const response='[IMAGE 1]\nТип изображения: poster\nЭто афиша события: да\nНазвание: Сергей Серёгин\nДата: 22 ноября\nРаспознанный текст: Сергей Серёгин 22 ноября';
 writeFileSync(join(archive,'trace.jsonl'),[
 {stage:'item.poster-gate.batch_start',data:{sourceId:'vk:test',itemId:'7',sourceUrl:'https://vk.ru/wall-1_7'}},
 {stage:'item.poster-gate.image',data:{sourceId:'vk:test',itemId:'7',imageNumber:1,imageUrl:'https://image/one',responseText:response}}
 ].map(JSON.stringify).join('\n'));
 const result=await runParserWorkTask('repair-poster-archive',{dataDirectory:root,groups:[{sourceType:'vk',screenName:'test',postId:7,imageUrls:['https://image/one'],events:[event]}]});
 assert.equal(result.updates.length,1);
 assert.deepEqual(readFileSync(join(root,result.updates[0].event.imagePaths[0])),bytes);
 assert.equal(result.updates[0].event.posterVisionFacts[0].poster,true);
});

test('archive success removes only repaired poster retries, preserving other failures',t=>{
 const {store,db,root}=fixture(t),candidates=[{sourceId:'vk:test',itemId:'7'}];
 store.reopen(candidates);
 assert.equal(store.settleRestored(candidates),0);
 writeFileSync(join(root,'poster.jpg'),Buffer.alloc(100));
 db.prepare('UPDATE vk_events SET image_paths_json=?').run('["poster.jpg"]');
 assert.equal(store.settleRestored(candidates),1);assert.equal(store.pending('vk:test').length,0);
 db.exec("UPDATE manual_parser_seen_items SET parse_status='failed_retryable',last_error='validation'");
 assert.equal(store.settleRestored(candidates),0);
 assert.equal(db.prepare('SELECT last_error FROM manual_parser_seen_items').get().last_error,'validation');
});
