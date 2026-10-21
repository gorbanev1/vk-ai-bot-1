
import { validatePublicAiEvents } from './src/features/events/publicPostLocalParser.js';
const post = {
  __dateFreeVisionPhase: true,
  text: 'КОПТИЛЬНЯ еда и музыка[Факты с афиши]\n[IMAGE 1]\nЭто афиша события: да\nДата: 18–30 декабря\nМесто: «Коптильня» (еда и музыка)\nНазвание: Коптильня: новогодние корпоративы\nРаспознанный текст: КОПТИЛЬНЯ. ЕДА И МУЗЫКА. Открываем бронирование на новогодние корпоративы. 18–30 декабря | от 4000 ₽ | праздничная программа.',
  publishedAt: 1792434000,
};
const baseEvent = {
  date: '2026-12-18',
  title: 'Коптильня: новогодние корпоративы',
  participants: '',
  venue: 'Коптильня (еда и музыка)',
  price: 'от 4000 ₽',
  announcement: 'Открываем бронирование на новогодние корпоративы. 18–30 декабря. Праздничная программа.',
  source_segment: '18–30 декабря | от 4000 ₽ | праздничная программа.',
  evidence: '18–30 декабря; от 4000 ₽; праздничная программа',
  tags: ['party'],
  image_indexes: [1],
  _structure: 'multiple_events',
  _structureReason: 'несколько дат корпоративных мероприятий',
};
for (let n = 2; n <= 13; n++) {
  const events = Array.from({ length: n }, (_, i) => ({ ...baseEvent, date: '2026-12-' + String(17 + i).padStart(2, '0') }));
  const result = validatePublicAiEvents(events, post);
  console.log(n, result.length, result.aiResponseValid, result.aiResponseError || '');
}

