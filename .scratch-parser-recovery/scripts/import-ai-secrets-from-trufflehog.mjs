import {
    copyFileSync,
    existsSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');

const DETECTOR_TO_PREFIX = Object.freeze({
    OpenAI: 'OPENAI_API_KEY',
    Anthropic: 'ANTHROPIC_API_KEY',
    GoogleGeminiAPIKey: 'GEMINI_API_KEY',
    Gemini: 'GEMINI_API_KEY',
    Groq: 'GROQ_API_KEY',
    HuggingFace: 'HUGGINGFACE_API_KEY',
    NVIDIA: 'NVIDIA_API_KEY',
    Nvidia: 'NVIDIA_API_KEY',
});

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

function maskSecret(value) {
    const key = clean(value);
    if (!key) return 'empty';
    if (key.length <= 12) return `${key.slice(0, 3)}…${key.slice(-3)}`;
    return `${key.slice(0, 7)}…${key.slice(-5)}`;
}

function parseArgs(argv) {
    const positional = [];
    const options = {
        apply: false,
        auto: false,
        envPath: '',
        sourcePath: '',
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--apply') options.apply = true;
        else if (arg === '--auto') options.auto = true;
        else if (arg === '--source') options.sourcePath = clean(argv[++index]);
        else if (arg === '--env' || arg === '--env-file') options.envPath = clean(argv[++index]);
        else if (!arg.startsWith('--')) positional.push(arg);
    }

    if (!options.sourcePath && positional.length) options.sourcePath = positional[0];
    return options;
}

function parseSimpleEnv(text) {
    const result = {};
    for (const line of String(text || '').split(/\r?\n/u)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/u);
        if (!match) continue;
        result[match[1]] = unquote(match[2]);
    }
    return result;
}

function resolveFromProject(pathValue) {
    if (!pathValue) return '';
    return isAbsolute(pathValue) ? resolve(pathValue) : resolve(PROJECT_ROOT, pathValue);
}

function discoverSourcePath(explicitSource, envText) {
    if (explicitSource) return resolveFromProject(explicitSource);

    const parsedEnv = parseSimpleEnv(envText);
    const configured = clean(parsedEnv.AI_SECRETS_IMPORT_DEFAULT_FILE || process.env.AI_SECRETS_IMPORT_DEFAULT_FILE);
    const candidates = [
        configured && resolveFromProject(configured),
        resolve(PROJECT_ROOT, 'parsed_secrets.txt'),
        resolve(PROJECT_ROOT, 'parsed-secrets.txt'),
        resolve(PROJECT_ROOT, 'trufflehog-secrets.txt'),
        resolve(PROJECT_ROOT, 'trufflehog.jsonl'),
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
    if (prefix === 'HUGGINGFACE_API_KEY') return /^hf_/u.test(secret);
    return true;
}

function parseTrufflehogRecords(sourceText) {
    const records = [];
    const text = String(sourceText || '').replace(/^\uFEFF/u, '');

    // TruffleHog's common filesystem output is JSONL: one JSON object per line.
    for (const rawLine of text.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('{')) continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object') records.push(parsed);
        } catch {
            // Ignore non-JSON log noise. We report the parsed count below.
        }
    }

    // Also accept a regular JSON array/object export.
    if (!records.length) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) records.push(...parsed.filter((item) => item && typeof item === 'object'));
            else if (parsed && typeof parsed === 'object') records.push(parsed);
        } catch {
            // handled by empty result below
        }
    }

    return records;
}

function collectSupportedSecrets(records) {
    const found = new Map();
    for (const record of records) {
        const detectorName = clean(record?.DetectorName);
        const prefix = DETECTOR_TO_PREFIX[detectorName];
        if (!prefix) continue;
        const secret = clean(record?.SecretParts?.key || record?.Raw || record?.RawV2);
        if (!secretLooksUsable(prefix, secret)) continue;
        if (!found.has(prefix)) found.set(prefix, []);
        if (!found.get(prefix).includes(secret)) found.get(prefix).push(secret);
    }
    return found;
}

