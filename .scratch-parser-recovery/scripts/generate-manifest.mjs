import {
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, relative, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(projectRoot, 'src');

function walk(directory) {
    return readdirSync(directory).flatMap((name) => {
        const absolute = resolve(directory, name);
        return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
    });
}

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function projectPath(file) {
    return relative(projectRoot, file).replaceAll('\\', '/');
}

function moduleDescription(source) {
    const match = source.match(/^\/\*\*\n \* (.*?)\n \*\//su);
    return match ? match[1].replace(/\n \* /gu, ' ').replace(/\s+/gu, ' ').trim() : '—';
}

const actualModules = [];
const compatibilityModules = [];

for (const file of walk(sourceRoot).filter((item) => extname(item) === '.js').sort()) {
    const source = readFileSync(file, 'utf8');
    const item = {
        path: projectPath(file),
        lines: source.split(/\r?\n/u).length,
        description: moduleDescription(source),
    };

    if (resolve(file, '..') === sourceRoot && !file.endsWith('/index.js') && !file.endsWith('\\index.js')) {
        compatibilityModules.push(item);
    } else {
        actualModules.push(item);
    }
}

const sourceMap = [
    '# Карта исходников',
    '',
    'Файл генерируется командой `pnpm manifest`.',
    '',
    '## Рабочие модули',
    '',
    '| Файл | Строк | Ответственность |',
    '|---|---:|---|',
    ...actualModules.map((item) => `| \`${item.path}\` | ${item.lines} | ${item.description.replaceAll('|', '\\|')} |`),
    '',
    '## Совместимые старые пути',
    '',
    'Новый код не должен импортировать эти re-export файлы.',
    '',
    '| Файл | Строк |',
    '|---|---:|',
    ...compatibilityModules.map((item) => `| \`${item.path}\` | ${item.lines} |`),
    '',
].join('\n');

writeFileSync(resolve(projectRoot, 'docs/SOURCE_MAP.md'), sourceMap, 'utf8');

const databaseSource = readFileSync(
    resolve(projectRoot, 'src/infrastructure/database/index.js'),
    'utf8',
);
const databaseTables = [
    ...databaseSource.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-zA-Z0-9_]+)/gu),
].map((match) => match[1]);
const environmentVariables = new Set([
    'OPENAI_COMPAT_STREAM',
    'TELEGRAM_HTML_ENABLED',
    'TELEGRAM_HTML_DOWNLOAD_IMAGES',
    'VK_PUBLIC_SCRAPER_ENABLED',
    'VK_PUBLIC_DOWNLOAD_IMAGES',
    'VK_CHAT_EVENT_SCRAPER_ENABLED',
    'VK_CHAT_LIVE_MONITOR_ENABLED',
    'GIGORAVE_STATE_DIR',
]);

for (const file of walk(sourceRoot).filter((item) => extname(item) === '.js')) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/gu)) environmentVariables.add(match[1]);
    for (const match of source.matchAll(/process\.env\[['"]([A-Z0-9_]+)['"]\]/gu)) environmentVariables.add(match[1]);
}

const files = walk(projectRoot)
    .filter((file) => {
        const path = projectPath(file);
        return (
            path !== '.env' &&
            path !== 'PROJECT_MANIFEST.json' &&
            !path.startsWith('.git/') &&
            !path.startsWith('.idea/') &&
            !path.startsWith('backup/') &&
            !path.startsWith('data/') &&
            !path.startsWith('node_modules/') &&
            !path.endsWith('.zip') &&
            !path.endsWith('.rar') &&
            !path.endsWith('.sha256')
        );
    })
    .sort()
    .map((file) => {
        const content = readFileSync(file);
        return {
            path: projectPath(file),
            bytes: content.length,
            sha256: sha256(content),
        };
    });

const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
const applicationSource = readFileSync(
    resolve(projectRoot, 'src/app/botApplication.js'),
    'utf8',
);
const buildMatch = applicationSource.match(
    /const BOT_PATCH_VERSION = ['"]([^'"]+)['"]/u,
);
const manifest = {
    project: packageJson.name,
    packageVersion: packageJson.version,
    build: buildMatch?.[1] ?? 'unknown-build',
    entrypoint: 'src/index.js',
    orchestrator: 'src/app/botApplication.js',
    node: packageJson.engines?.node,
    packageManager: packageJson.packageManager,
    database: 'data/bot.sqlite (release-local operational DB) + user-level auto-summary.sqlite (durable scheduler state)',
    databaseTables,
    environmentVariables: [...environmentVariables].sort(),
    sourceFiles: walk(sourceRoot).filter((file) => extname(file) === '.js').length,
    testFiles: walk(resolve(projectRoot, 'tests')).filter((file) => ['.js', '.mjs'].includes(extname(file))).length,
    files,
};

writeFileSync(
    resolve(projectRoot, 'PROJECT_MANIFEST.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
);
console.log(`Manifest generated: files=${files.length}, source=${manifest.sourceFiles}, tests=${manifest.testFiles}`);
