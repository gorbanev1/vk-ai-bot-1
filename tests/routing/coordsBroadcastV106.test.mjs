import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
    clearCoordsRequestRecipients,
    getCoordsRequestRecipients,
    recordCoordsRequestRecipient,
} from '../../src/infrastructure/database/index.js';

const applicationSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);

test('V106 records coords requesters with platform endpoint identity and de-duplicates repeated requests', () => {
    clearCoordsRequestRecipients();
    recordCoordsRequestRecipient({
        platform: 'vk',
        endpointKey: 'vk:primary',
        externalUserId: '111',
        externalPeerId: '111',
        requestedAt: 100,
    });
    recordCoordsRequestRecipient({
        platform: 'vk',
        endpointKey: 'vk:primary',
        externalUserId: '111',
        externalPeerId: '111',
        requestedAt: 200,
    });
    recordCoordsRequestRecipient({
        platform: 'vk',
        endpointKey: 'vk:event',
        externalUserId: '111',
        externalPeerId: '111',
        requestedAt: 300,
    });
    recordCoordsRequestRecipient({
        platform: 'telegram',
        endpointKey: 'telegram',
        externalUserId: '222',
        externalPeerId: '222',
        requestedAt: 400,
    });

    const rows = getCoordsRequestRecipients();
    assert.equal(rows.length, 3);
    assert.equal(rows.find((row) => row.endpointKey === 'vk:primary')?.requestCount, 2);
    assert.equal(rows.find((row) => row.endpointKey === 'vk:event')?.requestCount, 1);
    assert.equal(rows.find((row) => row.platform === 'telegram')?.requestCount, 1);
    clearCoordsRequestRecipients();
});

test('V106 broadcast keeps three delivery endpoints separate and excludes group chats from registry', () => {
    assert.match(applicationSource, /events-v\d+-[a-z0-9-]+/u);
    assert.match(applicationSource, /endpointKey: connection\?\.label === 'event' \? 'vk:event' : 'vk:primary'/u);
    assert.match(applicationSource, /endpointKey: 'telegram'/u);
    assert.match(applicationSource, /if \(!isPrivateContext\(context\) \|\| isOwnerContext\(context\)\)/u);
    assert.match(applicationSource, /recipient\.endpointKey === 'vk:event' \? eventVk : primaryVk/u);
    assert.match(applicationSource, /telegramBot\.api\.sendMessage/u);
    assert.match(applicationSource, /recordCoordsRequester\(context\);/u);
});

test('V106 owner broadcast uses draft then explicit send command', () => {
    assert.match(applicationSource, /корды рассылка отправить/u);
    assert.match(applicationSource, /pendingCoordsBroadcastInputs/u);
    assert.match(applicationSource, /phase: 'await-message'/u);
    assert.match(applicationSource, /phase: 'ready'/u);
    assert.match(applicationSource, /Рассылка завершена\./u);
});
