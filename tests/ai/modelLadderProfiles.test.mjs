import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { addAstraToVisionProfiles, DEFAULT_MODEL_LADDER_PROFILES, parseModelLadderCommand, validateModelLadderProfiles } from '../../src/features/ai/modelLadderProfiles.js';

test('Astra migration appends two attempts without changing text or earlier vision steps', () => {
    const original = structuredClone(DEFAULT_MODEL_LADDER_PROFILES);
    original['parser-all-vision'] = [{ model: 'gpt-5.6-terra', attempts: 1, timeoutMs: 87000, detail: 'high' }];
    original['parser-all-new-vision'] = [{ model: 'gpt-6-astra', attempts: 5, timeoutMs: 160000 }, { model: 'gpt-5.6-luna', attempts: 1 }];
    const before = structuredClone(original);
    const migrated = addAstraToVisionProfiles(original);
    assert.deepEqual(original, before);
    assert.deepEqual(migrated['parser-all-text'], original['parser-all-text']);
    assert.deepEqual(migrated['parser-all-vision'][0], original['parser-all-vision'][0]);
    for (const key of ['chat-vision', 'parser-all-vision', 'parser-all-new-vision']) {
        assert.equal(migrated[key].at(-1).model, 'gpt-6-astra');
        assert.equal(migrated[key].at(-1).attempts, 2);
        assert.equal(migrated[key].filter((step) => step.model === 'gpt-6-astra').length, 1);
    }
    assert.equal(migrated['parser-all-new-vision'].at(-1).timeoutMs, 160000);
    assert.deepEqual(addAstraToVisionProfiles(migrated), migrated);
});

test('model ladder show and edit parse aliases with optional controls', () => {
    assert.equal(parseModelLadderCommand('лестница моделей').action, 'show');
    const parsed = parseModelLadderCommand('лестница изменить\nчат:\n6 луна 1 stream\n6.1 сол 2 timeout=240s\nбеседы:\n6 астра 2 nostream');
    assert.equal(parsed.action, 'save');
    assert.equal(parsed.profiles.chat[0].model, 'gpt-6-luna');
    assert.equal(parsed.profiles.chat[0].stream, true);
    assert.equal(parsed.profiles.chat[1].timeoutMs, 240000);
    assert.equal(parsed.profiles.conversation[0].model, 'gpt-6-astra');
    assert.equal(parsed.profiles.conversation[0].stream, false);
});

test('missing profiles retain independent defaults', () => {
    const profiles = validateModelLadderProfiles({ chat: [{ model: 'gpt-6-luna', attempts: 2 }] });
    assert.equal(profiles.chat[0].attempts, 2);
    assert.notEqual(profiles.conversation, profiles.chat);
    assert.deepEqual(profiles['parser-all-vision'], DEFAULT_MODEL_LADDER_PROFILES['parser-all-vision']);
});

test('healthy GPT-6 Luna becomes first in all profiles with one low-reasoning attempt', () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const start = app.indexOf('function migrateModelLadderProfilesForGpt6Luna(');
    const end = app.indexOf('function readModelLadderProfiles()', start);
    assert.ok(start >= 0 && end > start);
    const source = app.slice(start, end) + '\nmigrateModelLadderProfilesForGpt6Luna';
    const context = {
        validateModelLadderProfiles, DEFAULT_MODEL_LADDER_PROFILES,
        GPT56_LUNA_MODEL_ID: 'gpt-5.6-luna', GPT6_LUNA_MODEL_ID: 'gpt-6-luna',
        LUNA_HEALTH_SAMPLE_VERSION: 2,
    };
    const migrate = vm.runInNewContext(source, {
        ...context, getMaintenanceState: () => ({ details: { version: 2, promoted: true } }),
    });
    const original = { ...DEFAULT_MODEL_LADDER_PROFILES, 'parser-all-text': [
        { model: 'gpt-5.6-terra', attempts: 1, timeoutMs: 150000, reasoningEffort: 'none', stream: true },
        { model: 'gpt-5.6-luna', attempts: 1, reasoningEffort: 'none' },
        { model: 'gpt-6-luna', attempts: 1, reasoningEffort: 'none' },
        { model: 'gpt-6.1-sol', attempts: 3, reasoningEffort: 'low' },
    ] };
    const before = structuredClone(original);
    const first = migrate(original);
    assert.deepEqual(original, before);
    assert.equal(first.changed, true);
    for (const steps of Object.values(first.profiles)) {
        assert.equal(steps[0].model, 'gpt-6-luna');
        assert.equal(steps[0].attempts, 1);
        assert.equal(steps[0].reasoningEffort, 'low');
        assert.equal(steps[1].model, 'gpt-5.6-luna');
        assert.equal(steps.filter((s) => s.model === 'gpt-6-luna').length, 1);
    }
    assert.equal(first.profiles['parser-all-text'][2].model, 'gpt-5.6-terra');
    assert.equal(first.profiles['parser-all-text'][2].timeoutMs, 150000);
    assert.equal(first.profiles['parser-all-text'][2].stream, true);
    assert.equal(migrate(first.profiles).changed, false);
    assert.equal(JSON.stringify(migrate(first.profiles).profiles), JSON.stringify(first.profiles));

    // GPT-6 Luna stays first even before health promotion; health telemetry
    // must not reorder the production ladders.
    const unpromoted = vm.runInNewContext(source, {
        ...context, getMaintenanceState: () => null,
    });
    for (const steps of Object.values(unpromoted(original).profiles)) {
        assert.equal(steps[0].model, 'gpt-6-luna');
        assert.equal(steps[0].attempts, 1);
        assert.equal(steps[1].model, 'gpt-5.6-luna');
    }
});
