import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const sourceScript = new URL('../../scripts/import-ai-secrets-from-trufflehog.mjs', import.meta.url);

function record(detectorName, key) {
    return JSON.stringify({ DetectorName: detectorName, Raw: key, SecretParts: { key } });
}

test('auto-import discovers parsed_secrets.txt next to src and is idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'vk-ai-import-'));
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'src'));
    cpSync(sourceScript, join(root, 'scripts', 'import-ai-secrets-from-trufflehog.mjs'));
    writeFileSync(join(root, '.env'), 'OPENAI_COMPAT_API_KEY=primary-user-key\n', 'utf8');
    writeFileSync(join(root, 'parsed_secrets.txt'), [
        record('GoogleGeminiAPIKey', 'AIzaTEST012345678901234567890123456789'),
        record('Groq', 'TEST_GROQ_0123456789'),
        record('Stripe', 'sk_live_should_be_ignored_012345678901234567890123'),
    ].join('\n'), 'utf8');

    const script = join(root, 'scripts', 'import-ai-secrets-from-trufflehog.mjs');
    execFileSync(process.execPath, [script, '--auto', '--apply'], { cwd: root, stdio: 'pipe' });
    const first = readFileSync(join(root, '.env'), 'utf8');
    assert.match(first, /^GEMINI_API_KEY_1=AIzaTEST/mu);
    assert.match(first, /^GROQ_API_KEY_1=TEST_GROQ_/mu);
    assert.doesNotMatch(first, /sk_live_should_be_ignored/u);
    assert.match(first, /^OPENAI_COMPAT_API_KEY=primary-user-key$/mu);

    execFileSync(process.execPath, [script, '--auto', '--apply'], { cwd: root, stdio: 'pipe' });
    const second = readFileSync(join(root, '.env'), 'utf8');
    assert.equal((second.match(/^GEMINI_API_KEY_1=/gmu) || []).length, 1);
    assert.equal((second.match(/^GROQ_API_KEY_1=/gmu) || []).length, 1);
});
