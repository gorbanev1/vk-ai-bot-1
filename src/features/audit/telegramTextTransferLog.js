import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Separate, owner-only plain text diagnostics. Never log prompts, response bodies,
// authorization headers, URL paths, files or personal conversation data.
const safeId = (value) => String(value || '').replace(/[^a-z0-9_-]/giu, '_').slice(0, 100);
const clean = (value) => String(value ?? '-').replace(/[\r\n\t]/gu, ' ').replace(/[^a-zA-Z0-9_ .:\/-]/gu, '_').slice(0, 180);
export async function appendTelegramTextTransferLog({ jobId, event, root = resolve(process.env.GIGORAVE_TEXT_DATA_DIR || 'data', 'telegram-text-transfer-logs') }) {
    if (!/^[a-f0-9-]{36}$/iu.test(String(jobId || ''))) throw new Error('invalid text job id');
    const name = safeId(jobId);
    const dir = join(root, name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const fields = Object.entries(event || {}).filter(([key]) => !/prompt|secret|token|content|file|url|errorMessage/i.test(key))
        .map(([key, val]) => `${clean(key)}=${clean(val)}`).join(' ');
    await appendFile(join(dir, 'transfer.log'), `${new Date().toISOString()} ${fields}\n`, { mode: 0o600 });
}
