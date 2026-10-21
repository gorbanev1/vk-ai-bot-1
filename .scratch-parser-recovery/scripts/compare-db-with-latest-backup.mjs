import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
    compareDatabaseLineage,
    createDatabaseComparisonSnapshot,
} from '../src/infrastructure/database/databaseLineageGuard.js';

const dataDirectory = resolve(process.argv[2] || 'data');
const activeDatabasePath = join(dataDirectory, 'bot.sqlite');
const backupDirectory = join(dataDirectory, 'healthy-backups');
const auditDirectory = join(dataDirectory, 'recovery-audit');
mkdirSync(auditDirectory, { recursive: true });

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
const snapshotPath = join(auditDirectory, `active-snapshot-${stamp}.sqlite`);
const reportPath = join(auditDirectory, `lineage-${stamp}.json`);

createDatabaseComparisonSnapshot({ sourceDatabasePath: activeDatabasePath, snapshotPath });
const report = compareDatabaseLineage({
    activeDatabasePath: snapshotPath,
    backupDatabasePath,
});
writeFileSync(reportPath, `${JSON.stringify({ ...report, liveDatabasePath: activeDatabasePath, snapshotPath }, null, 2)}\n`);

console.log(`[DB LINEAGE] verdict=${report.verdict}`);
console.log(`[DB LINEAGE] backup=${backupDatabasePath}`);
console.log(`[DB LINEAGE] liveSnapshot=${snapshotPath}`);
console.log(`[DB LINEAGE] backupOnly=${report.backupOnlyRows} activeOnly=${report.activeOnlyRows} activeOnlyTail=${report.activeOnlyTailRows} activeOnlyHistorical=${report.activeOnlyHistoricalRows}`);
for (const table of report.tables) {
    if (table.skipped) continue;
    console.log(`[DB LINEAGE TABLE] ${table.table} backup=${table.backupRows ?? 0} active=${table.activeRows ?? 0} missing=${table.backupOnlyRows ?? 0} newTail=${table.activeOnlyTailRows ?? 0}`);
}
console.log(`[DB LINEAGE] report=${reportPath}`);
process.exitCode = report.regressed ? 2 : 0;
