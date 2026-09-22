import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const snapshot = readFileSync(new URL('../../src/features/events/eventVerifiedSnapshot.js', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
const build = readFileSync(new URL('../../src/shared/buildVersion.js', import.meta.url), 'utf8');

test('V188.67 event images resolve from runtime data directory, not process cwd', () => {
    assert.match(app, /RUNTIME_DATA_DIRECTORY/u);
    assert.match(app, /const EVENT_IMAGE_ROOT = RUNTIME_DATA_DIRECTORY;/u);
    assert.doesNotMatch(app, /const EVENT_IMAGE_ROOT = resolve\('\.\/data'\);/u);
});

test('V188.67 verified snapshot is invalidated for the media-aware schema and lives with runtime data', () => {
    assert.match(snapshot, /EVENT_VERIFIED_SNAPSHOT_VERSION = 8/u);
    assert.match(snapshot, /join\(resolveRuntimeDataDirectory\(\), 'event-verified-snapshot\.json'\)/u);
});

test('release build rotates project runtime logs once per build boundary without blocking readiness', () => {
    assert.match(entry, /clearPreviouslyProcessedLogsV18855\(\{ root: PROJECT_ROOT, logger: console \}\)/u);
    assert.match(entry, /removeRotatedLogsDetachedV18868/u);
    assert.match(build, /events-v18879-secondary-reload-menu-r1/u);
});
