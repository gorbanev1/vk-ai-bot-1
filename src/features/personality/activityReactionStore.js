import {DatabaseSync} from 'node:sqlite';
import {resolveMainDatabasePath} from '../../infrastructure/database/runtimePaths.js';
let db;
export function recordActivityReaction({peerId,messageId,actorId,count,date}){
 if(!db){db=new DatabaseSync(resolveMainDatabasePath());db.exec('PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS activity_reaction_snapshots(peer_id INTEGER NOT NULL,message_id INTEGER NOT NULL,actor_id INTEGER NOT NULL,reaction_count INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(peer_id,message_id,actor_id))');}
 db.prepare('INSERT INTO activity_reaction_snapshots VALUES(?,?,?,?,?) ON CONFLICT(peer_id,message_id,actor_id) DO UPDATE SET reaction_count=excluded.reaction_count,updated_at=excluded.updated_at WHERE excluded.updated_at>=activity_reaction_snapshots.updated_at').run(peerId,messageId,actorId,Math.max(0,count),date);
}
