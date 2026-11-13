import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {SECONDARY_PARTY_INITIAL_SOURCES as seeds, filterSecondaryVkSources,
    filterSecondaryTelegramSources, classifyEventPartyPool} from '../../src/features/events/partyPool.js';
const vk=seeds.filter(s=>s.kind==='vk-public'), tg=seeds.filter(s=>s.kind==='telegram');

test('all sixteen secondary venues default to VK without losing Telegram provenance',()=>{
    assert.equal(vk.length,16);
    assert.equal(new Set(vk.map(s=>s.label)).size,16);
    assert.equal(filterSecondaryVkSources(vk).length,16);
    assert.deepEqual(filterSecondaryTelegramSources(tg,[],vk),[]);
    for(const item of tg)assert.equal(classifyEventPartyPool({sourceType:'telegram',sourceName:item.source}),'secondary');
    for(const source of ['auravrn','cenzura_bar','kommunavrn'])assert.ok(vk.some(s=>s.source===source));
});
test('fallback, unknown sources, primary boundaries and disabled VK are respected',()=>{
    assert.equal(filterSecondaryTelegramSources(tg).length,tg.length);
    assert.deepEqual(filterSecondaryTelegramSources([{source:'unknown'}],[],vk),[{source:'unknown'}]);
    assert.deepEqual(filterSecondaryVkSources([{source:'12bpg'},{source:'vavilone_rb'}]),[]);
    const primary=[{kind:'vk-public',source:'xlambar'}];
    assert.ok(!filterSecondaryVkSources(vk,primary).some(s=>s.source==='xlambar'));
    assert.deepEqual(filterSecondaryTelegramSources([{source:'xlam_bar'}],primary,vk),[{source:'xlam_bar'}]);
    assert.deepEqual(filterSecondaryTelegramSources([{source:'xlam_bar'}],[],[{source:'xlambar',enabled:false}]),[{source:'xlam_bar'}]);
});
test('actual application startup selects sixteen VK scrapers and no Telegram scrapers',()=>{
    const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
    const start=app.indexOf('const secondarySeedConfigurations =');
    const end=app.indexOf('const vkChatEventScraperEnabled =',start);
    const result=runInNewContext(app.slice(start,end)+'\n({vk:secondaryVkPublicScrapers,tg:secondaryTelegramHtmlScrapers})',{
        SECONDARY_PARTY_INITIAL_SOURCES:seeds, PARTY_POOL_SECONDARY:'secondary',
        mergeSourceConfigurations:(...lists)=>lists.flat(), ownerSecondaryManualScraperSourceRegistry:[],
        vkPublicSourceConfigurations:[], telegramSourceConfigurations:[],
        filterSecondaryVkSources, filterSecondaryTelegramSources,
        telegramHtmlScraperEnabled:true, vkPublicScraperEnabled:true,
        createConfiguredTelegramHtmlScraper:c=>c, createConfiguredVkPublicScraper:c=>c,
        console:{info(){}},
    });
    assert.equal(result.vk.length,16);assert.equal(result.tg.length,0);
});
