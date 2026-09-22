import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAutoSummaryCommand } from '../src/features/ai/autoSummaryRouting.js';
import { parseVkChatConfigurations } from '../src/features/scrapers/sourceConfiguration.js';

const appSource = readFileSync(new URL('../src/app/botApplication.js', import.meta.url), 'utf8');
const browserSource = readFileSync(new URL('../src/features/history/vkBrowserHistoryRecovery.js', import.meta.url), 'utf8');

test('V178 never prints private /im/convo links in autoresume responses', () => {
  assert.doesNotMatch(appSource, /https:\/\/vk\.ru\/im\/convo\//u);
  assert.match(appSource, /авторезюме 2000000006 12 15 18/u);
  assert.match(appSource, /беседа 6/u);
});

test('V178 uses explicit peer or stable chat number selectors', () => {
  assert.equal(parseAutoSummaryCommand('авторезюме 2000000006 статус').target.externalPeerId, '2000000006');
  assert.equal(parseAutoSummaryCommand('авторезюме беседа 6 статус').target.externalPeerId, '2000000006');
  assert.equal(parseAutoSummaryCommand('авторезюме https://vk.ru/im?sel=c6 статус').target.externalPeerId, '2000000006');
  assert.equal(parseAutoSummaryCommand('авторезюме https://vk.ru/im/convo/2000000006 статус').target, undefined);
});

test('V178 normalizes legacy scraper config to stable chat selector', () => {
  const [config] = parseVkChatConfigurations('Test|https://vk.ru/im/convo/2000000006|300');
  assert.equal(config.url, 'https://vk.ru/im?sel=c6');
  assert.doesNotMatch(browserSource, /im\/convo\/\$\{chatId\}/u);
});
