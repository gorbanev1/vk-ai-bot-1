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
    assert.match(block, /runDetachedSupervisedOperation\(/u);
    assert.match(block, /snapshotQueued: true/u);
});

test('owner moderation goes through a shared lock before generic proposal routing', () => {
    const block = sliceFunction('async function maybeHandleEventProposalIncoming', 'async function processDueEventProposals');
    assert.ok(block.indexOf('parseEventProposalModerationDecision') < block.indexOf('eventProposalSubmission.handle'));
    assert.match(block, /eventProposalSubmission.moderate/u);
    assert.doesNotMatch(block, /parseEventProposalSubmission|openEventLinkForReview/u);
    assert.match(appSource, /proposalMaterializationLocks/u);
});
