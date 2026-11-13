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
const actionsGuide = source.slice(
    source.indexOf('const PUBLIC_EVENT_CARD_ACTIONS_GUIDE ='),
    source.indexOf('const VK_TELEGRAM_BOT_PROMO_LINE =', source.indexOf('const PUBLIC_EVENT_CARD_ACTIONS_GUIDE =')),
);
const telegramActions = source.slice(
    source.indexOf('export function buildTelegramEventCardActions('),
    source.indexOf('async function handleTelegramEventCalendarCallback(', source.indexOf('export function buildTelegramEventCardActions(')),
);

test('event cards contain the emphasized detail reminder', () => {
    assert.match(cardBuilder, /String\(platform\)\.toLowerCase\(\) === 'vk'[\s\S]*PUBLIC_EVENT_CARD_NOTICE/u);
    assert.match(cardBuilder, /String\(platform\)\.toLowerCase\(\) === 'vk'[\s\S]*PUBLIC_EVENT_CARD_ACTIONS_GUIDE/u);
    assert.match(actionsGuide, /Попросить напомнить \(в этом чате\)/u);
    assert.match(actionsGuide, /напоминание придёт в беседу/u);
    assert.match(actionsGuide, /Напомнить всем[^\n]*напоминание придёт в эту беседу/u);
    assert.match(actionsGuide, /Добавить в календарь[^\n]*переход к вариантам календарей/u);
    assert.match(actionsGuide, /личного напоминания откройте чат с Telegram-ботом или напишите сообществу «Гигорейв» во ВКонтакте/u);
    assert.match(telegramActions, /Попросить бота напомнить о событии/u);
    assert.match(telegramActions, /Добавить в календарь/u);
    assert.doesNotMatch(telegramActions, /Напомнить всем|Яндекс\.Карт|Источник/u);
    assert.doesNotMatch(cardBuilder, /blocks\.push\(PUBLIC_EVENT_AUTOMATION_NOTICE\)/u);
    assert.match(source, /const PUBLIC_EVENT_CARD_NOTICE = \[\s*['"]❗ УТОЧНЯЙТЕ ДЕТАЛИ НА СТРАНИЦЕ МЕРОПРИЯТИЯ! ❗['"]/u);
    assert.match(source, /УТОЧНЯЙТЕ ДЕТАЛИ НА СТРАНИЦЕ МЕРОПРИЯТИЯ!/u);
    assert.match(source, /БОТ В ТГ — УДОБНЕЕ С КНОПОЧКАМИ: https:\/\/t\.me\/Gigorave_bot/u);
});

test('the complete coverage warning and both source commands are sent as a final notice', () => {
    assert.match(fullNotice, /Нет полной гарантии, что все мероприятия попали в выдачу/u);
    assert.match(fullNotice, /«Гигорейв источники»/u);
    assert.match(fullNotice, /«Гигорейв источники второстепенные»/u);
    assert.doesNotMatch(fullNotice, /t\.me\/Gigorave_bot/u);
    assert.match(noticeSender, /const message = raw\?\.platform === 'vk'/u);
    assert.match(noticeSender, /: PUBLIC_EVENT_AUTOMATION_NOTICE/u);
    assert.match(noticeSender, /raw\?\.platform === 'vk'[\s\S]*VK_TELEGRAM_BOT_PROMO_LINE/u);
    assert.ok(publicSender.includes('sendPublicEventAutomationNotice(context, sentCount'));
    assert.doesNotMatch(cardBuilder, /blocks\.push\(VK_TELEGRAM_BOT_PROMO_LINE\)/u);
    assert.doesNotMatch(source.slice(source.indexOf('function buildCompactPublicEventsMessage('), source.indexOf('async function sendCompactPublicEventList(')), /VK_TELEGRAM_BOT_PROMO_LINE/u);
    assert.match(source, /БОТ В ТГ — УДОБНЕЕ С КНОПОЧКАМИ: https:\/\/t\.me\/Gigorave_bot/u);
    assert.match(source, /raw\?\.platform === 'vk'[\s\S]*: PUBLIC_EVENT_AUTOMATION_NOTICE/u);
});
