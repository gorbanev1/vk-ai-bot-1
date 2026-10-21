
import { extractExplicitDates } from './src/features/events/publicPostDateEvidence.js';
const when = '18–30 декабря';
console.log(extractExplicitDates(when, 1792434000, { referenceNow: new Date('2026-10-19T12:00:00Z') }));

