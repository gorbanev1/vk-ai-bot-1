import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { addAstraToVisionProfiles, validateModelLadderProfiles } from '../src/features/ai/modelLadderProfiles.js';

const apply = process.argv.includes('--apply');
const db = new DatabaseSync(resolve(process.env.GIGORAVE_DB_PATH || 'data/bot.sqlite'), { readOnly: !apply });
const key = 'ai-model-ladder-profiles-v1';
try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (apply) db.exec('BEGIN IMMEDIATE');
    const row = db.prepare('SELECT * FROM maintenance_state WHERE task_key = ?').get(key);
    if (!row) throw new Error('Saved model profiles not found');
    const details = JSON.parse(row.details_json);
    const profiles = addAstraToVisionProfiles(validateModelLadderProfiles(details.profiles));
    if (JSON.stringify(profiles) !== JSON.stringify(details.profiles) && apply) {
        const directory = resolve('data/backups');
        mkdirSync(directory, { recursive: true });
        const backup = resolve(directory, `vision-profiles-before-astra-${Date.now()}.json`);
        writeFileSync(backup, JSON.stringify(row, null, 2), { flag: 'wx' });
        db.prepare('UPDATE maintenance_state SET details_json = ? WHERE task_key = ?').run(JSON.stringify({
            ...details, profiles, updatedAt: new Date().toISOString(), visionAstraMigration: '2026-10-08',
        }), key);
        console.log('Backup:', backup);
    }
    if (apply) db.exec('COMMIT');
    console.log(JSON.stringify({ applied: apply, profiles: Object.fromEntries(Object.entries(profiles).filter(([k]) => k.includes('vision'))) }, null, 2));
} catch (error) {
    if (apply) { try { db.exec('ROLLBACK'); } catch {} }
    throw error;
} finally { db.close(); }
