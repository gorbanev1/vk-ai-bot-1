import test from 'node:test';
import assert from 'node:assert/strict';
import {
  explainSecondaryPartyTextGate,
  secondaryJointVisionAccepted,
} from '../../src/features/events/secondaryPartyAdmission.js';

const now = new Date('2026-09-15T10:00:00Z');
const common = { referenceNow: now, publishedAt: Math.floor(now.getTime() / 1000), timeZone: 'Europe/Moscow' };

test('secondary direct gate requires body date + body time + likely title and never metadata-only date', () => {
  const accepted = explainSecondaryPartyTextGate({
    ...common,
    text: 'STONEHAND\n19 сентября 20:00\nЖдём на вечеринке',
  });
  assert.equal(accepted.visionEligible, true);
  assert.equal(accepted.route, 'date-time-title-direct');
  assert.equal(accepted.evidenceSource, 'semantic-post-text-only');
  assert.equal(accepted.metadataDateAccepted, false);

  const noBodyDate = explainSecondaryPartyTextGate({
    ...common,
    text: 'STONEHAND сегодня в 20:00'.replace('сегодня', ''),
  });
  assert.equal(noBodyDate.visionEligible, false);
  assert.equal(noBodyDate.rejectionReason, 'no-date-in-semantic-body');
});

test('secondary heuristic route allows date + >=65 party/title confidence without explicit time', () => {
  const result = explainSecondaryPartyTextGate({
    ...common,
    text: '19 сентября\nВечеринка под названием «Грязные танцы»\nЖдём всех!',
  });
  assert.equal(result.visionEligible, true);
  assert.equal(result.hasTimeInBody, false);
  assert.equal(result.route, 'date-title-party-heuristic-65');
  assert.ok(result.titleConfidence >= 65);
  assert.ok(result.eventIntentConfidence >= 65);
});

test('commercial post and carousel counter do not create secondary event admission', () => {
  const commercial = explainSecondaryPartyTextGate({
    ...common,
    text: 'Сегодня скидка на меню 20:00. Бронируйте столики.',
  });
  assert.equal(commercial.visionEligible, false);

  const carousel = explainSecondaryPartyTextGate({
    ...common,
    text: '1/10\nВечеринка STONEHAND в 20:00\nСледующий слайд',
  });
  assert.equal(carousel.visionEligible, false);
  assert.equal(carousel.rejectionReason, 'no-date-in-semantic-body');
});

test('joint vision accepts any confirmed image in a multi-image batch', () => {
  const facts = [
    '[IMAGE 1]\nСовокупность текста и картинки является анонсом: нет',
    '[IMAGE 2]\nСовокупность текста и картинки является анонсом: да',
  ].join('\n\n');
  assert.equal(secondaryJointVisionAccepted(facts), true);
  assert.equal(secondaryJointVisionAccepted('[IMAGE 1]\nСовокупность текста и картинки является анонсом: нет'), false);
});
