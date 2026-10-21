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

test('source lists accept the secondary pool aliases', () => {
  for (const text of ['источники второстепенные', 'источники быдлячьи', 'второстепенные источники', 'быдлячьи источники']) {
    const result = parseScraperStartCommand(text);
    assert.equal(result.matched, true, text);
    assert.equal(result.listSources, true, text);
    assert.equal(result.partyPool, 'secondary', text);
  }
});

test('secondary parser-all has an isolated namespace', () => {
  const result = parseScraperStartCommand('быдлячьи тусы парсер все');
  assert.equal(result.matched, true);
  assert.equal(result.all, true);
  assert.equal(result.partyPool, 'secondary');
});

test('secondary parser aliases work in both word orders and do not throw', () => {
  for (const text of [
    'парсер второстепенные все',
    'парсер быдлячьи все',
    'второстепенные парсер все',
    'быдлячьи парсер все',
  ]) {
    const result = parseScraperStartCommand(text);
    assert.equal(result.matched, true, text);
    assert.equal(result.all, true, text);
    assert.equal(result.partyPool, 'secondary', text);
    assert.equal(result.sourceId, '', text);
  }
});

test('parser modifiers are independent of word order', () => {
  for (const text of [
    'парсер все быдлячьи новые 2фазы турбо3',
    'тусы быдлячьи парсер все новые турбо3 2фазы',
    'турбо3 2фазы новые быдлячьи парсер все',
    'быдлячьи турбо3 парсер новые все 2 фазы',
  ]) {
    const result = parseScraperStartCommand(text);
    assert.equal(result.matched, true, text);
    assert.equal(result.all, true, text);
    assert.equal(result.cleanOnly, true, text);
    assert.equal(result.partyPool, 'secondary', text);
    assert.equal(result.phaseCount, 2, text);
    assert.equal(result.turboMode, 'turbo3', text);
  }

  for (const text of [
    'парсер все новые турбо3 2фазы',
    'турбо3 2фазы новые парсер все',
  ]) {
    const result = parseScraperStartCommand(text);
    assert.equal(result.matched, true, text);
    assert.equal(result.all, true, text);
    assert.equal(result.cleanOnly, true, text);
    assert.equal(result.partyPool, 'primary', text);
    assert.equal(result.phaseCount, 2, text);
    assert.equal(result.turboMode, 'turbo3', text);
  }
});
