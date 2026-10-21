import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { pruneParserForensicArchives } from '../../src/features/scrapers/manualParserDiagnostics.js';

test('keeps three latest archives per label', async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'parser-archive-retention-'));
    const archiveRoot = join(dataDirectory, 'parser-forensic-archives');
    mkdirSync(archiveRoot);
    const addArchive = (stamp, label) => {
        const name = `${stamp}_${label}_abcdef`;
        mkdirSync(join(archiveRoot, name));
        writeFileSync(join(archiveRoot, name, 'trace.jsonl'), '');
        return name;
    };

    try {
        const clean = Array.from({ length: 6 }, (_, index) =>
            addArchive(`2026-10-${String(index + 1).padStart(2, '0')}T00-00-00-000Z`, 'parser-all-clean'));
        const other = Array.from({ length: 5 }, (_, index) =>
            addArchive(`2026-10-${String(index + 1).padStart(2, '0')}T00-00-00-000Z`, 'parser-all-secondary'));

        const result = await pruneParserForensicArchives({ dataDirectory, keepPerLabel: 3 });

        const remaining = readdirSync(archiveRoot);
        assert.equal(remaining.length, 6);
        assert.ok(remaining.includes(clean.at(-1)));
        assert.ok(remaining.includes(other.at(-1)));
        assert.equal(result.removed.length, 5);
        assert.equal(result.removed.some((name) => name.startsWith('2026-10-03T')), true);
    } finally {
        rmSync(dataDirectory, { recursive: true, force: true });
    }
});
