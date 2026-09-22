import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createVkDomFixtureCapture } from '../../src/features/scrapers/vkDomFixtureCapture.js';
import { verifyVkDomFixture } from '../../scripts/vk-dom-fixture-verify.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sample = (html, y = 0) => ({ html, capturedAt: '2026-09-20T01:20:00.000Z',
    state: { pageUrl: 'https://vk.com/public123', baseUri: 'https://vk.com/public123',
        scrollY: y, title: 'VK', viewport: { width: 1280, height: 900 },
        doctype: { name: 'html', publicId: '', systemId: '' },
        statefulElements: [{ elementIndex: 3, currentSrc: 'https://vk.com/image.jpg' }] },
    resources: [{ elementIndex: 3, tag: 'img', attributes: { src: '/image.jpg' },
        currentSrc: 'https://vk.com/image.jpg', naturalWidth: 800, naturalHeight: 1200 }] });

test('V188.138 stores unmodified baseline and each scroll iteration; hash/offline replay are deterministic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vk-dom-fixture-'));
    const capture = createVkDomFixtureCapture({ runDirectory: root, runId: 'test-run' });
    const html = '<html lang="ru"><head></head><body><div data-post-id="-12_99">  Анонс  </div><img src="/image.jpg"></body></html>';
    const first = await capture.persist({ sourceId: 'vk:public123', snapshot: sample(html), label: 'scroll-001' });
    const second = await capture.persist({ sourceId: 'vk:public123', snapshot: sample(html, 720), label: 'scroll-002' });
    assert.equal(first.iteration, 1);
    assert.equal(second.iteration, 2);
    assert.equal((await readFile(first.domPath, 'utf8')), html);
    assert.equal((await readFile(second.domPath, 'utf8')), html);
    const saved = await readFile(first.domPath);
    assert.equal(first.htmlSha256, hash(saved));
    const sourceDir = join(root, 'vk-dom-fixtures', (await readdir(join(root, 'vk-dom-fixtures')))[0]);
    const a = await verifyVkDomFixture(sourceDir);
    const b = await verifyVkDomFixture(sourceDir);
    assert.deepEqual(a, b);
    assert.equal(a.iterations, 2);
    const expectedDirectory = join(sourceDir, 'expected');
    assert.deepEqual((await readdir(sourceDir)).sort(), ['iterations', 'manifest.json'].sort(), 'expected results must not be hallucinated from existing parser');
    assert.ok(expectedDirectory);
    const entry = JSON.parse(await readFile(join(sourceDir, 'iterations', '000001', 'dom-meta.json'), 'utf8'));
    assert.equal(entry.parserResultIncluded, false);
    assert.equal(entry.scrollY, 0);
    assert.equal(entry.statefulElements[0].currentSrc, 'https://vk.com/image.jpg');
});

test('V188.138 detects a corrupted original DOM; no network or browser is involved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vk-dom-fixture-'));
    const capture = createVkDomFixtureCapture({ runDirectory: root, runId: 'test-run' });
    const item = await capture.persist({ sourceId: 'chat:123', snapshot: sample('<html><body>Первый</body></html>') });
    const sourceDir = join(root, 'vk-dom-fixtures', (await readdir(join(root, 'vk-dom-fixtures')))[0]);
    await writeFile(item.domPath, '<html><body>ПОДМЕНА</body></html>');
    await assert.rejects(verifyVkDomFixture(sourceDir), /hash mismatch/i);
});

test('V188.138 rejects invalid fixtures instead of silently giving a parser an empty page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vk-dom-fixture-'));
    const capture = createVkDomFixtureCapture({ runDirectory: root, runId: 'test-run' });
    await assert.rejects(capture.persist({ sourceId: 'vk:1', snapshot: sample('textContent only') }), /invalid documentElement/);
});

test('V188.138 both production VK finite scrapers persist immutable fixtures before extraction', async () => {
    const root = new URL('../../src/', import.meta.url);
    const publicSource = await readFile(new URL('platforms/vk/vkPublicScraper.js', root), 'utf8');
    const chatSource = await readFile(new URL('platforms/vk/vkChatEventScraper.js', root), 'utf8');
    const diagnostics = await readFile(new URL('features/scrapers/manualParserDiagnostics.js', root), 'utf8');
    assert.match(publicSource, /captureVkDomFixture[\s\S]*?extractRenderedVkPosts\(page, screenName\)/);
    assert.match(publicSource, /label: 'capture-complete'[\s\S]*?extractExactVkPostsFromDomSnapshot/);
    assert.match(chatSource, /label: `window-\$\{String\(round/);
    assert.match(chatSource, /label: 'capture-complete'[\s\S]*?extractExactMessagesFromDomSnapshot/);
    assert.match(diagnostics, /async captureVkDomFixture\(args\)/);
});
