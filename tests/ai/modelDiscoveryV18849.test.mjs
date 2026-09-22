import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'gigorave-v18849-'));
process.env.GIGORAVE_STATE_DIR = join(root, 'state');

const scheduler = await import(`../../src/features/ai/modelDiscoveryScheduler.js?v18849=${Date.now()}`);
const db = await import(`../../src/infrastructure/database/index.js?v18849=${Date.now()}`);
const audit = await import(`../../src/features/ai/fullAiAudit.js?v18849=${Date.now()}`);
const astrology = await import(`../../src/features/astrology/astrologyRouting.js?v18849=${Date.now()}`);

try {
    test('V188.49: first 14 days are daily at/after 03:00 Moscow and durable per local date', () => {
        const now = new Date('2026-09-12T00:05:00.000Z'); // 03:05 Moscow
        const startedAt = new Date('2026-09-10T00:00:00.000Z').getTime();
        const due = scheduler.resolveAiModelDiscoverySchedule({ now, state: { startedAt, lastDailyDate: '2026-09-11' } });
        assert.equal(due.phase, 'daily');
        assert.equal(due.due, true);
        const repeated = scheduler.resolveAiModelDiscoverySchedule({ now, state: { startedAt, lastDailyDate: '2026-09-12' } });
        assert.equal(repeated.due, false);
        const tooEarly = scheduler.resolveAiModelDiscoverySchedule({ now: new Date('2026-09-11T23:30:00.000Z'), state: { startedAt } }); // 02:30 Moscow
        assert.equal(tooEarly.due, false);
    });

    test('V188.49: after 14 days schedule is Monday 03:00 Moscow weekly', () => {
        const startedAt = new Date('2026-08-20T00:00:00.000Z').getTime();
        const monday = new Date('2026-09-14T00:05:00.000Z');
        const due = scheduler.resolveAiModelDiscoverySchedule({ now: monday, state: { startedAt, lastWeeklyKey: '' } });
        assert.equal(due.phase, 'weekly');
        assert.equal(due.due, true);
        const repeated = scheduler.resolveAiModelDiscoverySchedule({ now: monday, state: { startedAt, lastWeeklyKey: due.slotKey } });
        assert.equal(repeated.due, false);
        const tuesday = scheduler.resolveAiModelDiscoverySchedule({ now: new Date('2026-09-15T00:05:00.000Z'), state: { startedAt } });
        assert.equal(tuesday.due, false);
    });

    test('V188.49: model discovery registry is durable and only qualified+promoted rows join ladders', () => {
        const model = `gpt-6-hypothetical-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const first = db.recordAiModelDiscoveries([{ provider: 'openai-compatible', envName: 'OPENAI_COMPAT_API_KEY', masked: 'sk…', model, capabilities: ['text', 'vision'] }], 100);
        assert.equal(first.length, 1);
        const again = db.recordAiModelDiscoveries([{ provider: 'openai-compatible', envName: 'OPENAI_COMPAT_API_KEY', masked: 'sk…', model, capabilities: ['text', 'vision'] }], 200);
        assert.equal(again.length, 0);
        assert.equal(db.getAiModelDiscoveryRows({ provider: 'openai-compatible', envName: 'OPENAI_COMPAT_API_KEY', model })[0]?.qualificationStatus, 'pending');
        db.saveAiModelQualification({ provider: 'openai-compatible', envName: 'OPENAI_COMPAT_API_KEY', model, status: 'qualified', promoted: true, details: { ok: true }, qualifiedAt: 300 });
        const qualified = db.getQualifiedDiscoveredAiModels('text').filter((row) => row.model === model);
        assert.equal(qualified.length, 1);
        assert.equal(db.getQualifiedDiscoveredAiModels('vision').filter((row) => row.model === model).length, 1);
    });

    test('V188.49: unknown next-generation GPT families probe every known intelligence effort', () => {
        assert.deepEqual(
            audit.__FULL_AI_AUDIT_TESTING__.reasoningLevelsForModel('openai-compatible', 'gpt-6-hypothetical'),
            ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        );
    });

    test('V188.49: natal/prashna always require local calculation even in pro3/nonlocal wording', () => {
        for (const kind of ['natal', 'prashna']) {
            const row = astrology.resolveAstrologyExecution({ kind, mode: 'pro3', nonLocalRequested: true });
            assert.equal(row.localCalculation, true);
            assert.equal(row.modelCalculation, false);
            assert.equal(row.packet, 'maximum');
            assert.match(row.reason, /mandatory-local-swiss/u);
        }
    });

    test('V188.49: app appends only qualified discovery models after the static ladder and schedules supervised discovery', () => {
        const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
        assert.match(source, /getQualifiedDiscoveredAiModels\(requiredCapability\)/u);
        assert.match(source, /mode:\s*'discovered'/u);
        assert.match(source, /logicalModes\.includes\('pro3'\)/u);
        assert.match(source, /ai-model-discovery:startup/u);
        assert.match(source, /AI_MODEL_DISCOVERY_TICK_MS/u);
        assert.match(source, /ЖЁСТКИЙ ИНВАРИАНТ ДЖЙОТИШ/u);
        assert.doesNotMatch(source, /Локальный Swiss Ephemeris не запускался/u);
        assert.doesNotMatch(source, /Самостоятельно выполни максимально полный расчёт натальной карты/u);
    });
} finally {
    process.on('exit', () => rmSync(root, { recursive: true, force: true }));
}
