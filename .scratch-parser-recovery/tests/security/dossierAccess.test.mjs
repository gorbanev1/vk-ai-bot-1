import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);

test('dossier command is public in group chats and does not require owner access', () => {
    assert.match(source, /if \(routeDecision\.route === 'dossier'\) \{[\s\S]{0,220}await sendDossier\(/u);
    assert.doesNotMatch(
        source,
        /if \(routeDecision\.route === 'dossier'\) \{[\s\S]{0,320}!isOwnerContext\(/u,
    );
    assert.match(
        source,
        /Гигорейв досье <имя, ник или @username> — досье примерно на 2000 символов; слово «досье» и имя можно писать в любом порядке; доступно всем участникам групповой беседы/u,
    );
});

test('dossier has no password authorization state', () => {
    assert.doesNotMatch(source, /DOSSIER_PASSWORD|dossierPassword|DOSSIER_AUTH_MS/u);
    assert.doesNotMatch(source, /pendingDossierAuthorizations|getPendingDossierAuthorization/u);
    assert.doesNotMatch(source, /пароль\?|неверный пароль/u);
    assert.match(source, /async function sendDossier\(context, requestText\)/u);
});

test('dossier output is hard-capped and finalized through the V188.40 compact renderer', () => {
    assert.match(source, /const DOSSIER_OUTPUT_MAX_CHARS = 2200;/u);
    assert.match(source, /function limitDossierOutput\(value\)/u);
    assert.match(source, /maxTokens: 1100/u);
    assert.match(source, /\[FACTS\]/u);
    assert.match(source, /\[PORTRAIT\]/u);
    assert.match(source, /async function renderCompactDossier\(/u);
    assert.match(source, /variant: 'compact-v18840'/u);
    assert.match(source, /await context\.send\(compactPortrait\.text\)/u);
    assert.doesNotMatch(source, /buildDossierPortrait\(/u);
});

test('dossier stays group-only because private chats do not retain chat history', () => {
    assert.match(
        source,
        /if \(routeDecision\.route === 'dossier'\) \{\s*await context\.send\('Досье доступно только в групповых беседах\.'\)/u,
    );
});