function buildAdditions(found, existingText) {
    const existingEnv = parseSimpleEnv(existingText);
    const existingValues = new Set(Object.values(existingEnv).map(unquote).filter(Boolean));
    const additions = [];

    for (const [prefix, secrets] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const usedNames = new Set(
            Object.keys(existingEnv).filter((name) => new RegExp(`^${prefix}(?:_\\d+)?$`, 'u').test(name)),
        );

        // Preserve the user's original primary key. Imported keys always use numbered slots.
        let slot = usedNames.has(prefix) ? 2 : 1;
        while (usedNames.has(`${prefix}_${slot}`)) slot += 1;

        for (const secret of secrets) {
            if (existingValues.has(secret)) continue;
            while (usedNames.has(`${prefix}_${slot}`)) slot += 1;
            const name = `${prefix}_${slot}`;
            additions.push({ name, secret, prefix, masked: maskSecret(secret) });
            existingValues.add(secret);
            usedNames.add(name);
            slot += 1;
        }
    }

    return additions;
}

const options = parseArgs(process.argv.slice(2));
const envPath = options.envPath ? resolveFromProject(options.envPath) : resolve(PROJECT_ROOT, '.env');
const existingText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const sourcePath = discoverSourcePath(options.sourcePath, existingText);

if (!sourcePath || !existsSync(sourcePath)) {
    const message = [
        'AI secrets source file not found.',
        `Project root: ${PROJECT_ROOT}`,
        'Expected by default: ./parsed_secrets.txt (next to src and package.json).',
        'Or run: pnpm run import:ai-secrets -- "C:\\path\\parsed_secrets.txt" --apply',
    ].join('\n');
    if (options.auto) {
        console.log(`[AI SECRETS AUTOIMPORT] skip: parsed_secrets.txt not found next to src.`);
    } else {
        console.error(message);
        process.exitCode = 2;
    }
} else {
    const sourceText = readFileSync(sourcePath, 'utf8');
    const records = parseTrufflehogRecords(sourceText);
    const found = collectSupportedSecrets(records);
    const additions = buildAdditions(found, existingText);

    console.log(`[AI SECRETS IMPORT] source=${sourcePath}`);
    console.log(`[AI SECRETS IMPORT] env=${envPath}`);
    console.log(`[AI SECRETS IMPORT] parsedRecords=${records.length}`);
    console.log('AI secrets detected (unique, supported detectors only):');
    for (const [prefix, secrets] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`  ${prefix}: ${secrets.length}`);
    }
    console.log(`New .env entries: ${additions.length}`);
    console.log('Non-AI secrets are ignored. Full secret values are never printed.');

    if (!records.length) {
        console.error('No TruffleHog JSON/JSONL records were parsed from the file.');
        process.exitCode = 3;
    } else if (!found.size) {
        console.error('No supported AI secrets were found. The file may be redacted rather than the full TruffleHog export.');
        process.exitCode = 4;
    } else if (options.apply) {
        if (additions.length) {
            if (existsSync(envPath)) {
                const backup = `${envPath}.backup-${Date.now()}`;
                copyFileSync(envPath, backup);
                console.log(`Backup: ${backup}`);
            }
            const separator = existingText && !existingText.endsWith('\n') ? '\n' : '';
            const header = `# Imported AI credentials from ${basename(sourcePath)} at ${new Date().toISOString()}`;
            const body = additions.map(({ name, secret }) => `${name}=${secret}`).join('\n');
            writeFileSync(envPath, `${existingText}${separator}\n${header}\n${body}\n`, 'utf8');
            console.log(`Updated: ${envPath}`);
            console.log(`Imported slots: ${additions.map(({ name, masked }) => `${name}=${masked}`).join(', ')}`);
        } else {
            console.log('Nothing to write: all supported AI secrets from this file already exist in .env.');
        }
    } else {
        console.log('Dry-run only. Add --apply to write .env.');
    }
}
