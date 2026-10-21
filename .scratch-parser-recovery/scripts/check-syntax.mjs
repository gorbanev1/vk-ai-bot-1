/** Проверяет синтаксис всех JS/MJS-файлов проекта через `node --check`. */
import { readdirSync, statSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const roots = ['src', 'tests', 'scripts']
    .map((name) => resolve(root, name));
const ignoredDirectories = new Set(['node_modules', '.git', 'data', 'backup']);

function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) return [];
        const absolute = resolve(directory, entry.name);
        if (entry.isDirectory()) return walk(absolute);
        return ['.js', '.mjs', '.cjs'].includes(extname(entry.name)) ? [absolute] : [];
    });
}

const files = roots
    .filter((directory) => statSync(directory).isDirectory())
    .flatMap(walk)
    .sort();
const failures = [];

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
        cwd: root,
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        failures.push({
            file: relative(root, file).replaceAll('\\', '/'),
            error: String(result.stderr || result.stdout).trim(),
        });
    }
}

if (failures.length) {
    for (const failure of failures) {
        console.error(`\n[SYNTAX ERROR] ${failure.file}\n${failure.error}`);
    }
    process.exitCode = 1;
} else {
    console.log(`Syntax check: OK (${files.length} files)`);
}
