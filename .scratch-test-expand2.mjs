
import { extractEventDateRanges } from './src/features/events/publicPostDateEvidence.js';
const when = '18–30 декабря';
const range = extractEventDateRanges(when, 1792434000, { referenceNow: new Date('2026-10-19T12:00:00Z') })[0];
console.log('range exists:', Boolean(range));
const dates = [];
let current = new Date(range.startDate + 'T00:00:00Z');
const end = new Date(range.endDate + 'T00:00:00Z');
while (current <= end && dates.length < 12) {
  dates.push(current.toISOString().slice(0, 10));
  current = new Date(current.getTime() + 86400000);
}
console.log(dates.length, dates);

