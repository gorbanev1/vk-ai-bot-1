import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('V188.19 owner Add Event reuses the exhaustive parser in trusted mode and saves directly', () => {
    assert.match(
        source,
        /parseEventProposalSubmission\(context, submitted, \{[\s\S]{0,240}trustedOwner:\s*true/u,
    );
    assert.match(source, /sourceName:\s*'добавлено владельцем'/u);
    assert.match(source, /status:\s*'approved'/u);
    assert.match(source, /saveManualEvent\(\{[\s\S]{0,260}createdByPlatform/u);
    assert.match(source, /trusted-owner-event-saved-v18819/u);
});

test('V188.19 trusted owner direct path requires future date but does not require venue', () => {
    const start = source.indexOf('// V188.19: owner add is a trusted, exhaustive ingestion path.');
    const end = source.indexOf('// Do not fail the owner command after one parser path.', start);
    assert.ok(start >= 0 && end > start);
    const block = source.slice(start, end);
    assert.match(block, /isValidIsoEventDate\(event\.eventDate\)/u);
    assert.match(block, /event\.eventDate\s*>?=\s*referenceDate/u);
    assert.doesNotMatch(block, /hasUsableVenueStatement\(event\.venue\)/u);
});

test('V188.19 Telegram owner id accepts compatibility env aliases', () => {
    assert.match(source, /process\.env\.TELEGRAM_OWNER_USER_ID/u);
    assert.match(source, /process\.env\.TELEGRAM_OWNER_ID/u);
    assert.match(source, /process\.env\.TELEGRAM_ADMIN_USER_ID/u);
    assert.match(source, /process\.env\.BOT_OWNER_TELEGRAM_ID/u);
});
