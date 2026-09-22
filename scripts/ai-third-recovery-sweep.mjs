await import('dotenv/config');

import {
    findLatestCompletedAuditReport,
    quarantineQuotaEnvNames,
    readQuotaQuarantinedKeys,
    recoverQuotaKeysFromLatestCleanupBackup,
    removeEnvNamesFromDotEnv,
} from '../src/features/ai/envKeyCleanup.js';
import { runThirdRecoverySweep } from '../src/features/ai/thirdRecoverySweep.js';
import {
    getMaintenanceState,
    replaceAiRuntimeModes,
    setMaintenanceState,
} from '../src/infrastructure/database/index.js';
import {
    AI_QUOTA_LIFECYCLE_TASK_KEY,
    normalizeQuotaLifecycleState,
    registerQuotaKeys,
} from '../src/features/ai/quotaKeyLifecycle.js';

const force = process.argv.includes('--force');
const directory = process.cwd();

const latest = await findLatestCompletedAuditReport({ directory });
if (!latest?.report) {
    console.error('Нет завершённого полного AI-аудита. Сначала запусти «Гигорейв тест всех моделей».');
    process.exitCode = 2;
} else {
    console.log(`V145 third recovery sweep: source=${latest.outDir}`);

    const recoveredQuota = await recoverQuotaKeysFromLatestCleanupBackup({
        report: latest.report,
        directory,
        runtimeEnv: process.env,
    }).catch((error) => ({ ok: false, recovered: [], error: String(error?.message || error) }));
    if (recoveredQuota.recovered?.length) {
        console.log(`Recovered prior no-credit keys into quarantine: ${recoveredQuota.recovered.length}`);
    }

    const sweep = await runThirdRecoverySweep({
        report: latest.report,
        sourceOutDir: latest.outDir,
        env: process.env,
        directory,
        force,
        onProgress(event) {
            if (event.stage === 'third-key-start') {
                console.log(`[KEY ${event.index}/${event.total}] ${event.provider} ${event.envName}`);
            } else if (event.stage === 'third-model-start') {
                console.log(`  [MODEL ${event.index}/${event.total}] ${event.capability} ${event.model}`);
            } else if (event.stage === 'third-control-start') {
                console.log(`  [CONTROL ${event.index}/${event.total}] ${event.capability} ${event.model}`);
            } else if (event.stage === 'third-key-complete') {
                console.log(`[KEY DONE ${event.index}/${event.total}] ${event.envName} recovered=${event.recoveredModes}`);
            }
        },
    });

    const quota = await quarantineQuotaEnvNames({
        directory,
        envNames: sweep.quotaEnvNames,
        runtimeEnv: process.env,
        auditOutDir: sweep.outDir,
    });
    const invalid = await removeEnvNamesFromDotEnv({
        directory,
        envNames: sweep.invalidEnvNames,
        runtimeEnv: process.env,
        auditOutDir: sweep.outDir,
    });

    const quarantined = await readQuotaQuarantinedKeys({ directory }).catch(() => ({ entries: [] }));
    if (quarantined.entries.length) {
        let state = normalizeQuotaLifecycleState(getMaintenanceState(AI_QUOTA_LIFECYCLE_TASK_KEY)?.details || {});
        state = registerQuotaKeys(state, quarantined.entries, { now: new Date() });
        setMaintenanceState(AI_QUOTA_LIFECYCLE_TASK_KEY, {
            lastRunAt: Math.floor(Date.now() / 1000),
            details: state,
        });
    }

    replaceAiRuntimeModes(sweep.updatedWorkingModes, Math.floor(Date.now() / 1000));

    console.log('');
    console.log('=== V145 THIRD RECOVERY SWEEP COMPLETE ===');
    console.log(`uncertain keys selected: ${sweep.selected.uncertainKeys}`);
    console.log(`late recovered modes controlled: ${sweep.selected.lateRecoveredModes}`);
    console.log(`recovered modes: ${sweep.stats.recoveredModes}`);
    console.log(`stable late modes: ${sweep.stats.stableLateModes}; transport switched: ${sweep.stats.transportSwitched}; unstable kept: ${sweep.stats.unstableLateModesKept}`);
    console.log(`quota/no-credit -> quarantine: ${quota.quarantined?.length || 0}`);
    console.log(`explicit invalid -> removed from .env: ${invalid.removed?.length || 0}`);
    console.log(`blocked: ${sweep.blockedEnvNames.length}; rate-limited: ${sweep.rateLimitedEnvNames.length}; still uncertain: ${sweep.stillUncertainEnvNames.length}`);
    console.log(`runtime modes: ${sweep.stats.runtimeModesBefore} -> ${sweep.stats.runtimeModesAfter}`);
    console.log(`report: ${sweep.summaryPath}`);
    console.log(`jsonl: ${sweep.jsonlPath}`);
    console.log(`done: ${sweep.donePath}`);
}
