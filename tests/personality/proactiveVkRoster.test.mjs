import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProactiveVkMessage, listDueProactiveVkParticipants } from '../../src/features/personality/proactiveVkRoster.js';
const base = { proactiveEnabled: true, schedulePolicy: { timeZone: 'Europe/Moscow', quietHours: { from: '23:00', to: '09:00' } }, participants: [] };
test('proactive once schedule mentions a participant and is due only after its timestamp', () => {
  const config = { ...base, participants: [{ userId: 42, name: 'Тест Пользователь', proactive: { enabled: true, phrases: ['{mention}, привет'], schedule: { mode: 'once', at: '2026-10-14T12:00:00+03:00' } } }] };
  assert.equal(listDueProactiveVkParticipants(config, Date.parse('2026-10-14T11:59:00+03:00')).length, 0);
  assert.equal(listDueProactiveVkParticipants(config, Date.parse('2026-10-14T12:01:00+03:00')).length, 1);
  assert.equal(buildProactiveVkMessage(config.participants[0], () => 0), '[id42|Тест Пользователь], привет');
});
test('weekly and monthly schedules are blocked during quiet hours', () => {
  const config = { ...base, participants: [
    { userId: 1, proactive: { enabled: true, phrases: ['x'], schedule: { mode: 'weekly', dayOfWeek: 3, time: '12:00' } } },
    { userId: 2, proactive: { enabled: true, phrases: ['x'], schedule: { mode: 'monthly', dayOfMonth: 14, time: '12:00' } } },
  ] };
  assert.equal(listDueProactiveVkParticipants(config, Date.parse('2026-10-14T08:59:00+03:00')).length, 0);
  assert.equal(listDueProactiveVkParticipants(config, Date.parse('2026-10-14T12:01:00+03:00')).length, 2);
});
