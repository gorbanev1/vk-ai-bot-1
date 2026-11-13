import test from 'node:test';
import assert from 'node:assert/strict';
import {groupPublicSources,formatGroupedPublicSources} from '../../src/features/scrapers/publicSourceList.js';
import {parseManualSourceToggleLine} from '../../src/features/scrapers/manualSourceDisplay.js';
import {parseManualScraperSource} from '../../src/features/scrapers/manualSourceRegistry.js';
import {SECONDARY_PARTY_INITIAL_SOURCES as seeds} from '../../src/features/events/partyPool.js';
const source=(kind,name,enabled=true)=>({id:(kind==='telegram'?'tg:':'vk:')+name,kind,
    url:(kind==='telegram'?'https://t.me/s/':'https://vk.ru/')+name,enabled});
test('publisher pairs collapse under the canonical name with all related links',()=>{
    const groups=groupPublicSources([source('telegram','vinzavodproo'),source('vk-public','vinzavodpro'),source('vk-public','xlambar')]);
    assert.equal(groups.length,2);
    assert.equal(groups.find(g=>g.name==='Винзавод').links.length,2);
    const text=formatGroupedPublicSources([source('vk-public','vinzavodpro')]);
    assert.match(text,/• Винзавод\nVK: https:\/\/vk.com\/vinzavodpro\nTelegram: https:\/\/t.me\/vinzavodproo/);
    assert.ok(!text.includes('/s/'));
});
test('all secondary venues have canonical names, alphabetical order and VK links',()=>{
    const list=seeds.filter(s=>s.kind==='vk-public').map(s=>source(s.kind,s.source));
    const groups=groupPublicSources(list.reverse());
    assert.equal(groups.length,16);
    const names=groups.map(g=>g.name);
    assert.deepEqual(names,[...names].sort(new Intl.Collator('ru',{sensitivity:'base',numeric:true}).compare));
    assert.ok(groups.every(g=>g.links.some(l=>l.label==='VK') && !/^https?:/.test(g.name)));
});
test('owner toggles stay attached to their own configured URL, reference links have no toggle',()=>{
    const text=formatGroupedPublicSources([source('vk-public','vinzavodpro',false)],{owner:true});
    const toggles=text.split('\n').map(line=>parseManualSourceToggleLine(line,parseManualScraperSource)).filter(Boolean);
    assert.deepEqual(toggles,[{id:'vk:vinzavodpro',enabled:false}]);
    assert.ok(!formatGroupedPublicSources([source('vk-public','vinzavodpro')]).includes(' — 1'));
});
test('unrelated unknown source names and URLs remain distinct',()=>{
    const groups=groupPublicSources([{...source('vk-public','custom_one'),label:'Зал Я'}, {...source('telegram','custom_two'),label:'Зал А'}]);
    assert.deepEqual(groups.map(g=>g.name),['Зал А','Зал Я']);
    assert.equal(groups[0].links[0].url,'https://t.me/custom_two');
});
