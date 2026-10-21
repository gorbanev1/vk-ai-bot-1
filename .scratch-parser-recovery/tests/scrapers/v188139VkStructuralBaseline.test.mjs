import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createVkDomFixtureCapture } from '../../src/features/scrapers/vkDomFixtureCapture.js';
import { verifyVkDomStructureBaseline } from '../../scripts/vk-dom-structure-verify.mjs';
const html = '<html><head></head><body><article data-post-id="-15_27"><a href="/wall-15_27">27</a><p>Анонс 25 сентября</p><img src="/poster.jpg"></article></body></html>';
function fakePage() {
    let calls = 0;
    return { isClosed: () => false, evaluate: async (_fn, args) => {
        calls += 1;
        if (args?.quietMs) return { stable: true, waitedMs: 620, quietMs: args.quietMs, maxWaitMs: args.maxWaitMs };
        assert.equal(args.includeStructure, true);
        return { html, capturedAt: '2026-09-20T02:00:00.000Z',
            state: { pageUrl: 'https://vk.com/public15', baseUri: 'https://vk.com/public15',
                scrollY: 0, viewport: { width: 1280, height: 800 } },
            resources: [{ tag: 'img', elementIndex: 5, attributes: { src: '/poster.jpg' } }],
            structure: { schemaVersion: 1, canonicalInput: 'dom.raw.html', nodeCount: 2,
                elements: [{ index: 0, parentIndex: null, tag: 'html', attributes: {} },
                    { index: 1, parentIndex: 0, tag: 'body', attributes: {} }],
                postLinkCandidates: [{ anchorElementIndex: 5, href: '/wall-15_27', verifiedCardRoot: false }] } };
    }, calls: () => calls };
}

test('parser-all structural capture persists one unchanged baseline per source and verifies offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vk-structure-baseline-'));
    const events = [];
    const capture = createVkDomFixtureCapture({ runDirectory: root, runId: 'run1', onPersist: x => events.push(x) });
    const page = fakePage();
    const a = await capture.captureStructureBaseline({ page, sourceId: 'vk:public15' });
    const b = await capture.captureStructureBaseline({ page, sourceId: 'vk:public15' });
    assert.deepEqual(a, b);
    assert.equal(page.calls(), 2, 'quiet wait + single observed DOM read; no scroll, no POST');
    assert.equal(events.length, 1);
    const folder = join(root, 'vk-dom-structure-baselines', (await readdir(capture.baselineRoot))[0]);
    assert.equal(await readFile(join(folder, 'dom.raw.html'), 'utf8'), html);
    assert.equal(a.htmlSha256, createHash('sha256').update(html).digest('hex'));
    const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
    assert.equal(manifest.verifiedCardTemplate, false);
    assert.equal(manifest.verifiedExpectedAnnouncements, false);
    const verify1 = await verifyVkDomStructureBaseline(folder);
    const verify2 = await verifyVkDomStructureBaseline(folder);
    assert.deepEqual(verify1, verify2);
    assert.equal(verify1.wallLinkCandidates, 1);
    assert.match(await readFile(join(folder, 'PROMPT_FOR_DOM_AUDIT_RU.txt'), 'utf8'), /dom\.raw\.html/);
    await writeFile(join(folder, 'dom.raw.html'), html.replace('Анонс', 'подмена'));
    await assert.rejects(verifyVkDomStructureBaseline(folder), /hash mismatch/);
});

test('public/chat parser-all paths save a baseline before the first scroll', async () => {
    const publicSource = await readFile(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
    const chatSource = await readFile(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
    const diagnostics = await readFile(new URL('../../src/features/scrapers/manualParserDiagnostics.js', import.meta.url), 'utf8');
    assert.match(publicSource, /captureVkStructureBaseline[\s\S]*?for \(let iteration = 0; iteration < 120/);
    assert.match(chatSource, /captureVkStructureBaseline[\s\S]*?downSweepRequested/);
    assert.match(diagnostics, /async captureVkStructureBaseline\(args\)/);
});
