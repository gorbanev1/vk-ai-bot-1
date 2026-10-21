import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
    armPostEventFeedbackRecipients,
    getPendingPostEventFeedbackRequest,
    getPostEventFeedbackReviews,
    getPostEventFeedbackStats,
    savePostEventFeedbackReview,
} from '../../src/infrastructure/database/index.js';
import { parseCoordsOverrideCommand } from '../../src/features/coords/coordsOverrideRouting.js';

const applicationSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);

test('V109 exposes owner post-event broadcast and review commands', () => {
    assert.equal(parseCoordsOverrideCommand('разослать всем пересоздание').action, 'peresozdanie-broadcast-start');
    assert.equal(parseCoordsOverrideCommand('пересоздание отправить').action, 'peresozdanie-broadcast-send');
    assert.equal(parseCoordsOverrideCommand('пересоздание отменить').action, 'peresozdanie-broadcast-cancel');
    assert.equal(parseCoordsOverrideCommand('пересоздание текст').action, 'peresozdanie-broadcast-edit');
    assert.equal(parseCoordsOverrideCommand('пересоздание шаблон').action, 'peresozdanie-template');
    assert.equal(parseCoordsOverrideCommand('пересоздание отзывы').action, 'peresozdanie-reviews');
    assert.equal(parseCoordsOverrideCommand('пересоздание отзывы статус').action, 'peresozdanie-review-stats');
});

test('V109 feedback state arms delivered endpoint and consumes exactly one review', () => {
    const campaignKey = `v109-test-${Date.now()}-${Math.random()}`;
    const recipient = {
        platform: 'telegram',
        endpointKey: 'telegram',
        externalUserId: '901001',
        externalPeerId: '901001',
    };

    assert.equal(armPostEventFeedbackRecipients({ campaignKey, recipients: [recipient], sentAt: 100 }), 1);
    assert.ok(getPendingPostEventFeedbackRequest({ campaignKey, ...recipient }));

    const reviewId = savePostEventFeedbackReview({
        campaignKey,
        ...recipient,
        reviewText: 'Было круто, сделайте ещё.',
        receivedAt: 200,
    });
    assert.ok(reviewId > 0);
    assert.equal(getPendingPostEventFeedbackRequest({ campaignKey, ...recipient }), null);

    const reviews = getPostEventFeedbackReviews({ campaignKey });
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].reviewText, 'Было круто, сделайте ещё.');
    assert.deepEqual(getPostEventFeedbackStats({ campaignKey }), {
        sent: 1,
        awaiting: 0,
        reviews: 1,
    });
});

test('V109 application sends template through coords recipient endpoints and forwards feedback to owner', () => {
    assert.match(applicationSource, /PERESOZDANIE_FEEDBACK_TEMPLATE/u);
    assert.match(applicationSource, /разослать всем пересоздание/u);
    assert.match(applicationSource, /пересоздание отправить/u);
    assert.match(applicationSource, /armPostEventFeedbackRecipients/u);
    assert.match(applicationSource, /maybeHandlePostEventFeedbackIncoming/u);
    assert.match(applicationSource, /ОТЗЫВ ПО «ПЕРЕСОЗДАНИЮ»/u);
    assert.match(applicationSource, /\+79968257889/u);
});
