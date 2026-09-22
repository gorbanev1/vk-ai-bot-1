import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
const diagnostics = readFileSync(new URL('../../src/features/scrapers/manualParserDiagnostics.js', import.meta.url), 'utf8');

function section(source, start, end) {
    const from = source.indexOf(start);
    assert.notEqual(from, -1, `missing section start: ${start}`);
    const to = end ? source.indexOf(end, from + start.length) : source.length;
    assert.notEqual(to, -1, `missing section end: ${end}`);
    return source.slice(from, to);
}

test('parser-all uses finite capture passes and a cache barrier instead of a destructive ten-minute deadline', () => {
    const all = section(app, 'async function startAllManualScraperSources()', 'async function handleManualScraperCommand');
    assert.match(all, /finiteChatPass: source\.kind === 'vk-chat'/u);
    assert.match(all, /finitePass: true/u);
    assert.match(all, /processingGate/u);
    assert.match(all, /run\.capture\.complete/u);
    assert.match(all, /startProcessing/u);
    assert.doesNotMatch(all, /forceCloseScraperBrowserContext/u);
    assert.doesNotMatch(all, /parser-all-10-minute-deadline/u);
});

test('finite VK chat pass captures and caches all raw messages before AI processing starts', () => {
    const finite = section(chat, 'async function runFiniteManualPass', 'async function startManualSession');
    const cacheAt = finite.indexOf('cacheSource');
    const gateAt = finite.indexOf('await processingGate');
    const processAt = finite.indexOf('runManualParserPoolUntilSettled');
    assert.ok(cacheAt >= 0, 'finite pass must persist raw cache');
    assert.ok(gateAt > cacheAt, 'processing gate must come after raw cache');
    assert.ok(processAt > gateAt, 'AI/algorithm processing must begin only after cache barrier');
    assert.match(finite, /snapshot-exact/u);
    assert.match(finite, /window-/u);
    assert.match(finite, /page\.close\(\)/u);
});

test('manual parser diagnostics save complete DOM strings verbatim and support reproducible snapshot parsing', () => {
    assert.match(diagnostics, /html: providedHtml/u);
    assert.match(diagnostics, /const html = hasProvidedHtml \? providedHtml : await page\.content\(\)/u);
    assert.match(diagnostics, /writeFileSync\(path, String\(html \?\? ''\), 'utf8'\)/u);
    assert.match(diagnostics, /\.dom\.html/u);
});

test('parser-all command reports a soft ten-minute boundary without cancelling background processing', () => {
    const handler = section(app, 'async function handleManualScraperCommand', 'let gigaQueue');
    assert.match(handler, /10 минут — только мягкая граница ожидания обработки/u);
    assert.match(handler, /Обработка НЕ остановлена и продолжает идти в фоне/u);
    assert.match(handler, /processingPromise/u);
    assert.match(handler, /getPendingCandidates/u);
    assert.match(handler, /Полный лог и DOM-снимки/u);
});
