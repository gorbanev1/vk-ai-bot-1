import { DatabaseSync } from 'node:sqlite';
import { PATROL_PEER_ID } from './vkPatrolAdaptive.js';
import { resolveMainDatabasePath } from '../../infrastructure/database/runtimePaths.js';

const MAX_HISTORY_ROWS = 20;
const MAX_MESSAGE_CHARS = 1500;
const MAX_HISTORY_CHARS = 12_000;

function boundedLimit(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(MAX_HISTORY_ROWS, Math.trunc(parsed))) : 12;
}

function openReadOnlyDatabase(databasePath) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
    return database;
}

/**
 * Exposes narrowly scoped read tools to adaptive modules. The connection and
 * SQL are private; callers cannot choose a peer, table, or statement.
 */
export function createPatrolReadOnlyTools({ databasePath = resolveMainDatabasePath(), readMessages = null } = {}) {
    return Object.freeze({
        readRecentMessages(limit = 12) {
            if (typeof readMessages === 'function') {
                return readMessages(PATROL_PEER_ID, boundedLimit(limit)).map((row) => ({
                    senderId: Number(row.senderId) || 0,
                    cmid: Number(row.conversationMessageId ?? row.cmid) || 0,
                    text: String(row.text || '').slice(0, MAX_MESSAGE_CHARS),
                    createdAt: Number(row.createdAt) || 0,
                }));
            }
            const database = openReadOnlyDatabase(databasePath);
            try {
                const rows = database.prepare(`
                    SELECT sender_id, conversation_message_id, text, created_at
                    FROM messages
                    WHERE peer_id = ? AND text <> ''
                    ORDER BY created_at DESC, id DESC
                    LIMIT ?
                `).all(PATROL_PEER_ID, boundedLimit(limit));
                const output = [];
                let totalChars = 0;
                for (const row of rows.reverse()) {
                    const text = String(row.text || '').slice(0, MAX_MESSAGE_CHARS);
                    const remaining = MAX_HISTORY_CHARS - totalChars;
                    if (remaining <= 0) break;
                    const clipped = text.slice(0, remaining);
                    output.push({
                        senderId: Number(row.sender_id) || 0,
                        cmid: Number(row.conversation_message_id) || 0,
                        text: clipped,
                        createdAt: Number(row.created_at) || 0,
                    });
                    totalChars += clipped.length;
                }
                return output;
            } finally {
                database.close();
            }
        },
        searchMessages({terms=[],limit=35,offset=0,senderId=0,afterDate=0,beforeDate=0,excludeCmid=0,match='any'}={}){
            const inputs=Array.isArray(terms)?terms:[terms];
            const fold=value=>String(value||'').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/gu,'е');
            const words=[...new Set(inputs.filter(x=>typeof x==='string').map(x=>fold(x).trim()).filter(x=>x.length>=2&&x.length<=100))].slice(0,10);
            if(!words.length)return {terms:[],matches:0,messages:[],error:'At least one specific search term required'};
            const max=Math.max(1,Math.min(100,Math.trunc(Number(limit)||35))),skip=Math.max(0,Math.min(100000,Math.trunc(Number(offset)||0)));
            const db=openReadOnlyDatabase(databasePath);
            try{
                db.function('patrol_fold',{deterministic:true},fold);
                const conditions=['peer_id=?'],values=[PATROL_PEER_ID];
                const columns=db.prepare('PRAGMA table_info(vk_message_archive)').all().map(x=>x.name);
                if(columns.includes('source_peer_id')){conditions.push('source_peer_id=?');values.push(PATROL_PEER_ID);}
                if(Number.isSafeInteger(Number(senderId))&&Number(senderId)!==0){conditions.push('sender_id=?');values.push(Number(senderId));}
                if(Number.isSafeInteger(Number(excludeCmid))&&Number(excludeCmid)>0){conditions.push('conversation_message_id<>?');values.push(Number(excludeCmid));}
                if(Number(afterDate)>0){conditions.push('created_at>=?');values.push(Number(afterDate));}
                if(Number(beforeDate)>0){conditions.push('created_at<=?');values.push(Number(beforeDate));}
                conditions.push('('+words.map(()=> 'instr(patrol_fold(text),?)>0').join(match==='all'?' AND ':' OR ')+')');values.push(...words);
                const rows=db.prepare('SELECT sender_id,conversation_message_id,text,created_at FROM vk_message_archive WHERE '+conditions.join(' AND ')+
                    ' ORDER BY created_at DESC,conversation_message_id DESC LIMIT ? OFFSET ?').all(...values,max+1,skip);
                const more=rows.length>max;
                return {terms:words,match:match==='all'?'all':'any',matches:Math.min(rows.length,max),totalMatchesKnown:false,
                    offset:skip,nextOffset:more?skip+max:null,truncated:more,
                    messages:rows.slice(0,max).map(row=>({senderId:Number(row.sender_id)||0,peerId:PATROL_PEER_ID,
                        cmid:Number(row.conversation_message_id)||0,createdAt:Number(row.created_at)||0,
                        text:String(row.text||'').slice(0,3000),textClipped:String(row.text||'').length>3000}))};
            }finally{db.close()}
        },
    });
}

export const PATROL_ADAPTIVE_MODULES = Object.freeze({
    search_history: Object.freeze({
        description:'Search this VK chat history by several OR terms, read-only',
        readOnly:true,
        run:(tools,args={})=>tools.searchMessages(args),
    }),
    history: Object.freeze({
        description: 'Чтение последних сообщений целевой беседы из основной базы',
        readOnly: true,
        run: (tools, args = {}) => tools.readRecentMessages(args.limit),
    }),
});

export function runPatrolAdaptiveModule(name, args, tools) {
    const module = PATROL_ADAPTIVE_MODULES[String(name || '')];
    if (!module || module.readOnly !== true || typeof module.run !== 'function') {
        throw new Error('Adaptive module is not registered as read-only');
    }
    return module.run(tools, args);
}
