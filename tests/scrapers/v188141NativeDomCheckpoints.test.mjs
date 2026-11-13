
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManualParserDiagnostics } from '../../src/features/scrapers/manualParserDiagnostics.js';
import { verifyVkFinalDomSnapshot } from '../../scripts/vk-dom-final-verify.mjs';
const makePage = (html) => ({
 isClosed:()=>false,
 evaluate:async (_fn,args)=>args?.includeStructure?({
  html,capturedAt:'2026-10-27T00:00:00Z',state:{pageUrl:'https://vk.ru/test'},
  resources:[],structure:{nodeCount:0,elements:[],postLinkCandidates:[]}
 }):html,
});
for(const label of ['parser-all','parser-all-clean','parser-all-secondary','parser-all-secondary-clean']){
 test(label+': only final immutable parser HTML is persisted despite later DOM changes',async(t)=>{
  const data=await mkdtemp(join(tmpdir(),'vk-final-only-'));t.after(()=>rm(data,{recursive:true,force:true}));
  const diagnostics=createManualParserDiagnostics({dataDirectory:data,label});
  const first='<html><body>first viewport</body></html>',final='<html><body>final parser input</body></html>';
  assert.equal((await diagnostics.captureVkDomFixture({page:makePage(first),sourceId:'vk:test',label:'scroll-001'})).html,first);
  await assert.rejects(stat(join(diagnostics.directory,'vk-dom-final-snapshots')),/ENOENT/);
  const parsed=await diagnostics.captureVkDomFixture({page:makePage(final),sourceId:'vk:test',label:'capture-complete'});
  assert.equal(parsed.html,final);
  const changed=makePage('<html><body>changed after parsing</body></html>');
  changed.evaluate=()=>assert.fail('must reuse the exact parser snapshot');
  const saved=await diagnostics.captureVkFinalDomSnapshot({page:changed,sourceId:'vk:test',direction:'down',sourceKind:'vk-public',preparation:{direction:'down',status:'native-capture-finished-no-extra-pagination',progress:[]}});
  assert.equal(await readFile(join(saved.directory,'dom.raw.html'),'utf8'),final);
  assert.deepEqual((await readdir(saved.directory)).filter(n=>n.endsWith('.html')),['dom.raw.html']);
  await assert.rejects(stat(join(saved.directory,'checkpoints')),/ENOENT/);
  assert.equal(JSON.parse(await readFile(join(saved.directory,'page-state.json'),'utf8')).parserInputIdentical,true);
  assert.equal((await verifyVkFinalDomSnapshot(saved.directory)).captureIsOfflineReproducible,true);
 });
}
test('final DOM persistence survives a tab closing after the immutable parser capture',async(t)=>{
 const data=await mkdtemp(join(tmpdir(),'vk-final-closed-'));t.after(()=>rm(data,{recursive:true,force:true}));
 const d=createManualParserDiagnostics({dataDirectory:data,label:'parser-all'});
 await d.captureVkDomFixture({page:makePage('<html>saved</html>'),sourceId:'chat:6',label:'capture-complete'});
 const result=await d.captureVkFinalDomSnapshot({page:{isClosed:()=>true},sourceId:'chat:6',direction:'up',preparation:{direction:'up',progress:[]}});
 assert.equal(await readFile(join(result.directory,'dom.raw.html'),'utf8'),'<html>saved</html>');
});
test('forensic snapshot module never requires a second source-native scroll',async()=>{
 const code=await readFile(new URL('../../src/platforms/vk/vkChatEventScraper.js',import.meta.url),'utf8');
 const start=code.indexOf('// V188.141: Final forensic DOM is OBSERVATIONAL.');
 const nativeCapture=code.slice(start,code.indexOf('const sourceId = `chat:${peerId}`;',start));
 assert.ok(nativeCapture.includes('captureVkFinalDomSnapshot'));
 assert.doesNotMatch(nativeCapture,/(?:await\s+(?:.*\.)?scroll|moveToEdge\s*\(|prepareVkFinalDomCapture\s*\()/iu);
});
