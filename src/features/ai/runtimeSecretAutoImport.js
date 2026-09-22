import {
    copyFileSync,
    existsSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = resolve(MODULE_DIR, '../../..');

const DETECTOR_TO_PREFIX = Object.freeze({
    OpenAI: 'OPENAI_API_KEY',
    Anthropic: 'ANTHROPIC_API_KEY',
    GoogleGeminiAPIKey: 'GEMINI_API_KEY',
    Gemini: 'GEMINI_API_KEY',
    Groq: 'GROQ_API_KEY',
    xAI: 'XAI_API_KEY',
    XAI: 'XAI_API_KEY',
    HuggingFace: 'HUGGINGFACE_API_KEY',
    NVIDIA: 'NVIDIA_API_KEY',
    Nvidia: 'NVIDIA_API_KEY',
});

const SUPPORTED_PREFIXES = Object.freeze([...new Set(Object.values(DETECTOR_TO_PREFIX))]);

function clean(value) {
    return String(value ?? '').trim();
}

function unquote(value) {
    const text = clean(value);
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1);
    }
    return text;
}

export function maskImportedSecret(value) {
    const key = clean(value);
    if (!key) return 'empty';
    if (key.length <= 12) return `${key.slice(0, 3)}…${key.slice(-3)}`;
    return `${key.slice(0, 7)}…${key.slice(-5)}`;
}

export function parseRuntimeEnvText(text) {
    const result = {};
    for (const line of String(text || '').split(/\r?\n/u)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/u);
        if (!match) continue;
        result[match[1]] = unquote(match[2]);
    }
    return result;
}

function resolveFromRoot(projectRoot, pathValue) {
    if (!pathValue) return '';
    return isAbsolute(pathValue) ? resolve(pathValue) : resolve(projectRoot, pathValue);
}

export function discoverRuntimeSecretSource({ projectRoot = DEFAULT_PROJECT_ROOT, sourcePath = '', envText = '' } = {}) {
    if (sourcePath) return resolveFromRoot(projectRoot, sourcePath);

    const parsedEnv = parseRuntimeEnvText(envText);
    const configured = clean(parsedEnv.AI_SECRETS_IMPORT_DEFAULT_FILE || process.env.AI_SECRETS_IMPORT_DEFAULT_FILE);
    const candidates = [
        configured && resolveFromRoot(projectRoot, configured),
        resolve(projectRoot, 'parsed_secrets.txt'),
        resolve(projectRoot, 'parsed-secrets.txt'),
        resolve(projectRoot, 'parsed_secrets.jsonl'),
        resolve(projectRoot, 'trufflehog-secrets.txt'),
        resolve(projectRoot, 'trufflehog.jsonl'),
    ].filter(Boolean);

    return candidates.find((candidate) => existsSync(candidate)) || '';
}

function secretLooksUsable(prefix, secret) {
    if (!secret || secret.length < 12) return false;
    if (secret.includes('…') || secret.includes('***') || /<redacted>|REDACTED/iu.test(secret)) return false;
    if (prefix === 'OPENAI_API_KEY') return /^sk-/u.test(secret);
    if (prefix === 'ANTHROPIC_API_KEY') return /^sk-ant-/u.test(secret);
    if (prefix === 'GEMINI_API_KEY') return /^AIza/u.test(secret);
    if (prefix === 'GROQ_API_KEY') return /^gsk_/u.test(secret);
    if (prefix === 'XAI_API_KEY') return /^xai-/iu.test(secret) || secret.length >= 20;
    if (prefix === 'HUGGINGFACE_API_KEY') return /^hf_/u.test(secret);
    if (prefix === 'NVIDIA_API_KEY') return /^(?:nvapi-|nvapi_)/iu.test(secret);
    return true;
}

export function parseRuntimeTrufflehogRecords(sourceText) {
    const records = [];
    const text = String(sourceText || '').replace(/^\uFEFF/u, '');

    for (const rawLine of text.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('{')) continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object') records.push(parsed);
        } catch {
            // TruffleHog logs can contain unrelated text; ignore it.
        }
    }

    if (!records.length) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) records.push(...parsed.filter((item) => item && typeof item === 'object'));
            else if (parsed && typeof parsed === 'object') records.push(parsed);
        } catch {
            // Empty result is reported by the caller.
        }
    }

    return records;
}

export function collectRuntimeAiSecrets(records) {
    const found = new Map();
    for (const record of records || []) {
        const prefix = DETECTOR_TO_PREFIX[clean(record?.DetectorName)];
        if (!prefix) continue;
        const secret = clean(record?.SecretParts?.key || record?.Raw || record?.RawV2);
        if (!secretLooksUsable(prefix, secret)) continue;
        if (!found.has(prefix)) found.set(prefix, []);
        const bucket = found.get(prefix);
        if (!bucket.includes(secret)) bucket.push(secret);
    }
    return found;
}

function supportedEnvName(name) {
    return SUPPORTED_PREFIXES.some((prefix) => new RegExp(`^${prefix}(?:_\\d+)?$`, 'u').test(name));
}

