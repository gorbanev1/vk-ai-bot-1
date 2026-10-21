import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);

test('roast runtime loads the full VK conversation roster', () => {
    assert.match(source, /messages\.getConversationMembers/u);
    assert.match(source, /ROAST_VK_ROSTER_CACHE_MS/u);
    assert.match(source, /mergeRoastParticipants/u);
});

test('named roast resolves explicit VK references before AI ranking', () => {
    const explicitIndex = source.indexOf('resolveExplicitVkRoastParticipant');
    const aiPromptIndex = source.indexOf('buildAiTargetSelectionPrompts', explicitIndex);

    assert.ok(explicitIndex >= 0);
    assert.ok(aiPromptIndex > explicitIndex);
});

test('roast does not refuse when a named target lacks recent messages', () => {
    assert.match(source, /name-only-fallback/u);
    assert.match(source, /За последние 24 часа сообщений цели нет/u);
    assert.match(source, /persona: effectivePersona/u);
    assert.doesNotMatch(
        source.slice(
            source.indexOf('async function handleRoastCommand'),
            source.indexOf('function randomUnitInterval'),
        ),
        /Не смог уверенно понять/u,
    );
});
