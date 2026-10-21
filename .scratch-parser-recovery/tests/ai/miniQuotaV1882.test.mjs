import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);

test('V188.2 default mini text requests do not consume model daily quota', () => {
    assert.match(source, /const modelQuotaEnabled = imageAction \|\| effectiveMode !== 'default';/u);
    assert.match(source, /if \(!unlimited && modelQuotaEnabled\) \{\s*quota = consumeGptModelDailyRateLimit/u);
});

test('V188.2 default mini vision requests do not consume model daily quota', () => {
    assert.match(source, /const modelQuotaEnabled = visionMode !== 'default';/u);
});

test('V188.2 hides only the default mini model label', () => {
    assert.match(source, /function isDefaultMiniModel\(model\)/u);
    assert.match(source, /function visibleTextModelHeader\(model\)/u);
    assert.match(source, /return isDefaultMiniModel\(model\) \? '' : `🤖/u);
    assert.match(source, /responseHeader \? `\$\{responseHeader\}\\n\\n\$\{finalAnswer\}` : finalAnswer/u);
});

test('V188.2 active communication hides mini label but may show a non-mini fallback model', () => {
    assert.match(source, /const activeModelHeader = visibleTextModelHeader\(generated\.model\);/u);
    assert.match(source, /rawContext\.send\(outboundResponse\)/u);
});
