import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
assert.match(app, /async function requireOwnerDm\(/u);
assert.match(app, /async function handleManualScraperCommand[\s\S]{0,500}await requireOwnerDm\(context\)/u);
assert.match(app, /async function handleManualEventCommand[\s\S]{0,500}await requireOwnerDm\(rawContext/u);
assert.match(app, /async function handleProviderDiagnosticCommand[\s\S]{0,500}await requireOwnerDm\(context\)/u);
assert.match(app, /async function handleTelegramDiagnosticCommand[\s\S]{0,500}await requireOwnerDm\(context\)/u);
assert.match(app, /routeDecision\.route === 'routing-audit'[\s\S]{0,250}await requireOwnerDm\(context\)/u);
assert.match(app, /routeDecision\.route === 'routing-explain'[\s\S]{0,250}await requireOwnerDm\(context\)/u);
assert.match(app, /routeDecision\.route === 'rate-limit-reset'[\s\S]{0,250}await requireOwnerDm\(context\)/u);
assert.match(app, /routeDecision\.route === 'vk-chat-stop'[\s\S]{0,250}await requireOwnerDm\(context\)/u);
