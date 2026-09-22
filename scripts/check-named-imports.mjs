import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(root, 'src');

function collect(directory) {
    const out = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) out.push(...collect(absolute));
        else if (/\.(?:mjs|js)$/u.test(entry.name)) out.push(absolute);
    }
    return out;
}

function resolveRelative(fromFile, specifier) {
    const base = resolve(dirname(fromFile), specifier);
    const candidates = extname(base)
        ? [base]
        : [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js'), join(base, 'index.mjs')];
    return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) || '';
}

const exportCache = new Map();
const exportVisiting = new Set();

function splitNames(block) {
    return String(block ?? '')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
}

function exportedNames(file) {
    if (exportCache.has(file)) return exportCache.get(file);
    if (exportVisiting.has(file)) return new Set();
    exportVisiting.add(file);
    const source = readFileSync(file, 'utf8');
    const names = new Set();

    for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gu)) {
        names.add(match[1]);
    }
    for (const match of source.matchAll(/export\s*\{([^;]*?)\}(?:\s*from\s*['"]([^'"]+)['"])?\s*;/gsu)) {
        for (const part of splitNames(match[1])) {
            const pieces = part.split(/\s+as\s+/u).map((value) => value.trim());
            names.add(pieces.length > 1 ? pieces.at(-1) : pieces[0]);
        }
    }
    for (const match of source.matchAll(/export\s*\*\s*from\s*['"](\.[^'"]+)['"]\s*;/gu)) {
        const target = resolveRelative(file, match[1]);
        if (target) {
            for (const name of exportedNames(target)) names.add(name);
        }
    }

    exportVisiting.delete(file);
    exportCache.set(file, names);
    return names;
}

const missing = [];
for (const file of collect(srcRoot)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/import\s*\{([^;]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;/gsu)) {
        const specifier = match[2];
        if (!specifier.startsWith('.')) continue;
        const target = resolveRelative(file, specifier);
        if (!target) continue; // handled by check-imports
        const available = exportedNames(target);
        for (const part of splitNames(match[1])) {
            const imported = part.split(/\s+as\s+/u)[0].trim();
            if (/^[A-Za-z_$][\w$]*$/u.test(imported) && !available.has(imported)) {
                missing.push({ file, imported, target });
            }
        }
    }
}

if (missing.length) {
    for (const row of missing) {
        console.error(`[NAMED IMPORT MISSING] ${row.file.slice(root.length + 1)} -> ${row.imported} from ${row.target.slice(root.length + 1)}`);
    }
    process.exitCode = 1;
} else {
    console.log(`[NAMED IMPORT CHECK] ok files=${collect(srcRoot).length} missing=0`);
}
