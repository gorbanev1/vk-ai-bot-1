import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export const LEGACY_AI_SECRET_FILENAMES = Object.freeze([
    'parsed_secrets.txt',
    'parsed_secrets.jsonl',
    'parsed-secrets.txt',
]);

export function removeLegacyAiSecretFiles({ directory = process.cwd(), logger = console } = {}) {
    const removed = [];
    const failed = [];

    for (const filename of LEGACY_AI_SECRET_FILENAMES) {
        const path = resolve(directory, filename);
        if (!existsSync(path)) continue;
        try {
            rmSync(path, { force: true });
            removed.push(path);
        } catch (error) {
            failed.push({ path, error: String(error?.message || error) });
        }
    }

    if (removed.length) {
        logger?.log?.('[AI LEGACY SECRETS CLEANUP]', `removed=${removed.length}`);
    }
    if (failed.length) {
        logger?.error?.('[AI LEGACY SECRETS CLEANUP ERROR]', `failed=${failed.length}`);
    }

    return { removed, failed };
}
