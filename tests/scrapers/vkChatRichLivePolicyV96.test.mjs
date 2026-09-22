import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scraper = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

assert.match(scraper, /DEFAULT_SCROLL_BATCH_MESSAGES\s*=\s*10/);
assert.match(scraper, /Generic history-backfill policy|history-backfill/);
assert.match(scraper, /scrollConversationUp\(livePage, safeScrollBatchMessages\)/);
assert.match(scraper, /item\.imageUrls\.length\s*>\s*0/);
assert.match(scraper, /\[Репост\/вложенный пост VK\]/);
assert.match(scraper, /VK CHAT VISION|visualText|hasVisualEvidence/);
assert.match(scraper, /hydrateMessageEvidence/);
assert.match(scraper, /richEvidenceHydrated/);

const cheapGate = scraper.indexOf('if (!rawTextCandidate && !rawVisualEvidence && !rawRepostEvidence)');
const hydrateStage = scraper.indexOf("if (typeof hydrateMessageEvidence === 'function')");
const finalGate = scraper.indexOf('if (!textCandidate && !hasVisualEvidence)');
assert.ok(cheapGate >= 0 && hydrateStage > cheapGate, 'obvious chat trash must be rejected before VK/API hydration');
assert.ok(finalGate > hydrateStage, 'repost hydration must still be followed by the strict date/poster AI gate');
assert.match(scraper, /notifyManualSessionClosed\('page-closed'\)/);
assert.match(scraper, /liveMonitorContinues=true/);

assert.match(app, /action:\s*'verify'/);
assert.match(app, /owner-command:tusy-proverit/);
assert.match(app, /EVENT_VERIFIED_SNAPSHOT_FILE/);
assert.match(app, /aiOnRequest=false/);
assert.match(app, /vk-chat-final-close:\$\{peerId\}/);
assert.match(app, /EVENT VERIFY DEFERRED/);
assert.match(app, /VK VISION REPOST IMAGES RESOLVED/);
assert.match(app, /hydrateVkChatMessageEvidence/);
assert.match(app, /add\(direct\)/);
assert.doesNotMatch(app, /rebuildVerifiedPartySnapshotQueued\(\{\s*reason:\s*['"]startup/iu);

console.log('vkChatRichLivePolicyV96.test.mjs: OK');
