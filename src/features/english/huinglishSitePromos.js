import { createHash } from 'node:crypto';

// Exactly the five short messages approved for HuInglish; no profile link.
export const HUINGLISH_SITE_PROMOS = Object.freeze([
    '🌭 Разговорный английский — уроки: https://huinglish.tw1.ru/huinglish.php',
    '🎯 Тесты Хуинглиша: https://huinglish.tw1.ru/test.php?track=huinglish',
    '📚 Базовая английская грамматика: https://huinglish.tw1.ru/english.php',
    '🎬 Видеоуроки: https://huinglish.tw1.ru/videos.php',
    '🔤 Транскрипция и произношение: https://huinglish.tw1.ru/pronunciation.php',
]);

// Evenly pseudo-random by unique delivery ID, but stable on retry so VK's
// random_id deduplication never sees a different message for the same tag.
export function pickHuinglishSitePromo(deliveryId) {
    const value=createHash('sha256').update(String(deliveryId)).digest().readUInt32BE(0);
    return HUINGLISH_SITE_PROMOS[value%HUINGLISH_SITE_PROMOS.length];
}
