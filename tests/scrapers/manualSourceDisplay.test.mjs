import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatManualSourceDisplayName,
    formatManualSourceListLine,
    formatPrimaryVkChatSourceNote,
    getManualSourceUrl,
    parseManualSourceToggleLine,
} from '../../src/features/scrapers/manualSourceDisplay.js';
import { parseManualScraperSource } from '../../src/features/scrapers/manualSourceRegistry.js';

test('owner source rows show human names, normal URLs, and round-trip toggles', () => {
    const source = { id: 'vk:artartelchaika', kind: 'vk-public', source: 'artartelchaika', url: 'https://vk.ru/artartelchaika' };
    const name = formatManualSourceDisplayName(source);
    const url = getManualSourceUrl(source);
    assert.equal(name, 'Артель «Чайка»');
    assert.equal(url, 'https://vk.ru/artartelchaika');
    assert.equal(formatManualSourceListLine(source, { owner: true, enabled: false }), '• Артель «Чайка» — https://vk.ru/artartelchaika — 0');
    assert.equal(formatManualSourceListLine(source), '• https://vk.ru/artartelchaika');
    assert.deepEqual(parseManualSourceToggleLine(`• ${name} — ${url} — 0`, parseManualScraperSource), {
        id: 'vk:artartelchaika', enabled: false,
    });
});

test('Telegram source list avoids the /s/ web-preview path', () => {
    assert.equal(getManualSourceUrl({ url: 'https://t.me/s/kotelnaya_inc' }), 'https://t.me/kotelnaya_inc');
    assert.deepEqual(parseManualSourceToggleLine('• Котельная — https://t.me/kotelnaya_inc — 1', parseManualScraperSource), {
        id: 'tg:kotelnaya_inc', enabled: true,
    });
});

test('unrecognized VK display names fall back to the URL, never an internal vk: id', () => {
    assert.equal(formatManualSourceDisplayName({ id: 'vk:unknown', url: 'https://vk.ru/unknown', label: 'VK vk.ru/unknown' }), 'https://vk.ru/unknown');
});

test('primary sources list adds the named VK chat note without linking the chat', () => {
    assert.equal(formatPrimaryVkChatSourceNote(), '• Беседа ВК П🌐ЙТИ на P🐻RTY (создатель: https://vk.ru/nick_more)');
});
