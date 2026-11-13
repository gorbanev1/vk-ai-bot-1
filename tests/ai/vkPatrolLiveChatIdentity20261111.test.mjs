import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isPatrolPeer,PATROL_PEER_ID} from '../../src/features/ai/vkPatrolAdaptive.js';
test('only VK-verified Voronezh Patrol chat uses adaptive Luna',()=>{
 assert.equal(PATROL_PEER_ID,2000000011);
 assert.equal(isPatrolPeer(2000000011),true);
 assert.equal(isPatrolPeer(2000000006),false);
 assert.equal(isPatrolPeer(2000000038),false);
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(app,/VK_HISTORY_RECOVERY_DEFAULT_PEERS = Object.freeze\(\[PATROL_PEER_ID\]\)/u);
 assert.match(app,/import \{PATROL_PEER_ID,[^\n]*isPatrolPeer/u);
 assert.match(app,/maxMessages: Math.min\(VK_HISTORY_STARTUP_MAX_MESSAGES, 250\)/u);
 assert.match(app,/scanLocalBackups: false/u);
});
