import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';

export function validateHuinglishParts(parts) {
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > 25) throw Error('HuInglish: invalid parts count');
    return parts.map((part,index) => {
        const body=String(part?.body ?? part ?? '').replace(/\r\n?/g,'\n').trim();
        if (typeof part==='object' && Number(part.number)!==index+1) throw Error('HuInglish: nonsequential parts');
        if (!body || body.length+(body.match(/\n/g)||[]).length>4096) throw Error('HuInglish: empty or oversized part '+(index+1));
        return body;
    });
}
export function ensureHuinglishSchema(db,{dataDir,intro='',now=Date.now}={}) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS huinglish_lessons(id INTEGER PRIMARY KEY,title TEXT NOT NULL,intro_text TEXT NOT NULL,intro_image TEXT NOT NULL,created_at INTEGER NOT NULL,published INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS huinglish_parts(lesson_id INTEGER NOT NULL,number INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(lesson_id,number));
        CREATE TABLE IF NOT EXISTS huinglish_subscriptions(platform TEXT NOT NULL,peer_id TEXT NOT NULL,chat_kind TEXT NOT NULL,thread_id INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 0,completed_lesson INTEGER NOT NULL DEFAULT 0,last_launch_day TEXT NOT NULL DEFAULT '',scheduled_lesson INTEGER NOT NULL DEFAULT 0,scheduled_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(platform,peer_id));
        CREATE TABLE IF NOT EXISTS huinglish_delivery_runs(platform TEXT NOT NULL,peer_id TEXT NOT NULL,lesson_id INTEGER NOT NULL,status TEXT NOT NULL,next_part INTEGER NOT NULL,due_at INTEGER NOT NULL,plan TEXT NOT NULL,failures INTEGER NOT NULL DEFAULT 0,started_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(platform,peer_id));
    `);
    for(const [table,columns] of [
        ['huinglish_lessons',{published:'INTEGER NOT NULL DEFAULT 1'}],
        ['huinglish_subscriptions',{completed_lessons_json:'TEXT',scheduled_kind:"TEXT NOT NULL DEFAULT 'auto'"}],
        ['huinglish_delivery_runs',{parts_json:"TEXT NOT NULL DEFAULT '[]'",last_message_json:"TEXT NOT NULL DEFAULT '{}'",last_error:"TEXT NOT NULL DEFAULT ''"}],
    ]) {
        const existing=new Set(db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name));
        for(const [name,type] of Object.entries(columns))if(!existing.has(name))db.exec('ALTER TABLE '+table+' ADD COLUMN '+name+' '+type);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
        const ids=db.prepare('SELECT id FROM huinglish_lessons WHERE published=1 ORDER BY id').all().map(x=>x.id);
        const put=db.prepare('UPDATE huinglish_subscriptions SET completed_lessons_json=? WHERE platform=? AND peer_id=?');
        for(const s of db.prepare('SELECT * FROM huinglish_subscriptions WHERE completed_lessons_json IS NULL').all())
            put.run(JSON.stringify(Object.fromEntries(ids.filter(id=>id<=s.completed_lesson).map(id=>[id,s.last_launch_day||'legacy']))),s.platform,s.peer_id);
        db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
    if(dataDir && !db.prepare('SELECT id FROM huinglish_lessons WHERE id=1').get()) {
        const files=[1,2,3,4].map(n=>join(dataDir,'english-huinglish','lesson1_part'+n+'.txt'));
        if(files.every(existsSync)) {
            const parts=validateHuinglishParts(files.map(path=>readFileSync(path,'utf8')));
            db.exec('BEGIN IMMEDIATE');
            try {
                db.prepare('INSERT INTO huinglish_lessons(id,title,intro_text,intro_image,created_at,published) VALUES(1,?,?,?,?,1)').run('Чё как, братан?',intro,'intro_vk.jpg',now());
                for(const [index,body] of parts.entries())db.prepare('INSERT INTO huinglish_parts VALUES(1,?,?)').run(index+1,body);
                db.exec('COMMIT');
            } catch(error) { db.exec('ROLLBACK'); throw error; }
        }
    }
}

// Durable explicit release. Does not send messages or reset completed progress.
export function scheduleHuinglishDrop(db,{platform,peerId,lessonId=1,startAt,now=Date.now()}) {
    if(!['vk','telegram'].includes(platform)||!Number.isInteger(lessonId)||lessonId<1||!Number.isFinite(startAt)||startAt<=now)throw Error('Invalid future lesson release');
    const sub=db.prepare('SELECT * FROM huinglish_subscriptions WHERE platform=? AND peer_id=?').get(platform,String(peerId));
    if(!sub?.enabled)throw Error('Subscription is not enabled');
    if(!db.prepare('SELECT id FROM huinglish_lessons WHERE id=? AND published=1').get(lessonId))throw Error('Lesson is not published');
    validateHuinglishParts(db.prepare('SELECT number,body FROM huinglish_parts WHERE lesson_id=? ORDER BY number').all(lessonId));
    const run=db.prepare('SELECT status FROM huinglish_delivery_runs WHERE platform=? AND peer_id=?').get(platform,String(peerId));
    if(run && ['running','paused'].includes(run.status))throw Error('Finish or resume the active lesson before scheduling a new release');
    db.prepare("UPDATE huinglish_subscriptions SET scheduled_lesson=?,scheduled_at=?,scheduled_kind='manual',updated_at=? WHERE platform=? AND peer_id=?")
        .run(lessonId,startAt,now,platform,String(peerId));
    return {platform,peerId:String(peerId),lessonId,startAt};
}
