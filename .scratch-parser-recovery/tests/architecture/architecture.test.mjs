import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const entry = readFileSync(resolve(root, 'src/index.js'), 'utf8');
const application = readFileSync(
    resolve(root, 'src/app/botApplication.js'),
    'utf8',
);

assert.equal(entry.includes('startApplication'), true);
assert.equal(entry.split(/\r?\n/u).length < 40, true);
assert.equal(application.includes('export async function startApplication()'), true);
assert.equal(application.includes('acquireSingleInstanceLock'), false);

const compatibilityModules = [
    'database.js',
    'telegramBot.js',
    'vkPublicScraper.js',
    'memoryRouting.js',
    'openAIStream.js',
];

for (const moduleName of compatibilityModules) {
    const source = readFileSync(resolve(root, 'src', moduleName), 'utf8');
    assert.match(source, /export \* from/u);
}

console.log('architecture tests: OK');
