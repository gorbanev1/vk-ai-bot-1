import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeLegacyAiSecretFiles } from '../../src/features/ai/legacySecretCleanup.js';

const root = mkdtempSync(join(tmpdir(), 'gigorave-v118-secret-cleanup-'));
try {
    const legacy = join(root, 'parsed_secrets.txt');
    writeFileSync(legacy, 'DO_NOT_PARSE_THIS=secret\n', 'utf8');
    const result = removeLegacyAiSecretFiles({ directory: root, logger: { log() {}, error() {} } });
    assert.equal(result.removed.length, 1);
    assert.equal(existsSync(legacy), false);
} finally {
    rmSync(root, { recursive: true, force: true });
}

console.log('legacy secret cleanup V118 tests: ok');
