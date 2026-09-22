import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Zip-патч не умеет удалять файлы. Этот одноразовый скрипт убирает старые
 * плоские test-файлы после перехода V40 -> V41. Рабочий код и данные он не
 * трогает; повторный запуск безопасен.
 */
const projectRoot = resolve(import.meta.dirname, '..');
const legacyTests = [
    'activeCommunicationRouting.test.mjs',
    'astrologyRouting.test.mjs',
    'banterRouting.test.mjs',
    'chatContextRouting.test.mjs',
    'communicationStyleDatabase.test.mjs',
    'communicationStyleRouting.test.mjs',
    'eventDeduplication.test.mjs',
    'eventMetadata.test.mjs',
    'eventValidation.test.mjs',
    'gptModeRouting.test.mjs',
    'memoryRouting.test.mjs',
    'natalRouting.test.mjs',
    'openAIImageStream.test.mjs',
    'openAIStream.test.mjs',
    'responseLengthRouting.test.mjs',
    'scraperCommandRouting.test.mjs',
    'telegramBot.test.mjs',
    'unknownTermRouting.test.mjs',
    'v39Database.test.mjs',
    'vkChatEventSource.test.mjs',
];

let removed = 0;

for (const name of legacyTests) {
    const file = resolve(projectRoot, 'tests', name);

    if (existsSync(file)) {
        unlinkSync(file);
        removed += 1;
    }
}

console.log(`V41 layout migration: removed legacy tests=${removed}`);
