import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
    buildHistoricalRecoveryCandidate,
} from '../src/infrastructure/database/databaseLineageGuard.js';
import { checkSqliteHealth } from '../src/infrastructure/database/databasePreflight.js';

const dataDirectory = resolve(process.argv[2] || 'data');
const activeDatabasePath = join(dataDirectory, 'bot.sqlite');
const backupDirectory = join(dataDirectory, 'healthy-backups');
const recoveryDirectory = join(dataDirectory, 'recovery-candidates');
mkdirSync(recoveryDirectory, { recursive: true });

function latestHealthyBackup() {
    if (!existsSync(backupDirectory)) return '';
    return readdirSync(backupDirectory)
        .filter((name) => /^bot-(?:startup|healthy)-.*\.sqlite$/u.test(name))
        .map((name) => join(backupDirectory, name))
        .filter((path) => {
            try { return statSync(path).isFile(); } catch { return false; }
        })
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? '';
}

const backupDatabasePath = latestHealthyBackup();
if (!existsSync(activeDatabasePath)) throw new Error(`active DB not found: ${activeDatabasePath}`);
if (!backupDatabasePath) throw new Error(`healthy backup not found in: ${backupDirectory}`);

const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const candidateDatabasePath = join(recoveryDirectory, `bot-reconciled-${stamp}.sqlite`);
const reportPath = join(recoveryDirectory, `bot-reconciled-${stamp}.json`);

const result = buildHistoricalRecoveryCandidate({
    activeDatabasePath,
    backupDatabasePath,
    candidateDatabasePath,
});
const health = checkSqliteHealth(candidateDatabasePath);
const report = {
    activeDatabasePath,
    backupDatabasePath,
    candidateDatabasePath,
    health,
    ...result,
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`[DB RECOVERY CANDIDATE] candidate=${candidateDatabasePath}`);
console.log(`[DB RECOVERY CANDIDATE] backup=${backupDatabasePath}`);
for (const item of result.merge) {
    if (item.skipped) console.log(`[DB RECOVERY TABLE] ${item.table} skipped=${item.reason}`);
    else console.log(`[DB RECOVERY TABLE] ${item.table} scanned=${item.scanned} inserted=${item.inserted}`);
}
console.log(`[DB RECOVERY CANDIDATE] quickCheck=${health.ok ? 'ok' : health.detail} backupOnlyAfterMerge=${result.lineage.backupOnlyRows} activeOnlyTailPreserved=${result.lineage.activeOnlyTailRows}`);
console.log(`[DB RECOVERY CANDIDATE] report=${reportPath}`);
if (!health.ok || !result.valid) process.exitCode = 2;
