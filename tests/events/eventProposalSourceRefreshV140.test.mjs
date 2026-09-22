import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const browserSource = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');

test('V140 owner proposal refreshes an already stored source before normal proposal flow', () => {
    const refreshCall = appSource.indexOf('tryRefreshExistingOwnerEventSubmission(context, clean)');
    const normalProgress = appSource.indexOf("🔎 Принято. Просматриваю материал, ищу посты события и собираю черновик.");
    assert.ok(refreshCall >= 0, 'owner refresh hook must exist');
    assert.ok(normalProgress > refreshCall, 'existing-source refresh must run before normal proposal parsing');
    assert.match(appSource, /Обновил уже существующий анонс, новую заявку и дубль не создавал/u);
});

test('V140 exact VK wall proposals keep the API fast path and only open Chromium when date evidence is still missing', () => {
    assert.match(appSource, /const exactVkHasDateEvidence = Boolean\(exactVkPost\?\.eventDate\) \|\| exactVkLocalDateEvidence/u);
    assert.match(appSource, /if \(exactVkPost && exactVkHasDateEvidence\) \{[\s\S]{0,2200}linkData = \{/u);
    assert.match(appSource, /Required VK structured fields were not available[\s\S]{0,1200}openEventLinkForReview/u);
    assert.match(appSource, /VK direct post proposal/u);
});

test('V140 manual event browser access is bounded instead of waiting 15 minutes', () => {
    assert.match(browserSource, /openEventLinkForReview\(\{[\s\S]{0,400}navigationTimeoutMs = 45_000,[\s\S]{0,120}manualAccessTimeoutMs = 45_000/u);
    assert.match(browserSource, /timeoutMs: Math\.max\(5_000, Number\(manualAccessTimeoutMs\)/u);
});

test('V140 proposal AI calls have a dedicated bounded timeout', () => {
    assert.match(appSource, /EVENT_PROPOSAL_AI_TIMEOUT_MS[\s\S]{0,180}= clampInteger/u);
    assert.match(appSource, /requestTimeoutMs: EVENT_PROPOSAL_AI_TIMEOUT_MS/u);
});


test('V140 existing-source refresh does not wait for a full AI snapshot rebuild', () => {
    const start = appSource.indexOf('async function refreshStoredEventsFromFreshSource');
    const end = appSource.indexOf('async function tryRefreshExistingOwnerEventSubmission', start);
    const block = appSource.slice(start, end);
    assert.match(block, /invalidateVerifiedPartySnapshot\(`source-refresh:\$\{reason\}`\)/u);
    assert.match(block, /void rebuildVerifiedPartySnapshotQueued/u);
    assert.doesNotMatch(block, /await rebuildVerifiedPartySnapshotQueued/u);
});

test('V140 exact source repair saves only the best real poster with a bounded download', () => {
    const start = appSource.indexOf('async function tryRefreshExistingOwnerEventSubmission');
    const end = appSource.indexOf('function extractHttpUrls', start);
    const block = appSource.slice(start, end);
    assert.match(block, /maxSourceImages: 1/u);
    assert.match(block, /downloadTimeoutMs: 20_000/u);
    assert.match(block, /generateFallback: false/u);
});
