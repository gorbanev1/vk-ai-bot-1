import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScraperStartCommand } from '../../src/features/scrapers/scraperCommandRouting.js';

test('canonical and alias secondary add-source commands stay in secondary pool', () => {
  for (const text of [
    'тусы быдлячьи добавить источник https://vk.com/example',
    'тусы второстепенные добавить источник https://t.me/example',
  ]) {
    const result = parseScraperStartCommand(text);
    assert.equal(result.matched, true);
    assert.equal(result.addSource, true);
    assert.equal(result.partyPool, 'secondary');
    assert.match(result.sourceInput, /^https:/);
  }
});

test('secondary parser-all has an isolated namespace', () => {
  const result = parseScraperStartCommand('быдлячьи тусы парсер все');
  assert.equal(result.matched, true);
  assert.equal(result.all, true);
  assert.equal(result.partyPool, 'secondary');
});
