
import { validatePublicAiEvents } from './src/features/events/publicPostLocalParser.js';
const post = {
  __dateFreeVisionPhase: true,
  text: 'КОПТИЛЬНЯ еда и музыка[Факты с афиши]\n[IMAGE 1]\nЭто афиша события: да\nДата: 18–30 декабря\nМесто: «Коптильня» (еда и музыка)\nРаспознанный текст: КОПТИЛЬНЯ. ЕДА И МУЗЫКА. Открываем бронирование на новогодние корпоративы. 18–30 декабря | от 4000 ₽ | праздничная программа.',
  publishedAt: 1792434000,
};
const events = Array.from({ length: 13 }, (_, i) => ({
  date: '2026-12-' + String(18 + i).padStart(2, '0'),
  title: '',
  venue: 'Коптильня (еда и музыка)',
  participants: '',
  price: 'от 4000 ₽',
  announcement: 'Открываем бронирование на новогодние корпоративы. 18–30 декабря. Праздничная программа.',
  source_segment: '18–30 декабря | от 4000 ₽ | праздничная программа.',
  evidence: '18–30 декабря; от 4000 ₽; праздничная программа',
  tags: ['party'],
  image_indexes: [1],
  _structure: 'multiple_events',
  _structureReason: 'несколько дат корпоративных мероприятий',
}));
for (let i = 0; i < events.length; i++) {
  const single = [events[i]];
  const result = validatePublicAiEvents(single, post);
  console.log(events[i].date, result.length, result.aiResponseValid, result.aiResponseError || '');
}

