import assert from 'node:assert/strict';
import test from 'node:test';

import {
    extractVkTargetReference,
    mergeRoastParticipants,
    normalizeVkConversationMembers,
    participantFromVkProfile,
} from '../../src/features/personality/roastParticipantRoster.js';

test('extracts VK mention, screen name and profile link', () => {
    assert.deepEqual(extractVkTargetReference('[id123|Тимофей]'), {
        userId: 123,
        screenName: '',
        displayName: 'Тимофей',
        source: 'vk-mention',
    });
    assert.deepEqual(extractVkTargetReference('@timasin228'), {
        userId: 0,
        screenName: 'timasin228',
        displayName: '@timasin228',
        source: 'vk-screen-name',
    });
    assert.equal(
        extractVkTargetReference('https://vk.com/timasin228').screenName,
        'timasin228',
    );
});

test('normalizes conversation members with names and screen-name aliases', () => {
    const participants = normalizeVkConversationMembers({
        count: 2,
        items: [
            { member_id: 123 },
            { member_id: 456 },
        ],
        profiles: [
            {
                id: 123,
                first_name: 'Тимофей',
                last_name: 'Иванов',
                screen_name: 'timasin228',
            },
            {
                id: 456,
                first_name: 'Пётр',
                last_name: 'Петров',
                screen_name: 'petr',
            },
        ],
    });

    assert.equal(participants.length, 2);
    assert.equal(participants[0].displayName, 'Тимофей Иванов');
    assert.equal(participants[0].aliases.includes('@timasin228'), true);
    assert.equal(participants[0].aliases.includes('[id123|Тимофей Иванов]'), true);
});

test('merges message history and full roster without losing recent timestamp', () => {
    const merged = mergeRoastParticipants(
        [{
            userId: 123,
            displayName: 'Тимофей Иванов',
            aliases: ['Тимофей'],
            lastSeenAt: 500,
        }],
        [{
            userId: 123,
            displayName: 'Тимофей Иванов',
            screenName: 'timasin228',
            aliases: ['@timasin228'],
            lastSeenAt: 0,
            rosterSource: 'vk-conversation-members',
        }],
    );

    assert.equal(merged.length, 1);
    assert.equal(merged[0].lastSeenAt, 500);
    assert.equal(merged[0].aliases.includes('@timasin228'), true);
});

test('builds a roast participant from users.get profile', () => {
    const participant = participantFromVkProfile({
        id: 123,
        first_name: 'Тимофей',
        last_name: 'Иванов',
        screen_name: 'timasin228',
    });

    assert.equal(participant.userId, 123);
    assert.equal(participant.displayName, 'Тимофей Иванов');
    assert.equal(participant.externalUserId, 'timasin228');
});
