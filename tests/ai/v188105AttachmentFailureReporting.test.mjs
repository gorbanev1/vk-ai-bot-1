import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const projectRoot = new URL('../../', import.meta.url);
const botSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

function extractFunction(source, name) {
    const start = source.indexOf(`async function ${name}`) >= 0
        ? source.indexOf(`async function ${name}`)
        : source.indexOf(`function ${name}`);
    assert.ok(start >= 0, `missing function ${name}`);
    const next = source.indexOf('\nfunction ', start + 20);
    const nextAsync = source.indexOf('\nasync function ', start + 20);
    const candidates = [next, nextAsync].filter((value) => value > start);
    const end = candidates.length ? Math.min(...candidates) : source.length;
    return source.slice(start, end);
}

test('V188.105 removes the old immediate attachment failure warning from chat', () => {
    assert.doesNotMatch(botSource, /Не удалось обработать[^\n]{0,120}вложени/iu);
    assert.doesNotMatch(botSource, /Ошибка записана в лог\. ID операции/iu);
    const fn = extractFunction(botSource, 'notifyIncomingMediaFailure');
    assert.doesNotMatch(fn, /replyContext\?\.send|context\.send/iu);
    assert.match(fn, /scheduleAttachmentFailureReport\(/u);
});

test('V188.105 starts durable delayed failure report recovery/tick', () => {
    assert.match(botSource, /attachment-failure-report:startup/u);
    assert.match(botSource, /attachment-failure-report:tick/u);
    assert.match(botSource, /runAttachmentFailureReportTick\(\)/u);
    assert.match(botSource, /60 \* 1000/u);
});

test('V188.105 durable reporter waits three hours, logs exact path and can be marked delivered', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'gigorave-v188105-'));
    const originalCwd = process.cwd();
    process.chdir(scratch);
    try {
        const moduleUrl = new URL('../../src/features/ai/attachmentFailureReporter.js', import.meta.url);
        moduleUrl.searchParams.set('case', String(Date.now()));
        const reporter = await import(moduleUrl.href);
        assert.equal(reporter.ATTACHMENT_FAILURE_REPORT_DELAY_MS, 3 * 60 * 60 * 1000);

        const now = 1_700_000_000_000;
        const scheduled = reporter.scheduleAttachmentFailureReport({
            requestId: 'req-1',
            operationId: 'op-1',
            platform: 'telegram',
            peerId: '100',
            messageId: '200',
            processed: 0,
            total: 1,
            failed: 1,
            failureSummary: 'download timeout',
        }, { nowMs: now });

        assert.equal(scheduled.dueAtMs, now + 3 * 60 * 60 * 1000);
        assert.equal(reporter.getDueAttachmentFailureReports({ nowMs: scheduled.dueAtMs - 1 }).length, 0);
        const due = reporter.getDueAttachmentFailureReports({ nowMs: scheduled.dueAtMs });
        assert.equal(due.length, 1);

        const log = reporter.writeAttachmentFailureReportLog(due[0], { nowMs: scheduled.dueAtMs });
        assert.match(log.relativePath, /^data\/logs\/attachment-failures\/\d{4}-\d{2}-\d{2}\.jsonl$/u);
        assert.ok(log.absolutePath.startsWith(scratch));
        const message = reporter.buildAttachmentFailureOwnerMessage(due[0], log);
        assert.match(message, /3 часа назад/u);
        assert.match(message, /Лог: data\/logs\/attachment-failures\//u);
        assert.match(message, /Полный путь к логу:/u);
        assert.match(message, /requestId: req-1/u);
        assert.match(message, /operationId: op-1/u);

        reporter.markAttachmentFailureReportDelivered(due[0].reportId);
        assert.equal(reporter.getDueAttachmentFailureReports({ nowMs: scheduled.dueAtMs + 60_000 }).length, 0);
    } finally {
        process.chdir(originalCwd);
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('V188.105 build version is bumped', () => {
    const version = readFileSync(new URL('../../src/shared/buildVersion.js', import.meta.url), 'utf8');
    assert.match(version, /V188\.10[5-9]|V188\.1[1-9]\d/u);
});
