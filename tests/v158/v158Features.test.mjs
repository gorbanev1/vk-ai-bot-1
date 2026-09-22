import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAutoSummaryCommand } from '../../src/features/ai/autoSummaryRouting.js';
import { parseDocumentArtifactRequest } from '../../src/features/documents/documentRouting.js';
import { createDocumentArtifact } from '../../src/features/documents/documentArtifacts.js';
import { resolveTelegramMenuInput, TELEGRAM_MENU_BUTTONS } from '../../src/platforms/telegram/telegramBot.js';
import { createAutoSummaryStateStore } from '../../src/infrastructure/database/autoSummaryStateStore.js';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const assetsSource = readFileSync(new URL('../../src/features/events/eventAssets.js', import.meta.url), 'utf8');
const vkSource = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const tgSource = readFileSync(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8');
const browserSource = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');

test('custom auto-summary accepts numbers, words and stable VK conversation identifiers', () => {
  assert.deepEqual(parseAutoSummaryCommand('авторезюме 18 17 20').schedule, ['17:00','18:00','20:00']);
  assert.deepEqual(parseAutoSummaryCommand('авторезюме 18:00, 20:30').schedule, ['18:00','20:30']);
  assert.deepEqual(parseAutoSummaryCommand('авторезюме двенадцать пятнадцать восемнадцать').schedule, ['12:00','15:00','18:00']);
  const remote = parseAutoSummaryCommand('авторезюме беседа 22 12 15 18');
  assert.equal(remote.target.externalPeerId, '2000000022');
  assert.deepEqual(remote.schedule, ['12:00','15:00','18:00']);
  const stableUrl = parseAutoSummaryCommand('авторезюме https://vk.ru/im?sel=c22 12 15 18');
  assert.equal(stableUrl.target.externalPeerId, '2000000022');
  const legacyPersonal = parseAutoSummaryCommand('авторезюме https://vk.ru/im/convo/2000000022 12 15 18');
  assert.equal(legacyPersonal.target, undefined);
  assert.equal(parseAutoSummaryCommand('авторезюме статус все').all, true);
});


test('custom auto-summary schedule persists in durable SQLite and is visible in all-settings list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gigorave-v158-autosummary-'));
  try {
    const store = createAutoSummaryStateStore({ directory: dir });
    store.saveSettings({ peerId: 2000000022, platform:'vk', externalPeerId:'2000000022', mode:'full', schedule:['12:00','15:00','18:00'], enabled:true, nextRunAt:1800000000, updatedAt:1700000000 });
    assert.deepEqual(store.getSettings(2000000022).schedule, ['12:00','15:00','18:00']);
    assert.equal(store.getAllSettings().length, 1);
    store.close();
  } finally {
    rmSync(dir, {recursive:true, force:true});
  }
});

test('document semantic router recognizes Word/PDF/PPTX', () => {
  assert.equal(parseDocumentArtifactRequest('сделай мне презентацию про Воронеж').format, 'pptx');
  assert.equal(parseDocumentArtifactRequest('подготовь реферат и верни pdf файлом').format, 'pdf');
  assert.equal(parseDocumentArtifactRequest('создай word документ с докладом').format, 'docx');
});

test('DOCX and PPTX are emitted as actual ZIP Office files', async () => {
  const docx = await createDocumentArtifact({ format:'docx', model:{ title:'Тест', sections:[{heading:'Раздел',paragraphs:['Текст']}]} });
  const pptx = await createDocumentArtifact({ format:'pptx', model:{ title:'Тест', slides:[{title:'Слайд',bullets:['Пункт']}]} });
  assert.equal(docx.buffer.subarray(0,2).toString(), 'PK');
  assert.equal(pptx.buffer.subarray(0,2).toString(), 'PK');
  assert.match(docx.filename, /\.docx$/u);
  assert.match(pptx.filename, /\.pptx$/u);
});

test('Telegram menus expose image edit/documents and no submenu dead-end', () => {
  let r = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.imageEdit, {}, {isOwner:true});
  assert.equal(r.state.pendingAction, 'image_edit');
  assert.ok(r.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.back));
  assert.ok(r.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.home));
  r = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.documents, {}, {isOwner:true});
  assert.ok(r.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.documentWord));
  assert.ok(r.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.back));
  assert.ok(r.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.home));
});

test('V158 source contract: all-images event mapping, global close stop, nonblocking Telegram', () => {
  assert.match(assetsSource, /MAX_SOURCE_IMAGES = 12/u);
  assert.match(assetsSource, /assignEventImageIndexesFromFacts/u);
  assert.match(vkSource, /MAX_IMAGES_PER_POST = 12/u);
  assert.match(tgSource, /MAX_IMAGES_PER_POST = 12/u);
  assert.match(appSource, /\[IMAGE N\]/u);
  assert.match(appSource, /image_indexes/u);
  assert.match(browserSource, /getScraperBrowserCloseGeneration/u);
  assert.match(appSource, /ownerClosedAllWindows/u);
  const telegramSource = readFileSync(new URL('../../src/platforms/telegram/telegramBot.js', import.meta.url), 'utf8');
  assert.match(telegramSource, /void Promise\.resolve\(onMessage\(context\)\)/u);
});
