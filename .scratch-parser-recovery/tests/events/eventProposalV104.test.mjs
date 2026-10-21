import assert from 'node:assert/strict';
import {
    createEventProposal,
    getDueEventProposals,
    getEventProposal,
    resolveEventProposal,
} from '../../src/infrastructure/database/index.js';

const now = Math.floor(Date.now() / 1000);
const marker = `v104-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const id = createEventProposal({
    submitterPlatform: 'telegram',
    submitterExternalId: marker,
    submitterInternalId: 123,
    rawSubmission: 'Тестовая туса 22 августа 2026 в 17:00',
    sourceUrl: `https://example.com/${marker}`,
    parsedEvents: [{
        title: 'Тестовая туса',
        eventDate: '2099-08-22',
        eventTime: '17:00',
        venue: 'Тестовая площадка',
        participants: '',
        price: 'бесплатно',
        description: 'Тест.',
        sourceUrl: `https://example.com/${marker}`,
        imagePaths: [],
    }],
    submittedAt: now - 120,
    expiresAt: now - 1,
});

const proposal = getEventProposal(id);
assert.equal(proposal.status, 'pending');
assert.equal(proposal.submitterExternalId, marker);
assert.equal(proposal.parsedEvents[0].title, 'Тестовая туса');

const due = getDueEventProposals(now, 1000);
assert.ok(due.some((item) => item.id === id));

const resolved = resolveEventProposal({
    id,
    status: 'rejected',
    reviewedByPlatform: 'test',
    reviewedBy: 1,
    resolvedAt: now,
});
assert.equal(resolved.status, 'rejected');
assert.equal(resolved.reviewedByPlatform, 'test');

console.log('eventProposalV104.test.mjs: OK');