export function buildRuntimeSecretAdditions(found, existingText) {
    const existingEnv = parseRuntimeEnvText(existingText);
    const existingValues = new Set(Object.values(existingEnv).map(unquote).filter(Boolean));
    const additions = [];

    for (const [prefix, secrets] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const usedNames = new Set(
            Object.keys(existingEnv).filter((name) => new RegExp(`^${prefix}(?:_\\d+)?$`, 'u').test(name)),
        );

        // Never replace/create the unnumbered primary key from a scanned file.
        // Imported credentials are always secondary slots.
        let slot = 1;
        if (prefix === 'OPENAI_API_KEY') slot = 2;
        while (usedNames.has(`${prefix}_${slot}`)) slot += 1;

        for (const secret of secrets) {
            if (existingValues.has(secret)) continue;
            while (usedNames.has(`${prefix}_${slot}`)) slot += 1;
            const name = `${prefix}_${slot}`;
            additions.push({ name, secret, prefix, masked: maskImportedSecret(secret) });
            existingValues.add(secret);
            existingEnv[name] = secret;
            usedNames.add(name);
            slot += 1;
        }
    }

    return additions;
}

function syncSupportedEnvIntoProcess(envText, { override = false } = {}) {
    const parsed = parseRuntimeEnvText(envText);
    const synced = [];
    for (const [name, secret] of Object.entries(parsed)) {
        if (!supportedEnvName(name) || !clean(secret)) continue;
        if (override || !clean(process.env[name])) process.env[name] = secret;
        if (clean(process.env[name])) synced.push(name);
    }
    return synced;
}

export function autoImportAiSecretsFromProjectRoot({
    projectRoot = DEFAULT_PROJECT_ROOT,
    sourcePath = '',
    envPath = '',
    applyToProcessEnv = true,
    createBackup = true,
    log = true,
} = {}) {
    const root = resolve(projectRoot);
    const resolvedEnvPath = envPath ? resolveFromRoot(root, envPath) : resolve(root, '.env');
    const existingText = existsSync(resolvedEnvPath) ? readFileSync(resolvedEnvPath, 'utf8') : '';
    const resolvedSourcePath = discoverRuntimeSecretSource({ projectRoot: root, sourcePath, envText: existingText });

    if (!resolvedSourcePath || !existsSync(resolvedSourcePath)) {
        if (applyToProcessEnv) syncSupportedEnvIntoProcess(existingText);
        if (log) console.log('[AI SECRETS BOT AUTOIMPORT] source not found; expected ./parsed_secrets.txt next to src.');
        return {
            ok: true,
            sourceFound: false,
            sourcePath: '',
            envPath: resolvedEnvPath,
            parsedRecords: 0,
            detected: {},
            additions: [],
            syncedEnvNames: [],
        };
    }

    const sourceText = readFileSync(resolvedSourcePath, 'utf8');
    const records = parseRuntimeTrufflehogRecords(sourceText);
    const found = collectRuntimeAiSecrets(records);
    const additions = buildRuntimeSecretAdditions(found, existingText);
    let finalText = existingText;
    let backupPath = '';

    if (additions.length) {
        if (createBackup && existsSync(resolvedEnvPath)) {
            backupPath = `${resolvedEnvPath}.backup-${Date.now()}`;
            copyFileSync(resolvedEnvPath, backupPath);
        }
        const separator = finalText && !finalText.endsWith('\n') ? '\n' : '';
        const header = `# Imported by bot from ${basename(resolvedSourcePath)} at ${new Date().toISOString()}`;
        const body = additions.map(({ name, secret }) => `${name}=${secret}`).join('\n');
        finalText = `${finalText}${separator}\n${header}\n${body}\n`;
        writeFileSync(resolvedEnvPath, finalText, 'utf8');
    }

    // Critical V83 behavior: the running bot receives every numbered slot now,
    // so a restart is not required before "ключи проверить все".
    const syncedEnvNames = applyToProcessEnv ? syncSupportedEnvIntoProcess(finalText) : [];
    for (const addition of additions) {
        if (applyToProcessEnv) process.env[addition.name] = addition.secret;
    }

    const detected = Object.fromEntries([...found.entries()].map(([prefix, secrets]) => [prefix, secrets.length]));

    if (log) {
        console.log('[AI SECRETS BOT AUTOIMPORT]', `source=${resolvedSourcePath}`);
        console.log('[AI SECRETS BOT AUTOIMPORT]', `parsedRecords=${records.length}`, `detected=${[...found.values()].reduce((sum, items) => sum + items.length, 0)}`, `new=${additions.length}`, `runtimeSlots=${syncedEnvNames.length}`);
        for (const [prefix, count] of Object.entries(detected)) console.log('[AI SECRETS BOT AUTOIMPORT]', `${prefix}=${count}`);
        if (additions.length) console.log('[AI SECRETS BOT AUTOIMPORT]', `added=${additions.map((item) => `${item.name}:${item.masked}`).join(',')}`);
        if (backupPath) console.log('[AI SECRETS BOT AUTOIMPORT]', `backup=${backupPath}`);
    }

    return {
        ok: records.length > 0 && found.size > 0,
        sourceFound: true,
        sourcePath: resolvedSourcePath,
        envPath: resolvedEnvPath,
        backupPath,
        parsedRecords: records.length,
        detected,
        additions,
        syncedEnvNames,
    };
}
