import { HUINGLISH_QUIZ_BANK } from './huinglishQuizBank.js';
import { buildChtivoReplyForward } from '../chtivo/chtivoReplyTarget.js';

// Teach-location, not display-location. Lesson 6 repeats material originally
// taught in lessons 1–4; the reply must target that exact lesson-part message.
const PARTS_BY_LESSON = Object.freeze({
    1: [[1,4,1],[5,10,2],[11,15,3]],
    2: [[1,3,1],[4,6,2],[7,10,3]],
    3: [[1,4,1],[5,7,2],[8,11,3],[12,14,4]],
    4: [[1,3,1],[4,6,2],[7,9,3],[10,12,4],[13,14,5]],
    5: [[1,3,1],[4,6,2],[7,9,3]],
    7: [[1,3,1],[4,6,2],[7,9,3]],
});

const normal = text => String(text || '').replace(/[’‘]/gu,"'").toUpperCase();
const stable = str => String(str || '').trim().replace(/[.!?]+$/gu,'').trim();

export function huinglishQuizOrigin(item) {
    const original = item.lesson===6
        ? HUINGLISH_QUIZ_BANK.find(row=>row.lesson<6 && row.answer===item.answer)
        : item;
    if (!original || !PARTS_BY_LESSON[original.lesson]) return null;
    const index=Number(original.id.split(':')[1]);
    const part=PARTS_BY_LESSON[original.lesson].find(([start,end])=>index>=start&&index<=end)?.[2];
    if (!part) return null;
    return {lesson:original.lesson,part,search:stable(original.answer)};
}

function parseHeader(text) {
    const top=String(text||'').slice(0,500);
    const lesson=/УРОК\s*№\s*(\d+)/iu.exec(top);
    const part=/ЧАСТЬ\s*(\d+)\s*\/\s*(\d+)/iu.exec(top);
    return lesson&&part?{lesson:Number(lesson[1]),part:Number(part[1]),total:Number(part[2])}:null;
}

export function createHuinglishQuizLessonReference(db,logger=console) {
    db.exec(
        'CREATE TABLE IF NOT EXISTS huinglish_quiz_lesson_receipts ('+
        'platform TEXT NOT NULL,peer_id TEXT NOT NULL,lesson_id INTEGER NOT NULL,'+
        'part_number INTEGER NOT NULL,message_id INTEGER NOT NULL DEFAULT 0,'+
        'conversation_message_id INTEGER NOT NULL DEFAULT 0,sent_at INTEGER NOT NULL,'+
        'PRIMARY KEY(platform,peer_id,lesson_id,part_number));'
    );
    const lookup=db.prepare('SELECT message_id,conversation_message_id FROM huinglish_quiz_lesson_receipts WHERE platform=? AND peer_id=? AND lesson_id=? AND part_number=?');
    const insert=db.prepare(
        'INSERT INTO huinglish_quiz_lesson_receipts(platform,peer_id,lesson_id,part_number,message_id,conversation_message_id,sent_at)'+
        ' VALUES(?,?,?,?,?,?,?) ON CONFLICT(platform,peer_id,lesson_id,part_number) DO UPDATE SET'+
        ' message_id=excluded.message_id,conversation_message_id=excluded.conversation_message_id,sent_at=excluded.sent_at'
    );
    const hasParts=Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='huinglish_parts'").get());
    const partCount=hasParts?db.prepare('SELECT count(*) AS n FROM huinglish_parts WHERE lesson_id=?'):null;
    const hasArchive=Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vk_message_archive'").get());
    const archive=hasArchive
        ? db.prepare("SELECT message_id,conversation_message_id,text FROM vk_message_archive WHERE peer_id=? AND is_outbox=1 AND conversation_message_id>0 AND text LIKE ? ORDER BY created_at DESC LIMIT 140")
        : null;
    function record({platform='vk',peerId,lessonId,partNumber,messageId=0,conversationMessageId=0,sentAt=Date.now()}) {
        if (!Number(messageId) && !Number(conversationMessageId)) return;
        insert.run(platform,String(peerId),Number(lessonId),Number(partNumber),
            Number(messageId)||0,Number(conversationMessageId)||0,Number(sentAt));
    }
    function findArchive(peerId,origin) {
        if (!archive) return null;
        try {
            const rows=archive.all(Number(peerId),'%УРОК №'+origin.lesson+'%');
            const matched=rows.map(row=>({...row,header:parseHeader(row.text)})).filter(row=>
                row.header?.lesson===origin.lesson &&
                normal(row.text).includes(normal(origin.search))
            );
            // Prefer the actual section where the expression was first taught.
            const best=matched.find(row=>row.header.part===origin.part);
            if (!best) return null;
            return {messageId:Number(best.message_id)||0,
                conversationMessageId:Number(best.conversation_message_id)||0,
                part:best.header.part,total:best.header.total};
        } catch(error) {
            logger.warn?.('[HUINGLISH QUIZ ARCHIVE LOOKUP]',String(error?.message||error));
            return null;
        }
    }
    function locate(peerId,item) {
        const origin=huinglishQuizOrigin(item);
        if (!origin) return null;
        const receipt=lookup.get('vk',String(peerId),origin.lesson,origin.part);
        let messageId=Number(receipt?.message_id||0);
        let conversationMessageId=Number(receipt?.conversation_message_id||0);
        let part=origin.part,total=Number(partCount?.get(origin.lesson)?.n||0);
        // For old lessons there were no receipts. Use only archived bot posts
        // which really contain the expression; never reply to a guessed message.
        if (!messageId&&!conversationMessageId) {
            const found=findArchive(peerId,origin);
            if (found) {
                messageId=found.messageId;
                conversationMessageId=found.conversationMessageId;
                part=found.part; total=found.total;
            }
        }
        return {...origin,part,total,messageId,conversationMessageId,
            search:origin.search};
    }
    function replyArgs(peerId,location) {
        if (!location) return {};
        // Same VK reply mechanism as the next HuInglish lesson part:
        // forward JSON with is_reply:true creates a real «Ответить на сообщение»,
        // NOT a forwarded copy of that lesson.
        const forward=buildChtivoReplyForward(peerId,location.conversationMessageId);
        if (forward) return {forward};
        if (Number(location.messageId)>0) return {reply_to:Number(location.messageId)};
        return {};
    }
    return {record,locate,replyArgs};
}
