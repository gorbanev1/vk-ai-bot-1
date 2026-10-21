import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createVkLaunchStagger } from '../../src/features/scrapers/vkLaunchStagger.js';

const application = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

test('16 VK sources can all START at staggered intervals even while c22 never completes capture', async () => {
    const waits = [];
    const gapLogs = [];
    const gate = createVkLaunchStagger({
        makeGapMs: () => 12_345,
        sleep: async (ms) => { waits.push(ms); },
        onGap: (entry) => gapLogs.push(entry),
    });
    const c22StillCapturing = deferred();
    const begun = [];
    const tasks = Array.from({ length: 16 }, (_, i) => {
        const sourceId = i === 0 ? 'chat:2000000022' : `vk:other-${i}`;
        const ready = gate(sourceId);
        return (async () => {
            await ready;
            begun.push(sourceId);
            if (i === 0) await c22StillCapturing.promise;
        })();
    });
    await Promise.all(tasks.slice(1));
    assert.equal(begun.length, 16);
    assert.equal(begun[0], 'chat:2000000022');
    assert.equal(waits.length, 15);
    assert.ok(waits.every((gap) => gap >= 10_000 && gap <= 20_000));
    assert.equal(gapLogs.length, 15);
    c22StillCapturing.resolve();
    await tasks[0];
});

test('a spacing failure releases subsequent source launch reservations', async () => {
    let attempts = 0;
    const gate = createVkLaunchStagger({
        makeGapMs: () => 15_000,
        sleep: async () => { if (++attempts === 1) throw new Error('sleep failed'); },
    });
    const first = gate('vk:first');
    const second = gate('vk:second');
    const third = gate('vk:third');
    await first;
    await assert.rejects(second, /sleep failed/u);
    await third;
    assert.equal(attempts, 2);
});

test('full parser-all source registry, processing pipeline and source completion barriers remain present', () => {
    assert.match(application, /const sources = getManualScraperSources\(normalizedPool\);/u);
    assert.match(application, /run\.source-registry/u);
    assert.match(application, /const vkLaunchReservation = isVkBrowserSource\s*\? waitForVkLaunch\(source\.id\)/u);
    assert.match(application, /await vkLaunchReservation;/u);
    assert.doesNotMatch(application, /await priorVkCaptureWaiter\.promise/u);
    assert.match(application, /await Promise\.all\(captureWaiters\.map\(\(item\) => item\.promise\)\);/u);
    assert.match(application, /releasePosterGateGate\?\.\(\);/u);
    assert.match(application, /releaseProcessingGate\?\.\(\);/u);
    assert.match(application, /onCaptureComplete: \(payload\) => \{/u);
    assert.match(application, /onAdmissionComplete: \(payload\) => \{/u);
    assert.match(application, /normalizedSourceId === 'chat:2000000022'/u);
    assert.match(application, /process\.env\.MANUAL_PARSER_CHAT_CAPTURE_MAX_MS/u);
});
