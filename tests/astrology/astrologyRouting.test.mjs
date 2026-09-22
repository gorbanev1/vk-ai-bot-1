import assert from 'node:assert/strict';

import {
    getAstrologyRequestKind,
    isLocalAstrologyRequest,
    isNatalRequest,
    isNonLocalAstrologyRequest,
    isPrashnaRequest,
    isProAstrologyMode,
    resolveAstrologyExecution,
} from '../../src/features/astrology/astrologyRouting.js';

assert.equal(isPrashnaRequest('прашна нравится ли чату бот?'), true);
assert.equal(isPrashnaRequest('джйотиш прашна вопрос'), true);
assert.equal(isPrashnaRequest('хорарная карта вопроса'), true);
assert.equal(isPrashnaRequest('джйотиш натал 01.01.2000'), false);
assert.equal(isPrashnaRequest('натальная карта человека'), false);
assert.equal(isPrashnaRequest('просто джйотиш'), false);

assert.equal(isNatalRequest('натал 01.01.2000 12:00 Москва'), true);
assert.equal(isNatalRequest('натальная карта'), true);
assert.equal(isNatalRequest('birth chart 2000-01-01'), true);
assert.equal(getAstrologyRequestKind('натал данные'), 'natal');
assert.equal(getAstrologyRequestKind('прашна вопрос'), 'prashna');
assert.equal(getAstrologyRequestKind('обычный вопрос'), 'none');

for (const value of [
    'прашна нелокал вопрос',
    'прашна не локальный расчет вопрос',
    'прашна без локального расчёта вопрос',
    'натал не считай локально',
]) {
    assert.equal(isNonLocalAstrologyRequest(value), true, value);
    assert.equal(isLocalAstrologyRequest(value), false, value);
}

for (const value of [
    'pro3 прашна локалэфемериды вопрос',
    'pro2 натал локал 14.03.1987 19:40 Воронеж',
    'прашна расчет локально Москва вопрос',
    'натал локальные эфемериды 01.01.2000 12:00 Москва',
    'prashna local ephemeris Moscow question',
    'pro3 прашна макс техрасчет эфемерид локальным софтом',
    'натал рассчитай своим локальным движком',
]) {
    assert.equal(isLocalAstrologyRequest(value), true, value);
}

assert.equal(isNonLocalAstrologyRequest('обычный локальный вопрос'), false);
assert.equal(isLocalAstrologyRequest('обычный локальный вопрос'), false);

assert.equal(isProAstrologyMode('pro'), true);
assert.equal(isProAstrologyMode('pro2'), true);
assert.equal(isProAstrologyMode('pro3'), true);
assert.equal(isProAstrologyMode('gpt55'), false);

for (const kind of ['natal', 'prashna']) {
    for (const mode of ['default', 'gpt54', 'gpt55', 'pro', 'pro2', 'pro3']) {
        const execution = resolveAstrologyExecution({ kind, mode });
        assert.equal(execution.localCalculation, true, `${kind}/${mode}`);
        assert.equal(execution.modelCalculation, false, `${kind}/${mode}`);
        assert.equal(execution.packet, 'maximum', `${kind}/${mode}`);
        assert.equal(execution.reason, 'mandatory-local-swiss', `${kind}/${mode}`);

        const forcedLocal = resolveAstrologyExecution({ kind, mode, localRequested: true });
        assert.equal(forcedLocal.localCalculation, true, `${kind}/${mode}/local`);
        assert.equal(forcedLocal.modelCalculation, false, `${kind}/${mode}/local`);
        assert.equal(forcedLocal.packet, 'maximum', `${kind}/${mode}/local`);
        assert.equal(forcedLocal.reason, 'mandatory-local-swiss', `${kind}/${mode}/local`);
    }
}

const explicitNonLocal = resolveAstrologyExecution({
    kind: 'natal',
    mode: 'pro3',
    nonLocalRequested: true,
    localRequested: true,
});
assert.equal(explicitNonLocal.localCalculation, true);
assert.equal(explicitNonLocal.modelCalculation, false);
assert.equal(explicitNonLocal.packet, 'maximum');
assert.equal(explicitNonLocal.reason, 'mandatory-local-swiss-overrides-nonlocal');

console.log('astrologyRouting tests: OK');
