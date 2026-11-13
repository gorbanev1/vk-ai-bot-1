import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

// Windows readers/antivirus can briefly prevent atomic replacement. Keep the
// old checkpoint intact until rename succeeds; retain the temporary payload
// on exhaustion for diagnosis/recovery. Never unlink or truncate the target.
export async function renameCheckpointWithRetry(temporary, target, {
    renameFile = rename,
    wait = delay,
} = {}) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            await renameFile(temporary, target);
            return;
        } catch (error) {
            if (!TRANSIENT_RENAME_CODES.has(error?.code) || attempt >= RETRY_DELAYS_MS.length) throw error;
            await wait(RETRY_DELAYS_MS[attempt]);
        }
    }
}
