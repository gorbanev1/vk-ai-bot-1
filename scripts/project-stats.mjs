/** Печатает компактную статистику исходников и тестов. */
import { readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolute = resolve(directory, entry.name);
        if (entry.isDirectory()) return walk(absolute);
        return ['.js', '.mjs'].includes(extname(entry.name)) ? [absolute] : [];
    });
}

for (const folder of ['src', 'tests', 'scripts']) {
    const files = walk(resolve(root, folder));
    const lines = files.reduce(
        (sum, file) => sum + readFileSync(file, 'utf8').split(/\r?\n/u).length,
        0,
    );
    console.log(`${folder}: files=${files.length} lines=${lines}`);
}
console.log(`root=${relative(process.cwd(), root) || '.'}`);
