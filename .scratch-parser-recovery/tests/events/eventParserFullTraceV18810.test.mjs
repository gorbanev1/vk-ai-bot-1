import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    createEventParserTrace,
    sanitizeEventParserTraceValue,
} from '../../src/features/events/eventParserTrace.js';

const appSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);
const browserSource = readFileSync(
    new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url),
    'utf8',
);

test('V188.10 full parser trace writes durable JSONL and mirrors latest run', () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-parser-trace-'));
    try {
        const trace = createEventParserTrace({ dataDirectory: root, label: 'test' });
        trace.log('vk.owner_structured.response', {
            response: {
                groups: [{
                    id: 239795426,
                    type: 'event',
                    start_date: 1789833600,
                    name: 'Соня / 19.09',
                }],
            },
        });
        trace.finish({ status: 'ok' });

        const content = readFileSync(trace.filePath, 'utf8');
        const latest = readFileSync(trace.latestPath, 'utf8');
        assert.match(content, /"stage":"trace.start"/u);
        assert.match(content, /"stage":"vk.owner_structured.response"/u);
        assert.match(content, /"start_date":1789833600/u);
        assert.match(content, /"stage":"trace.finish"/u);
        assert.equal(latest, content);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('V188.10 trace redacts tokens even inside raw VK HTML strings', () => {
    const sanitized = sanitizeEventParserTraceValue({
        access_token: 'vk1.secret-token',
        webToken: { access_token: 'vk1.second-secret' },
        html: '<script>window.vk={webToken:{"access_token":"vk1.third-secret"}}</script>',
        url: 'https://vk.ru/x?access_token=vk1.fourth-secret&hash=abcd',
    });
    const json = JSON.stringify(sanitized);
    assert.doesNotMatch(json, /vk1\.(?:secret|second|third|fourth)/u);
    assert.match(json, /\[REDACTED\]/u);
});

test('V188.10 proposal trace covers VK API, branch decision, browser, local parser and final draft', () => {
    const proposalBlock = appSource.slice(
        appSource.indexOf('async function parseEventProposalSubmission'),
        appSource.indexOf('const EVENT_PROPOSAL_FIELD_LABELS'),
    );
    for (const stage of [
        'proposal.input.normalized',
        'proposal.vk_direct.result',
        'proposal.vk_direct.date_decision',
        'proposal.branch.fast_path',
        'proposal.branch.browser_fallback',
        'proposal.browser.result',
        'proposal.primary_post.selected',
        'proposal.primary_post.local_events',
        'proposal.primary_post.ai_extraction',
        'proposal.final.deduplicated',
        'proposal.final.result',
    ]) {
        assert.match(proposalBlock, new RegExp(stage.replaceAll('.', '\\.'), 'u'));
    }
    assert.match(appSource, /vk\.direct_wall\.request/u);
    assert.match(appSource, /vk\.direct_wall\.response/u);
    assert.match(appSource, /vk\.owner_structured\.request/u);
    assert.match(appSource, /vk\.owner_structured\.response/u);
});

test('V188.10 browser trace records raw VK HTML, structured sources, scan steps and cleanup', () => {
    for (const stage of [
        'browser.open.begin',
        'browser.vk_structured.raw_html',
        'browser.vk_structured.runtime_sources',
        'browser.vk_structured.html_sources',
        'browser.scan.step',
        'browser.extract.dom_result',
        'browser.vk_structured.merged',
        'browser.result',
        'browser.cleanup',
    ]) {
        assert.match(browserSource, new RegExp(stage.replaceAll('.', '\\.'), 'u'));
    }
    assert.match(browserSource, /trace = null/u);
    assert.match(appSource, /Полный лог парсинга/u);
    assert.match(appSource, /dataDirectory: '\.\/data'/u);
});
