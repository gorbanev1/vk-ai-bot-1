import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCoordsOverrideCommand } from '../../src/features/coords/coordsOverrideRouting.js';

assert.equal(parseCoordsOverrideCommand('сколько запросило корды').action, 'recipient-stats');
assert.equal(parseCoordsOverrideCommand('сколько запросило корды').ownerOnly, true);
assert.equal(parseCoordsOverrideCommand('корды юзернеймы').action, 'recipient-usernames');
assert.equal(parseCoordsOverrideCommand('корды юзернеймы').ownerOnly, true);

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
assert.match(app, /getCoordsUniqueRequesterCount/);
assert.match(app, /resolveTelegramCoordsUsernames/);
assert.match(app, /resolveVkCoordsUsernames/);
assert.match(app, /await context\.send\(String\(getCoordsUniqueRequesterCount\(\)\)\)/);
assert.match(app, /formatCoordsUsernameList\('Telegram'/);
assert.match(app, /formatCoordsUsernameList\('VK'/);
assert.match(app, /sendCoordsLongText/);

const db = readFileSync(new URL('../../src/infrastructure/database/index.js', import.meta.url), 'utf8');
assert.match(db, /external_username TEXT NOT NULL DEFAULT ''/);
assert.match(db, /externalUsername/);

console.log('coords V112 unique requester tests: OK');
