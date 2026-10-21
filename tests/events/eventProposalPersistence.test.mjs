import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventProposalOnce, getPendingEventProposals, updatePendingEventProposal, resolveEventProposal, getMaintenanceState } from '../../src/infrastructure/database/index.js';
test('durable submission token prevents duplicates and edits only pending proposals', () => {
    const input = { submitterPlatform: 'telegram', submitterExternalId: '123', parsedEvents: [{ title: 'Draft', contacts: '@org' }] };
    const p = createEventProposalOnce('test:user:draft', input);
    assert.equal(createEventProposalOnce('test:user:draft', input).id, p.id);
    assert.equal(getPendingEventProposals().filter(row => row.id === p.id).length, 1);
    assert.equal(getMaintenanceState('event-proposal-submitted:test:user:draft').details.id, p.id);
    assert.equal(updatePendingEventProposal(p.id, [{ title: 'Updated', contacts: '@org' }]).parsedEvents[0].title, 'Updated');
    resolveEventProposal({ id: p.id, status: 'rejected' });
    assert.equal(updatePendingEventProposal(p.id, [{ title: 'Wrong' }]), null);
    assert.equal(createEventProposalOnce('test:user:draft', input).status, 'rejected');
});
