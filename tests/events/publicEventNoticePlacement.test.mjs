import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const cardBuilder = source.slice(
    source.indexOf('function buildSinglePublicEventMessage('),
    source.indexOf('function resolveEventImagePath(', source.indexOf('function buildSinglePublicEventMessage(')),
);
const noticeSender = source.slice(
    source.indexOf('async function sendPublicEventAutomationNotice('),
    source.indexOf('function resolveEventImagePath(', source.indexOf('async function sendPublicEventAutomationNotice(')),
);
const publicSender = source.slice(
    source.indexOf('async function sendPublicEventMessages('),
    source.indexOf('function formatNoPublicEvents(', source.indexOf('async function sendPublicEventMessages(')),
);
const fullNotice = source.slice(
    source.indexOf('const PUBLIC_EVENT_AUTOMATION_NOTICE ='),
    source.indexOf('function publicSourcesReplyMarkup(', source.indexOf('const PUBLIC_EVENT_AUTOMATION_NOTICE =')),
);

test('event cards contain the emphasized detail reminder', () => {
    assert.match(cardBuilder, /PUBLIC_EVENT_CARD_NOTICE/u);
    assert.doesNotMatch(cardBuilder, /blocks\.push\(PUBLIC_EVENT_AUTOMATION_NOTICE\)/u);
    assert.match(source, /const PUBLIC_EVENT_CARD_NOTICE = \[\s*['"]❗ УТОЧНЯЙТЕ ДЕТАЛИ НА СТРАНИЦЕ МЕРОПРИЯТИЯ! ❗['"]/u);
    assert.match(source, /УТОЧНЯЙТЕ ДЕТАЛИ НА СТРАНИЦЕ МЕРОПРИЯТИЯ!/u);
    assert.match(source, /БОТ В ТГ\(удобнее - с кнопочками\): https:\/\/t\.me\/gigorave_bot/u);
});

test('the complete coverage warning and both source commands are sent as a final notice', () => {
    assert.match(fullNotice, /Нет полной гарантии, что все мероприятия попали в выдачу/u);
    assert.match(fullNotice, /«Гигорейв источники»/u);
    assert.match(fullNotice, /«Гигорейв источники второстепенные»/u);
    assert.doesNotMatch(fullNotice, /t\.me\/gigorave_bot/u);
    assert.match(noticeSender, /const message = raw\?\.platform === 'vk'/u);
    assert.match(noticeSender, /: PUBLIC_EVENT_AUTOMATION_NOTICE/u);
    assert.match(noticeSender, /raw\?\.platform === 'vk'[\s\S]*t\.me\/gigorave_bot/u);
    assert.ok(publicSender.includes('sendPublicEventAutomationNotice(context, sentCount'));
});
