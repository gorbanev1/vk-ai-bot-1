
import { extractEventDateRanges } from './src/features/events/publicPostDateEvidence.js';
const text = 'Открываем бронирование на новогодние корпоративы. 18–30 декабря | от 4000 ₽ | праздничная программа.';
const ranges = extractEventDateRanges(text, 0, { referenceNow: new Date('2026-10-19T12:00:00Z') });
console.log(JSON.stringify(ranges, null, 2));
console.log('dates count:', ranges[0]?.dates?.length);

