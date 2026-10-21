/** Проверяет существование всех относительных static/dynamic import-целей. */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ignoredDirectories = new Set(['node_modules', '.git', 'data', 'backup']);
const roots = ['src', 'tests', 'scripts'].map((name) => resolve(root, name));

function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        // `src/src` is a preserved legacy source dump, not part of the runnable tree.
        // Its imports intentionally resolve against the historical layout and would
        // otherwise create false failures for the current source tree.
        if (directory === resolve(root, 'src') && entry.isDirectory() && entry.name === 'src') return [];
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) return [];
        const absolute = resolve(directory, entry.name);
        if (entry.isDirectory()) return walk(absolute);
        return ['.js', '.mjs', '.cjs'].includes(extname(entry.name)) ? [absolute] : [];
    });
}

function resolveCandidate(importer, specifier) {
    const base = resolve(dirname(importer), specifier);
    const candidates = [
        base,
        `${base}.js`,
        `${base}.mjs`,
        `${base}.cjs`,
        resolve(base, 'index.js'),
        resolve(base, 'index.mjs'),
        resolve(base, 'index.cjs'),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const importPatterns = [
    /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
    /import\(\s*['"]([^'"]+)['"]\s*\)/gu,
];
const failures = [];
const files = roots.flatMap(walk).sort();

for (const file of files) {
    // This one-off migration script contains source text snippets that look like
    // imports but are resolved against the file it rewrites, not this script.
    if (file === resolve(root, 'scripts', 'patch-v18878-public-parser.mjs')) continue;
    const source = await import('node:fs').then(({ readFileSync }) => readFileSync(file, 'utf8'));
    const specifiers = new Set();
    for (const pattern of importPatterns) {
        for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
    }
    for (const specifier of specifiers) {
        if (!specifier.startsWith('.')) continue;
        if (!resolveCandidate(file, specifier)) {
            failures.push({
                file: relative(root, file).replaceAll('\\', '/'),
                specifier,
            });
        }
    }
}

if (failures.length) {
    for (const failure of failures) {
        console.error(`[MISSING IMPORT] ${failure.file} -> ${failure.specifier}`);
    }
    process.exitCode = 1;
} else {
    console.log(`Import check: OK (${files.length} files)`);
}
