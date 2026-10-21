import assert from 'node:assert/strict';
import test from 'node:test';

import {
    expandParticipantIdentityGroup,
    participantNamePartSimilarity,
} from '../../src/features/personality/roastCommandRouting.js';
import {
    buildParticipantMentionContextWindows,
    resolveParticipantReferenceTarget,
} from '../../src/features/ai/participantQuestionRouting.js';

const participants = [
    { userId: 1, displayName: 'Святой Котец', aliases: [], lastSeenAt: 10 },
    { userId: 2, displayName: 'Тимофей Тимофеев', aliases: [], lastSeenAt: 30 },
    { userId: 3, displayName: 'Тимасин Тимасинский', aliases: [], lastSeenAt: 20 },
    { userId: 4, displayName: 'Тимофей Другой', aliases: [], lastSeenAt: 40 },
];

test('V188.7 rejects exactly-80-percent accidental name match', () => {
    const score = participantNamePartSimilarity('связь', participants[0]);
    assert.equal(score, 0.8, 'regression fixture must stay exactly on the boundary');

    const resolution = resolveParticipantReferenceTarget('где связь?', participants);
    assert.equal(resolution.matched, false);
    assert.equal(resolution.participant, null);
});

test('V188.7 accepts an ordinary name part only when similarity is strictly above 80 percent', () => {
    const score = participantNamePartSimilarity('Святои', participants[0]);
    assert.ok(score > 0.8);
    const resolution = resolveParticipantReferenceTarget('Святои', participants);
    assert.equal(resolution.matched, true);
    assert.equal(resolution.participant.userId, 1);
});

test('V188.7 Timasin/Timofey default identity expands only the two configured profiles', () => {
    for (const query of ['Тимасин', 'Тимасина', 'Тимофей', 'Тимофея']) {
        const resolution = resolveParticipantReferenceTarget(query, participants);
        assert.equal(resolution.matched, true, query);
        const expanded = expandParticipantIdentityGroup(
            resolution.participant,
            participants,
            query,
        ).map((participant) => participant.userId).sort((a, b) => a - b);
        assert.deepEqual(expanded, [2, 3], query);
    }
});

test('V188.7 an explicit different full Timofey name is not swallowed by the special default alias', () => {
    const resolution = resolveParticipantReferenceTarget('Тимофей Другой', participants);
    assert.equal(resolution.matched, true);
    assert.equal(resolution.participant.userId, 4);
    assert.deepEqual(
        expandParticipantIdentityGroup(resolution.participant, participants, 'Тимофей Другой')
            .map((participant) => participant.userId),
        [4],
    );
});

test('V188.7 mention context windows use ten messages on each side and merge overlaps', () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({ id: index }));
    const matches = [
        { message: messages[12] },
        { message: messages[18] },
        { message: messages[38] },
    ];
    const windows = buildParticipantMentionContextWindows(messages, matches, { radius: 10 });
    assert.deepEqual(
        windows.map(({ startIndex, endIndex }) => [startIndex, endIndex]),
        [[2, 39]],
    );
});
