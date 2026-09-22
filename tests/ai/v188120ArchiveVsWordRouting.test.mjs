import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isProjectArchiveAuditCommand, isProjectArchiveAuditIntent } from '../../src/features/audit/projectArchiveIntent.js';
import { parseDocumentArtifactRequest } from '../../src/features/documents/documentRouting.js';
import { resolveTelegramMenuInput, TELEGRAM_MENU_BUTTONS } from '../../src/platforms/telegram/telegramBot.js';

const archiveRequest = 'Астра max, аудит проекта VK-событий. Прочитай прикреплённый ZIP и файл 00_ASTRA_TASK_RU.md внутри него. Проведи глубокий аудит. Верни один итоговый ZIP с отчётом, патчами и тестами.';

test('Astra ZIP audit has priority over Word even when it says верни/отчёт/файл', () => {
    assert.equal(isProjectArchiveAuditCommand(archiveRequest), true);
    assert.equal(isProjectArchiveAuditIntent(archiveRequest), true);
    assert.equal(parseDocumentArtifactRequest(archiveRequest).matched, false);
    assert.equal(parseDocumentArtifactRequest(archiveRequest, {forceFormat: 'word'}).matched, false);
});

test('A request to return a ZIP/report/file, without explicit Word, is not DOCX', () => {
    for (const request of [
        'Верни ZIP с отчётом и файлами исходников.',
        'Подготовь итоговый отчёт и список исправлений в архиве.',
        'Напиши отчёт по проекту и верни исходники файлом.',
        'Проведи аудит и собери итоговый ZIP с патчами.',
        'Проверь архив, верни ZIP с отчётом. Word и DOCX не создавай.',
    ]) {
        assert.equal(parseDocumentArtifactRequest(request).matched, false, request);
    }
});

test('Astra archive wording mentioning Word as something NOT to create never starts Word', () => {
    const request = `${archiveRequest} Никаких Word и DOCX не создавай.`;
    assert.equal(parseDocumentArtifactRequest(request).matched, false);
});

test('Explicit ordinary Word/PDF/slide creation remains available', () => {
    assert.deepEqual(parseDocumentArtifactRequest('Создай Word документ про музыку'), {
        matched: true, format: 'docx', prompt: 'Создай Word документ про музыку',
    });
    assert.equal(parseDocumentArtifactRequest('Сделай PDF документ про мероприятие').format, 'pdf');
    assert.equal(parseDocumentArtifactRequest('Сделай презентацию pptx о музыке').format, 'pptx');
    assert.equal(parseDocumentArtifactRequest('Заметки Word по теме').matched, false);
    assert.equal(parseDocumentArtifactRequest('Обзор книги', {forceFormat:'docx'}).matched, true);
});

test('An archive audit with a TXT attached escapes a stale Word menu without inserting a DOCX command', () => {
    const menuResult = resolveTelegramMenuInput(archiveRequest, {
        pendingAction: 'document_docx', pendingModel: 'astra', menuPath: 'documents',
    }, {isOwner: true, hasDocumentAttachment: true});
    assert.equal(menuResult.type, 'command');
    assert.equal(menuResult.text, archiveRequest);
    assert.equal(menuResult.state.pendingAction, '');
    assert.equal(menuResult.state.pendingModel, '');
    assert.ok(!/создай word docx документ файлом/iu.test(menuResult.text));
});

test('An ordinary document attachment also does not inherit an old Word menu action', () => {
    const menuResult = resolveTelegramMenuInput('Проверь вложенный текст', {
        pendingAction: 'document_docx', menuPath: 'documents',
    }, {hasDocumentAttachment: true});
    assert.equal(menuResult.type, 'command');
    assert.equal(menuResult.text, 'Проверь вложенный текст');
    assert.equal(menuResult.state.pendingAction, '');
});

test('File-only message escapes pending Word menu and reaches normal file intake', () => {
    const menuResult = resolveTelegramMenuInput('', {
        pendingAction: 'document_docx', menuPath: 'documents',
    }, {hasDocumentAttachment: true});
    assert.equal(menuResult.type, 'command');
    assert.equal(menuResult.text, '');
    assert.equal(menuResult.state.pendingAction, '');
});

test('Deliberate menu-based Word creation without attachment is preserved', () => {
    const selection = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.documentWord);
    assert.equal(selection.state.pendingAction, 'document_docx');
    const request = resolveTelegramMenuInput('Лекция о музыке', selection.state);
    assert.equal(request.type, 'command');
    assert.match(request.text, /создай word docx документ файлом/u);
    assert.equal(parseDocumentArtifactRequest(request.text).format, 'docx');
});

test('Telegram routes attached ZIP audit separately but lets text-only Astra requests reach GPT', () => {
    const menuCode = readFileSync(new URL('../../src/platforms/telegram/telegramBot.js', import.meta.url), 'utf8');
    const appCode = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    assert.match(menuCode, /hasDocumentAttachment: Boolean\(message\.document\?\.file_id\)/u);
    const handler = appCode.slice(appCode.indexOf('async function maybeHandleProjectArchiveAuditIncoming('), appCode.indexOf('const useTextMultipass = shouldUseProjectArchiveTextMultipass();', appCode.indexOf('async function maybeHandleProjectArchiveAuditIncoming(')));
    assert.match(handler, /if \(!descriptor\) return false;/u);
    assert.doesNotMatch(handler, /project-audit-zip-required/u);
    assert.match(appCode, /if \(await maybeHandleProjectArchiveAuditIncoming\(\s*context,\s*originalText \|\| text,/u);
});

test('Runtime intake: Astra audit caption + TXT attachment does not demand ZIP or hijack TXT intake', async () => {
    const { runInNewContext } = await import('node:vm');
    const appCode = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const start = appCode.indexOf('async function maybeHandleProjectArchiveAuditIncoming(');
    const end = appCode.indexOf('\n}\n', start) + 2;
    assert.ok(start > 0 && end > start);
    const notices = [];
    const durable = [];
    const descriptors = [{filename: 'GIGORAVE_VK_EVENTS_ALL_IN_ONE_SOURCE_RU.txt', mimeType: 'text/plain', fileSize: 1_800_000}];
    const sandbox = {
        isOwnerContext: () => true,
        isPrivateContext: () => true,
        isProjectArchiveAuditCommand,
        isProjectArchiveAuditIntent,
        collectTelegramModelFileDescriptors: () => descriptors,
        getRawContext: () => ({}),
        safeProjectAuditNotice: async (_context, message) => { notices.push(message); },
        console: { log: () => {} },
    };
    const handler = runInNewContext(`${appCode.slice(start, end)}\nmaybeHandleProjectArchiveAuditIncoming`, sandbox);
    const handled = await handler({markDurableIntake: (item) => durable.push(item)}, archiveRequest);
    assert.equal(handled, false);
    assert.equal(notices.length, 0);
    assert.equal(durable.length, 0);
});
