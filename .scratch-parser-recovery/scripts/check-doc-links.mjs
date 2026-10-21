/** Проверяет локальные Markdown-ссылки в корневых документах и docs/. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function walk(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolute = resolve(directory, entry.name);
        if (entry.isDirectory()) return walk(absolute);
        return extname(entry.name).toLowerCase() === '.md' ? [absolute] : [];
    });
}

const files = [
    ...readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
        .map((entry) => resolve(root, entry.name)),
    ...walk(resolve(root, 'docs')),
].sort();
const failures = [];

for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
        const target = match[1].trim().replace(/^<|>$/gu, '');
        if (!target || /^(?:https?:|mailto:|#)/iu.test(target)) continue;
        const pathOnly = decodeURIComponent(target.split('#')[0].split('?')[0]);
        if (!pathOnly) continue;
        const absolute = resolve(dirname(file), pathOnly);
        if (!existsSync(absolute)) {
            failures.push({
                file: relative(root, file).replaceAll('\\', '/'),
                target,
            });
        }
    }
}

if (failures.length) {
    for (const failure of failures) {
        console.error(`[BROKEN DOC LINK] ${failure.file} -> ${failure.target}`);
    }
    process.exitCode = 1;
} else {
    console.log(`Documentation link check: OK (${files.length} files)`);
}
