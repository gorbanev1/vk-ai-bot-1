import assert from 'node:assert/strict';
import {
    buildEventNormalizationPayload,
    buildEventNormalizationSystemPrompt,
    mergeNormalizedEvent,
    stripEventServiceArtifacts,
} from '../../src/features/events/eventAnnouncementNormalization.js';

const dirty = `Когда: 08.08.26, 15:00\nЧто: Шабаш в Котле Куража\nКто: Меза, tsuefa!, noisebleedsuns\nГде: Котельная\nПочем: донат от 300р\nВстреча\nДень рождения не хочется отмечать в одиночестве.\nVIEW IN TELEGRAM\n#городкуража_август26\n🔥15❤5`;
const cleaned = stripEventServiceArtifacts(dirty);
assert.doesNotMatch(cleaned, /Когда:|Что:|Кто:|Где:|Почем:/u);
assert.doesNotMatch(cleaned, /VIEW IN TELEGRAM|городкуража|🔥15/u);
assert.match(cleaned, /День рождения/u);

const payload = buildEventNormalizationPayload([{
    title: 'Шабаш',
    eventDate: '2026-08-08',
    description: dirty,
    suppliedDateLabel: '8 августа 2026',
}]);
assert.equal(payload.length, 1);
assert.doesNotMatch(payload[0].announcement, /Встреча/u);
assert.match(payload[0].rawSource, /Когда: 08\.08\.26/u);
assert.doesNotMatch(payload[0].rawSource, /VIEW IN TELEGRAM|🔥15/u);

const merged = mergeNormalizedEvent({
    title: 'Old',
    eventTime: '15:00',
    venue: '',
    price: '5000р. (Скока-скока???)',
    description: dirty,
}, {
    title: 'Середина Леса',
    displayDate: '7–9 августа 2026',
    timeLabel: '',
    venue: 'В лесу',
    price: '5000 ₽',
    announcement: 'Трёхдневный фестиваль с тремя сценами.\n\nТакже будут лекции, мастер-классы и ярмарка.',
});
assert.equal(merged.displayDate, '7–9 августа 2026');
assert.equal(merged.timeLabel, '');
assert.equal(merged.price, '5000 ₽');
assert.equal(merged.venue, 'В лесу');
console.log('event announcement normalization tests: OK');

const overlockDirty = `Анонс:\nи\nещё 2 автора\nДействия\nГотовьтесь к TATTOOMO Pre Party!\nДата: 08.08.26.\nИсточник:\nVK — overlockbar`;
const overlockClean = stripEventServiceArtifacts(overlockDirty);
assert.equal(overlockClean.includes('ещё 2 автора'), false);
assert.equal(overlockClean.includes('Действия'), false);
assert.equal(overlockClean.includes('Дата:'), false);
assert.match(overlockClean, /TATTOOMO Pre Party/u);

const rangePayload = buildEventNormalizationPayload([{
    eventDate: '2026-08-09',
    eventTime: '07:08',
    description: `Когда: 07.08.26 - 09.08.26\nЧто: Середина Леса\nВстреча\nТри дня в лесу.\n#городкуража_август26\n🤮27😁4⚡2🔥2`,
    suppliedDateLabel: '9 августа 2026',
}])[0];
assert.match(rangePayload.rawSource, /Когда: 07\.08\.26 - 09\.08\.26/u);
assert.doesNotMatch(rangePayload.announcement, /Когда:/u);

const normalizationPrompt = buildEventNormalizationSystemPrompt();
assert.match(normalizationPrompt, /сертификата, приза, скидки/u);
assert.match(normalizationPrompt, /Не превращай фрагмент даты/u);
assert.match(normalizationPrompt, /явное имя мероприятия/u);


const giveawayClean = stripEventServiceArtifacts('STONEHAND даст большой концерт. Для этого нужно: вступить во встречу и нажать "Точно пойду". Итоги конкурса будут опубликованы 15 августа. В программе тяжёлый материал.');
assert.doesNotMatch(giveawayClean, /Точно пойду|Итоги конкурса|вступить во встречу/iu);
assert.match(giveawayClean, /STONEHAND даст большой концерт/u);
assert.match(giveawayClean, /тяжёлый материал/u);

const falseTime = mergeNormalizedEvent({
    title: 'STONEHAND',
    eventTime: '09:26',
    description: 'STONEHAND — 26.09.2026. DIESEL HALL.',
}, {
    timeLabel: '09:26',
    announcement: 'Большой концерт.',
});
assert.equal(falseTime.timeLabel, '');

const realTime = mergeNormalizedEvent({
    title: 'GHOST GIG',
    eventTime: '19:30',
    description: '14 августа 2026, начало 19:30. Rock Bar DIESEL.',
}, {
    timeLabel: '19:30',
    announcement: 'Концертный вечер.',
});
assert.equal(realTime.timeLabel, '19:30');
