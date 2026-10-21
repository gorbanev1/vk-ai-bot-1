import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);

function sliceFunction(startNeedle, endNeedle) {
    const start = appSource.indexOf(startNeedle);
    const end = appSource.indexOf(endNeedle, start + startNeedle.length);
    assert.ok(start >= 0, `missing start: ${startNeedle}`);
    assert.ok(end > start, `missing end: ${endNeedle}`);
    return appSource.slice(start, end);
}

test('V188.12 approved proposal does not await the expensive verified snapshot rebuild', () => {
    const block = sliceFunction(
        'async function materializeEventProposal',
        'async function rejectEventProposal',
    );

    assert.match(block, /const snapshotReason = `event-proposal:\$\{finalStatus\}:\$\{proposal\.id\}`/u);
    assert.match(block, /invalidateVerifiedPartySnapshot\(snapshotReason\)/u);
    assert.match(block, /void rebuildVerifiedPartySnapshotQueued\(\{/u);
    assert.doesNotMatch(block, /await rebuildVerifiedPartySnapshotQueued\(/u);
    assert.match(block, /snapshotQueued: true/u);
});

test('V188.12 owner moderation uses the cached proposal before any pending-edit/generic proposal routing', () => {
    const block = sliceFunction(
        'async function maybeHandleEventProposalIncoming',
        'async function processDueEventProposals',
    );

    const decisionIndex = block.indexOf('parseEventProposalModerationDecision');
    const pendingIndex = block.indexOf('pendingEventProposalInputs.get');
    const genericSubmissionIndex = block.lastIndexOf('handleEventProposalSubmission(context, body)');
    assert.ok(decisionIndex >= 0);
    assert.ok(pendingIndex > decisionIndex);
    assert.ok(genericSubmissionIndex > pendingIndex);

    const moderationBranch = block.slice(
        block.indexOf('if (decision) {'),
        block.indexOf('const inputKey = getEventProposalInputKey', decisionIndex),
    );
    assert.match(moderationBranch, /materializeEventProposal\(proposal/u);
    assert.match(moderationBranch, /source=cached-proposal/u);
    assert.doesNotMatch(moderationBranch, /parseEventProposalSubmission|openEventLinkForReview|hydrateExactVkWallPostForEvent|recoverVkEventPosterWithBrowser/u);
});

test('V188.12 moderation and background snapshot logs expose elapsed milliseconds', () => {
    assert.match(appSource, /\[EVENT PROPOSAL MODERATION FASTPATH\]/u);
    assert.match(appSource, /\[EVENT PROPOSAL MODERATION DONE\]/u);
    assert.match(appSource, /\[EVENT PROPOSAL SNAPSHOT BACKGROUND DONE\]/u);
    assert.match(appSource, /elapsedMs=\$\{Date\.now\(\) - moderationStartedAt\}/u);
});
