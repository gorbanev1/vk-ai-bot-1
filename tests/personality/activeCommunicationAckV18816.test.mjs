import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);

test('V188.16 enable/disable command uses short acknowledgement, not full health dump', () => {
    assert.match(appSource, /function formatActiveCommunicationCommandAck\(settings\)/u);
    assert.match(appSource, /✅ Активное общение включено\. Интервал: \$\{interval\} сообщений\./u);
    assert.match(appSource, /✅ Активное общение отключено\./u);
    assert.match(appSource, /await rawContext\.send\(formatActiveCommunicationCommandAck\(saved\)\)/u);
});

test('V188.16 detailed status remains available only on explicit status branch', () => {
    assert.match(appSource, /if \(parsedCommand\.action === 'status'\) \{\s*await rawContext\.send\(formatActiveCommunicationStatus\(current\)\)/u);
    assert.match(appSource, /Последнее подходящее сообщение:/u);
    assert.match(appSource, /Настройки и счётчик активного общения живут в SQLite/u);
});
