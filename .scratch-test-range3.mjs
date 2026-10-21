
import { extractEventDateRanges } from './src/features/events/publicPostDateEvidence.js';
const range = extractEventDateRanges('18–30 декабря | от 4000 ₽ | праздничная программа.', 1792434000, { referenceNow: new Date('2026-10-19T12:00:00Z') })[0];
console.log(JSON.stringify(range, null, 2));

