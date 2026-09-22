import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isProjectArchiveAuditCommand } from '../../src/features/audit/projectArchiveIntent.js';
import { extractExplicitGptMode } from '../../src/features/ai/gptModeRouting.js';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const start = app.indexOf('async function maybeHandleProjectArchiveAuditIncoming(');
const end = app.indexOf('\n}\n', start) + 2;
const projectHandlerCode = app.slice(start, end);

async function runIntake({ text, files = [] }) {
  let touched = 0;
  const handler = runInNewContext(`${projectHandlerCode}\nmaybeHandleProjectArchiveAuditIncoming`, {
    isOwnerContext: () => true,
    isPrivateContext: () => true,
    isProjectArchiveAuditCommand,
    collectTelegramModelFileDescriptors: () => files,
    getRawContext: () => ({}),
    safeProjectAuditNotice: () => { touched++; },
    console: { log: () => {} },
  });
  const handled = await handler({ markDurableIntake: () => { touched++; } }, text);
  return { handled, touched };
}

test('plain Astra project/audit question with no ZIP is not blocked by archive intake', async () => {
  for (const text of [
    'Астра max проверь код этого обработчика',
    'Astra, объясни, как сделать heartbeat на роутере',
    'астра аудит проекта — расскажи, какие модули стоит протестировать',
  ]) {
    const result = await runIntake({ text });
    assert.equal(result.handled, false, text);
    assert.equal(result.touched, 0, text);
  }
  assert.equal(extractExplicitGptMode('астра max проверь код').mode, 'astra');
});

test('Astra with a TXT never receives a ZIP-required notice in the archive handler', async () => {
  const result = await runIntake({
    text: 'астра max аудит проекта — проверь приложенный текст',
    files: [{ filename: 'code.txt', mimeType: 'text/plain', fileSize: 1234 }],
  });
  assert.deepEqual(result, { handled: false, touched: 0 });
});

test('real ZIP archive + explicit Astra project audit retains dedicated protected ZIP route', () => {
  assert.equal(isProjectArchiveAuditCommand('астра max аудит проекта'), true);
  assert.equal(isProjectArchiveAuditCommand('Astra проанализируй ZIP'), true);
  assert.equal(isProjectArchiveAuditCommand('Астра, проанализируй ZIP'), true);
  assert.match(projectHandlerCode, /if \(!isOwnerContext\(context\) \|\| !isPrivateContext\(context\)\) return false;/u);
  assert.match(projectHandlerCode, /const descriptor = zipDescriptors\[0\] \|\| null;/u);
  assert.match(projectHandlerCode, /if \(!descriptor\) return false;/u);
  assert.match(projectHandlerCode, /const useTextMultipass = shouldUseProjectArchiveTextMultipass\(\);/u);
});

test('Telegram text reply exposes successful selected model including the default mini', () => {
  const start = app.indexOf('function visibleTextModelHeader(');
  const end = app.indexOf('\n}\n', start) + 2;
  const fn = start >= 0 && end > start ? app.slice(start, end) : '';
  assert.ok(fn);
  const visibleHeader = runInNewContext(`${fn}\nvisibleTextModelHeader`, {
    isDefaultMiniModel: (model) => String(model) === 'gpt-5.4-mini',
  });
  assert.equal(visibleHeader('gpt-5.4-mini'), '');
  assert.equal(visibleHeader('gpt-5.4-mini', { showDefault: true }), '🤖 Модель: gpt-5.4-mini');
  assert.equal(visibleHeader('gpt-6-astra', { showDefault: true }), '🤖 Модель: gpt-6-astra');
  assert.match(app, /showDefault: captureResponseArtifacts/u);
  assert.match(app, /showDefault: String\(rawContext\?\.platform \?\? ''\)\.toLowerCase\(\) === 'telegram'/u);
  assert.match(app, /onModelSelected: rememberEffectiveModel/u);
  assert.match(app, /projectAuditActualModels\.get\(jobId\)\.add\(selectedModel\)/u);
  assert.match(app, /if \(selected\) observedTextModels\.add\(selected\)/u);
  assert.match(app, /Модели выполненных запросов:/u);
});
