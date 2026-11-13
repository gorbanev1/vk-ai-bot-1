import assert from 'node:assert/strict';
import test from 'node:test';
import {
    detectActiveCommunicationOptOut,
    isInitiativeOptedOut,
    recordActiveInitiative,
    reserveActiveInitiative,
    shouldAllowInitiativeText,
    setInitiativeOptOut,
} from '../../src/features/personality/activeCommunicationPolicy.js';

test('active communication policy limits target peer to two initiatives per 180 seconds', () => {
    let state = {};
    const reservations = new Map();
    const getState = () => state;
    const setState = next => { state = next; };
    assert.equal(reserveActiveInitiative({ peerId: 2000000011, nowSec: 100, getState, setState, reservations }).allowed, true);
    assert.equal(reserveActiveInitiative({ peerId: 2000000011, nowSec: 120, getState, setState, reservations }).allowed, true);
    assert.equal(reserveActiveInitiative({ peerId: 2000000011, nowSec: 130, getState, setState, reservations }).allowed, false);
    assert.equal(reserveActiveInitiative({ peerId: 2000000011, nowSec: 281, getState, setState, reservations }).allowed, true);
});

test('repeated initiative topic is cooled down without blocking a first joke', () => {
    let state = {};
    const reservations = new Map();
    const getState = () => state;
    const setState = next => { state = next; };
    const first = reserveActiveInitiative({ peerId: 2000000011, nowSec: 100, getState, setState, reservations });
    recordActiveInitiative({ peerId: 2000000011, token: first.token, text: 'Опять свадьба и женитьба', sourceText: 'новости', getState, setState, reservations, nowSec: 100 });
    assert.equal(shouldAllowInitiativeText({ peerId: 2000000011, text: 'Свадьба снова?', getState, random: () => 0.2, nowSec: 101 }).allowed, true);
    assert.equal(shouldAllowInitiativeText({ peerId: 2000000011, text: 'Свадьба опять', getState, random: () => 0.9, nowSec: 102 }).allowed, false);
});

test('stop request is ignored when it is a reply to another participant', () => {
    assert.equal(detectActiveCommunicationOptOut('Отстань', {
        directedAtBot: false,
        senderId: 7,
        replyMessage: { from_id: 9, text: 'подколи его' },
        botIds: [-123],
    }).matched, false);
    assert.equal(detectActiveCommunicationOptOut('Гигорейв, отстань', { directedAtBot: true, senderId: 7 }).matched, true);
});

test('opt-out persists per participant', () => {
    let state = {};
    setInitiativeOptOut({ peerId: 2000000011, targetUserId: 7, optedOut: true, getState: () => state, setState: next => { state = next; } });
    assert.equal(isInitiativeOptedOut({ peerId: 2000000011, targetUserId: 7, getState: () => state }), true);
    assert.equal(isInitiativeOptedOut({ peerId: 2000000011, targetUserId: 8, getState: () => state }), false);
});
