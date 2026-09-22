import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    extractVkStructuredEventsFromBootstrap,
    formatVkStructuredEventEvidence,
} from '../../src/features/events/vkStructuredEventEvidence.js';
import { parsePublicPostLocally } from '../../src/features/events/publicPostLocalParser.js';

const appSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);
const browserSource = readFileSync(
    new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url),
    'utf8',
);

test('V188.9 direct VK wall owner groups.getById data deterministically supplies the event date/time', () => {
    const [event] = extractVkStructuredEventsFromBootstrap([{
        method: 'groups.getById',
        response: {
            groups: [{
                id: 239795426,
                type: 'event',
                name: 'Соня / Марина, я умираю / 19.09 / Воронеж',
                start_date: 1789833600,
                description: '',
            }],
        },
    }]);

    assert.ok(event);
    const evidence = formatVkStructuredEventEvidence(event, {
        timeZone: 'Europe/Moscow',
    });
    assert.equal(evidence.eventDate, '2026-09-19');
    assert.equal(evidence.eventTime, '19:00');

    const [parsed] = parsePublicPostLocally({
        text: [
            evidence.text,
            'КОТЕЛЬНАЯ, 19 сентября в 19:00.',
            'Марина, я умираю!; Последняя Птичка; ГРИН',
        ].join('\n\n'),
        sourceUrl: 'https://vk.ru/wall-239795426_2',
        screenName: 'club239795426',
        publishedAt: 0,
    });
    assert.ok(parsed);
    assert.equal(parsed.eventDate, '2026-09-19');
    assert.equal(parsed.eventTime, '19:00');
    assert.equal(parsed.venue, 'КОТЕЛЬНАЯ');
});

test('V188.9 direct wall hydration queries owner structured fields before browser/AI', () => {
    const helperStart = appSource.indexOf('async function hydrateVkWallOwnerStructuredEvent');
    const wallHydrateStart = appSource.indexOf('async function hydrateExactVkWallPostForEvent');
    const proposalStart = appSource.indexOf('async function parseEventProposalSubmission');
    assert.ok(helperStart >= 0);
    assert.ok(wallHydrateStart > helperStart);
    assert.ok(proposalStart > wallHydrateStart);

    const helperBlock = appSource.slice(helperStart, wallHydrateStart);
    assert.match(helperBlock, /vk\.api\.groups\.getById/u);
    assert.match(helperBlock, /'start_date'/u);
    assert.match(helperBlock, /'finish_date'/u);
    assert.match(helperBlock, /extractVkStructuredEventsFromBootstrap/u);
    assert.match(helperBlock, /formatVkStructuredEventEvidence/u);

    const wallBlock = appSource.slice(wallHydrateStart, proposalStart);
    assert.match(wallBlock, /ownerStructuredEvent = await hydrateVkWallOwnerStructuredEvent/u);
    assert.match(wallBlock, /ownerStructuredEvent\?\.evidenceText/u);
    assert.match(wallBlock, /eventDate: ownerStructuredEvent\?\.eventDate/u);
});

test('V188.9 direct wall only bypasses Chromium when deterministic date evidence exists', () => {
    const proposalBlock = appSource.slice(
        appSource.indexOf('async function parseEventProposalSubmission'),
        appSource.indexOf('async function handleEventProposalSubmission'),
    );
    assert.match(proposalBlock, /exactVkLocalDateEvidence/u);
    assert.match(proposalBlock, /exactVkHasDateEvidence/u);
    assert.match(proposalBlock, /if \(exactVkPost && exactVkHasDateEvidence\)/u);
    assert.match(proposalBlock, /Required VK structured fields were not available[\s\S]{0,1400}openEventLinkForReview/u);
    assert.match(proposalBlock, /mergeManualExactVkPostSources/u);
});

test('V188.9 fallback browser pass is finite and closes its tab without user closure', () => {
    assert.match(browserSource, /openEventLinkForReview\(\{[\s\S]{0,450}keepPageOpen = false/u);
    assert.match(browserSource, /finally \{[\s\S]{0,700}!keepPageOpen[\s\S]{0,350}page\.close/u);
});
