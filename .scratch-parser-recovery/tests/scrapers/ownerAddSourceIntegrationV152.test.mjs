import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const telegram = await readFile(new URL('../../src/platforms/telegram/telegramBot.js', import.meta.url), 'utf8');

assert.match(app, /MANUAL_SCRAPER_SOURCE_REGISTRY_KEY\s*=\s*'manual-scraper-source-registry-v152'/u);
assert.match(app, /getMaintenanceState\(MANUAL_SCRAPER_SOURCE_REGISTRY_KEY\)/u);
assert.match(app, /setMaintenanceState\(MANUAL_SCRAPER_SOURCE_REGISTRY_KEY/u);
assert.match(app, /async function addOwnerManualScraperSource\(sourceInput\)/u);
assert.match(app, /telegramHtmlScrapers\.push\(scraper\)/u);
assert.match(app, /vkPublicScrapers\.push\(scraper\)/u);
assert.match(app, /await startManualScraperSourceWithRecovery\(addition\.source\)/u);
assert.match(app, /reason: `parser-added-source:\$\{addition\.source\.id\}`/u);
assert.match(app, /if \(!isOwnerContext\(context\)\)/u);

assert.match(telegram, /addSource:\s*'Добавить источник'/u);
assert.match(telegram, /if \(isOwner\) \{[\s\S]{0,240}?rows\.push\(\[TELEGRAM_MENU_BUTTONS\.addSource\]\)/u);
assert.match(telegram, /pendingAction:\s*'add_source'/u);
assert.match(telegram, /`добавить источник \$\{text\}`/u);

console.log('ownerAddSourceIntegrationV152 tests: OK');
