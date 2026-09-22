import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePublicPostLocally } from '../../src/features/events/publicPostLocalParser.js';

const postText = [
    'Лето закончилось и наступает время для анонса Shoegaze Fall Night 2!',
    'В этом году играют:',
    'Dog Silent, goodnight kisses, Муссон и объект под видеонаблюдением.',
    'Где: КОТЕЛЬНАЯ',
    'Когда: 3 октября',
    'Сколько: 600 с репостом / 800 с респектом',
].join('\n');
const imageFacts = '[IMAGE 1]\nНазвание: Shoegaze Fall Night 2\nДата: 03.10\nВремя: 18:00\nМесто: КОТЕЛЬНАЯ';

const [event] = parsePublicPostLocally({
    text: `${postText}\n\n${imageFacts}`,
    publishedAt: 1788448080,
    sourceUrl: 'https://vk.ru/wall-231705804_24',
});

assert.ok(event, 'event must be parsed');
assert.equal(event.eventDate, '2026-10-03');
assert.equal(event.eventTime, '18:00');
assert.match(event.venue, /КОТЕЛЬНАЯ/iu);

const browserSource = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');
assert.match(browserSource, /apiPrefetchCache/u);
assert.match(browserSource, /exact-bootstrap-vk-api-prefetch/u);
assert.match(browserSource, /vk-page-prefetch-wall-date-v1886/u);
assert.match(browserSource, /MANUAL EVENT VK EXACT BOOTSTRAP RECOVERY/u);

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
assert.match(appSource, /mergeManualExactVkPostSources/u);
assert.match(appSource, /MANUAL EVENT TEMPORAL FUSION/u);
assert.match(appSource, /Если на афише напечатаны числовая дата или время/u);

console.log('event proposal VK bootstrap temporal fusion V1886 tests: ok');
