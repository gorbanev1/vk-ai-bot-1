
import { extractExplicitDates } from './src/features/events/publicPostDateEvidence.js';
const text = 'КОПТИЛЬНЯ еда и музыка[Факты с афиши]\n[IMAGE 1]\nЭто афиша события: да\nДата: 18–30 декабря\nМесто: «Коптильня» (еда и музыка)\nРаспознанный текст: КОПТИЛЬНЯ. ЕДА И МУЗЫКА. Открываем бронирование на новогодние корпоративы. 18–30 декабря | от 4000 ₽ | праздничная программа.';
console.log(extractExplicitDates(text, 0, { referenceNow: new Date('2026-10-19T12:00:00Z') }));

