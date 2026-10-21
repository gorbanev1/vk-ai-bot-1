
import { extractExplicitDateMentions } from './src/features/events/publicPostDateEvidence.js';
const text = '18–30 декабря | от 4000 ₽ | праздничная программа.';
console.log(JSON.stringify(extractExplicitDateMentions(text, 1792434000, { referenceNow: new Date('2026-10-19T12:00:00Z') }), null, 2));

