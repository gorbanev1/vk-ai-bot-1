import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  extractRawDateMentions,
  isEventDateConsistentWithSource,
} from '../../src/features/events/publicPostDateEvidence.js';
import { explainSecondaryPartyTextGate } from '../../src/features/events/secondaryPartyAdmission.js';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const tg = readFileSync(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8');

const now = new Date('2026-09-15T10:00:00Z');

test('secondary SQLite selection includes secondary scraper arrays before party-pool filtering', () => {
  assert.match(app, /\[\.\.\.telegramHtmlScrapers, \.\.\.secondaryTelegramHtmlScrapers\]/);
  assert.match(app, /\[\.\.\.vkPublicScrapers, \.\.\.secondaryVkPublicScrapers\]/);
  assert.match(app, /classifyEventPartyPool\(event, \{ secondarySourceKeys \}\) === PARTY_POOL_SECONDARY/);
});

test('numeric date range does not become fake year 2030', () => {
  const mentions = extractRawDateMentions('ПЛАНЫ НА НЕДЕЛЮ (26.08-30.08)');
  assert.deepEqual(
    mentions.map((item) => [item.raw, item.explicitYear]),
    [['26.08', null], ['30.08', null]],
  );
  assert.equal(isEventDateConsistentWithSource({
    eventDate: '2030-08-26',
    sourceText: 'ПЛАНЫ НА НЕДЕЛЮ (26.08-30.08)',
    publishedAt: 1787677021,
    timeZone: 'Europe/Moscow',
  }), false);
});

test('telephone tail cannot become secondary event date', () => {
  const text = 'Открываем бронирование на новогодние корпоративы. Подробности +7(905)655-11-11';
  assert.deepEqual(extractRawDateMentions(text), []);
  const gate = explainSecondaryPartyTextGate({
    text,
    referenceNow: now,
    publishedAt: 1787745600,
    timeZone: 'Europe/Moscow',
  });
  assert.equal(gate.visionEligible, false);
  assert.equal(gate.rejectionReason, 'no-date-in-semantic-body');
});

test('Telegram manual parser has a real traceAi callback instead of undefined identifier', () => {
  assert.match(tg, /async function processPost\(post, \{[\s\S]*?traceAi = null,/);
  assert.match(tg, /traceAi:\s*\(stage, data = \{\}\) => diagnostics\?\.log\?\.\(`item\.ai\.\$\{stage\}`/);
});

import { validatePublicAiEvents } from '../../src/features/events/publicPostLocalParser.js';

test('AI evidence contract accepts multiple exact quotes separated by ||', () => {
  const text = [
    '15 сентября приглашаем тебя на пивную дегустацию вместе с пивоварней Brewlok!',
    '15 сентября в 19:30',
    'Атмосферный бар Понеслось - Воронеж',
  ].join('\n');
  const rows = validatePublicAiEvents([{
    date: '2026-09-15',
    time: '19:30',
    title: 'Пивная дегустация с Brewlok',
    venue: 'Понеслось',
    participants: 'Brewlok',
    evidence: '«15 сентября приглашаем тебя на пивную дегустацию вместе с пивоварней Brewlok!»||«15 сентября в 19:30»||«Атмосферный бар Понеслось - Воронеж»',
    image_indexes: [1],
  }], {
    text,
    publishedAt: 1789324320,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Пивная дегустация с Brewlok');
});
