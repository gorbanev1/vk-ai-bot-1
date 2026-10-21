
import { parsePublicPostLocally } from './src/features/events/publicPostLocalParser.js';
const post = {
  text: 'КОПТИЛЬНЯ еда и музыка[Факты с афиши]\n[IMAGE 1]\nЭто афиша события: да\nДата: 18–30 декабря\nМесто: «Коптильня» (еда и музыка)\nНазвание: Коптильня: новогодние корпоративы\nРаспознанный текст: КОПТИЛЬНЯ. ЕДА И МУЗЫКА. Открываем бронирование на новогодние корпоративы. 18–30 декабря | от 4000 ₽ | праздничная программа.',
  publishedAt: 1792434000,
  referenceNow: new Date('2026-10-19T12:00:00Z'),
};
const events = parsePublicPostLocally(post);
console.log('local parsed count:', events.length);
for (const ev of events) console.log(ev.eventDate, ev.title, ev.parseMethod);

