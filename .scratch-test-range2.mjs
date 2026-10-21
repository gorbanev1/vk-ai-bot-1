
import { extractEventDateRanges, extractExplicitDates } from './src/features/events/publicPostDateEvidence.js';
const text = '18–30 декабря | от 4000 ₽ | праздничная программа.';
const publishedAt = 1792434000;
const referenceNow = new Date('2026-10-19T12:00:00Z');
console.log('dates:', extractExplicitDates(text, publishedAt, { referenceNow }));
console.log('ranges:', JSON.stringify(extractEventDateRanges(text, publishedAt, { referenceNow }), null, 2));

