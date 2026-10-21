import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { explainVkChatEventCandidate } from '../../src/features/events/eventCandidateRouting.js';
import { createManualParserLimiter } from '../../src/features/scrapers/manualProcessingPool.js';
import { createManualParserDiagnostics } from '../../src/features/scrapers/manualParserDiagnostics.js';

const chat = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
const pub = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('V18836 strong current/future repost candidate outranks old/noisy chat lines', () => {
    const referenceNow = new Date('2026-09-10T09:30:00Z');
    const angela = explainVkChatEventCandidate({
        referenceNow,
        contentText: '',
        repostText: '11 и 12 сентября — техническое открытие ночного клуба АНГЕЛА. Начало в 22:00. Воронеж, ул. Платонова, 4',
        links: ['https://vk.ru/wall-240894883_12'],
        imageUrls: ['https://sun.example/poster.jpg'],
    });
    const old = explainVkChatEventCandidate({
        referenceNow,
        contentText: 'Summer Sound Fest 8 августа 2026 20:00 концерт',
        links: [],
        imageUrls: [],
    });
    const trash = explainVkChatEventCandidate({
        referenceNow,
        contentText: 'Ник Море\n17:19\n8',
        links: [],
        imageUrls: [],
    });
    assert.equal(angela.candidate, true);
    assert.ok(angela.reasons.includes('upcoming-date-priority'));
    assert.ok(angela.reasons.includes('venue-cue'));
    assert.ok(angela.score > old.score);
    assert.equal(trash.candidate, false);
});

test('global limiter arbitrates first free slots by candidate priority', async () => {
    const limiter = createManualParserLimiter(2);
    const started = [];
    const release = [];
    const tasks = [
        [10, 'low-a'],
        [20, 'low-b'],
        [220, 'angela'],
        [150, 'medium'],
    ].map(([priority, name]) => limiter.run(async () => {
        started.push(name);
        await new Promise((resolve) => release.push(resolve));
        return name;
    }, { priority }));
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.deepEqual(started.slice(0, 2), ['angela', 'medium']);
    while (release.length) release.shift()();
    await new Promise((resolve) => setTimeout(resolve, 20));
    while (release.length) release.shift()();
    await Promise.all(tasks);
});

test('diagnostic run persists verbatim DOM, parsed report and run manifest together', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-v18836-'));
    try {
        const diagnostics = createManualParserDiagnostics({ dataDirectory: root, label: 'v18836-test' });
        const html = '<!doctype html><html><body><div data-itemkey="5040">АНГЕЛА</div></body></html>';
        const domPath = await diagnostics.captureDomSnapshot({ sourceId: 'chat:2000000022', html, label: 'capture-complete' });
        const reportPath = diagnostics.saveParserReport({
            sourceId: 'chat:2000000022',
            kind: 'vk-chat',
            report: { exactCount: 1, fallbackCount: 0, ids: [5040] },
        });
        diagnostics.finish({ ok: true });
        assert.equal(readFileSync(domPath, 'utf8'), html);
        assert.match(readFileSync(reportPath, 'utf8'), /"exactCount":1/u);
        const manifest = JSON.parse(readFileSync(join(diagnostics.directory, 'run-manifest.json'), 'utf8'));
        assert.equal(manifest.artifacts.domSnapshots.length, 1);
        assert.equal(manifest.artifacts.parserReports.length, 1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('VK sources record exact-vs-fallback reasons and keep last DOM on interrupted public capture', () => {
    assert.match(chat, /parserComparisons/u);
    assert.match(chat, /exactFailureReason/u);
    assert.match(chat, /saveParserReport/u);
    assert.match(pub, /parserReport\.comparisons/u);
    assert.match(pub, /capture-error-last-known/u);
    assert.match(pub, /capture-interrupted/u);
    assert.match(pub, /browser-target-closed-before-final-exact/u);
});

test('parser-all invalidates stale display/image snapshot caches and audits final DB visibility', () => {
    assert.match(app, /eventDisplayNormalizationCache\.clear\(\)/u);
    assert.match(app, /eventImageAttachmentCache\.clear\(\)/u);
    assert.match(app, /parser-all-start-v18836/u);
    assert.match(app, /visibilityAudit/u);
    assert.match(app, /EVENT VERIFIED SNAPSHOT ORPHANS PRESERVED/u);
    assert.match(app, /run-verification/u);
    assert.match(app, /EVENT_PARSER_AI_ATTEMPT_TIMEOUT_MS/u);
    assert.match(pub, /label: `vk-public-vision:[^`]+`[\s\S]{0,100}maxAttempts: 1/u);
    assert.match(pub, /label: `vk-public-ai:[^`]+`[\s\S]{0,100}maxAttempts: 1/u);
});
