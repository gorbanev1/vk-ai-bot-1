import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dataDirectory = mkdtempSync(join(tmpdir(), 'gigorave-alternative-titles-'));
process.env.GIGORAVE_DATA_DIR = dataDirectory;
process.env.GIGORAVE_DB_PATH = join(dataDirectory, 'bot.sqlite');
process.env.GIGORAVE_QTICKETS_DB_PATH = join(dataDirectory, 'qtickets.sqlite');
const { MAIN_DATABASE_PATH, saveManualEvent, getAllUpcomingEventRecordsForDedupe } = await import('../../src/infrastructure/database/index.js');

const id = saveManualEvent({
    title: 'ORTHOPEDIC NURSES DAY',
    alternativeTitles: ['ДЕНЬ ОРТОПЕДИЧЕСКОЙ МЕДСЕСТРЫ'],
    eventDate: '2099-10-30', eventTime: '19:30', venue: 'Berserk Bar',
    status: 'approved', ownerManual: true,
});
const db = new DatabaseSync(MAIN_DATABASE_PATH, { readOnly: true });
try {
    const row = db.prepare('SELECT alternative_titles_json FROM manual_events WHERE id = ?').get(id);
    assert.deepEqual(new Set(JSON.parse(row.alternative_titles_json)), new Set([
        'ORTHOPEDIC NURSES DAY', 'ДЕНЬ ОРТОПЕДИЧЕСКОЙ МЕДСЕСТРЫ',
    ]));
    const loaded = getAllUpcomingEventRecordsForDedupe({ fromDate: '2099-10-30' })
        .find((event) => event.sourceType === 'manual' && event.id === id);
    assert.deepEqual(new Set(loaded.alternativeTitles), new Set([
        'ORTHOPEDIC NURSES DAY', 'ДЕНЬ ОРТОПЕДИЧЕСКОЙ МЕДСЕСТРЫ',
    ]));
} finally {
    db.close();
}
console.log('eventAlternativeTitlesPersistence20261030.test.mjs: OK');
