import assert from 'node:assert/strict';
import { parseBulkSourceAddCommand } from '../../src/features/scrapers/bulkSourceAddCommand.js';
import { parseScraperStartCommand } from '../../src/features/scrapers/scraperCommandRouting.js';

const s = parseBulkSourceAddCommand('Гигорейв основные добавить\nhttps://vk.ru/my_rave,\nhttps://vk.com/my_rave; https://t.me/my_events https://t.me/s/my_events/123\nvk:club123 @hello_world');
assert.equal(s.partyPool, 'primary');
assert.deepEqual(s.sources.map(x => x.id), ['vk:my_rave','tg:my_events','vk:club123','tg:hello_world']);
assert.equal(s.duplicates, 2);
assert.deepEqual(s.invalid, []);

const q = parseScraperStartCommand('второстепенные добавить https://vk.com/another_one\nhttps://t.me/+private\nhttps://example.com/other');
assert.equal(q.matched, true);
assert.equal(q.addSourcesBulk, true);
assert.equal(q.partyPool, 'secondary');
assert.deepEqual(q.bulkSources.map(x=>x.id), ['vk:another_one']);
assert.equal(q.bulkInvalid.length, 2);
assert.equal(parseScraperStartCommand('основные добавить').addSourcesBulk, true);
assert.deepEqual(parseScraperStartCommand('основные добавить').bulkSources, []);
assert.equal(parseBulkSourceAddCommand('нормальный разговор'), null);
assert.equal(parseBulkSourceAddCommand('основные добавить https://vk.ru/club777').sources[0].id, 'vk:club777');
assert.equal(parseBulkSourceAddCommand('второстепенные добавить\nhttps://t.me/channel000').sources[0].id, 'tg:channel000');
assert.equal(parseBulkSourceAddCommand('основные добавить https://vk.ru/wall-12345_678').sources[0].id, 'vk:club12345');
console.log('bulkSourceAddCommand tests passed');

for(const [text,pool] of [
 ['основные источники добавить источник https://t.me/s/overlock_bar','primary'],
 ['основные источники добавить https://t.me/s/overlock_bar','primary'],
 ['основные добавить источник https://t.me/s/overlock_bar','primary'],
 ['второстепенные источники добавить источник https://vk.ru/club456','secondary'],
 ['второстепенные источники добавить https://t.me/s/overlock_bar','secondary'],
]){
 const parsed=parseScraperStartCommand(text);
 assert.equal(parsed.matched,true,text);
 assert.equal(parsed.addSourcesBulk,true,text);
 assert.equal(parsed.partyPool,pool,text);
 assert.equal(parsed.bulkSources.length,1,text);
}
assert.deepEqual(parseScraperStartCommand('основные источники добавить источник').bulkSources,[]);
