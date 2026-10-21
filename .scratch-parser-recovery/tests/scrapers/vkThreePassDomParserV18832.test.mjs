import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const chat = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
const publicScraper = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

function section(source, start, end) {
    const from = source.indexOf(start);
    assert.notEqual(from, -1, `missing section start: ${start}`);
    const to = end ? source.indexOf(end, from + start.length) : source.length;
    assert.notEqual(to, -1, `missing section end: ${end}`);
    return source.slice(from, to);
}

test('exact pass follows the supplied current VK Messenger DOM contract', () => {
    const extract = section(chat, 'async function extractRenderedMessages', 'async function scrollConversationUp');
    assert.match(chat, /vk-chat-diagnostic-priority-v18836/u);
    assert.match(extract, /const PASS_EXACT = 'pass1-exact'/u);
    assert.match(extract, /\.ConvoHistory \.VirtualScrollItem\[data-itemkey\] > \.ConvoHistory__messageBlock/u);
    assert.match(extract, /\.ConvoHistory__scrollbar\[data-scrollbar="scrollable"\]/u);
    assert.match(extract, /current\.dataset\?\.itemkey/u);
});

test('adaptive pass survives moderate class drift and can use bounded React metadata', () => {
    const extract = section(chat, 'async function extractRenderedMessages', 'async function scrollConversationUp');
    assert.match(extract, /const PASS_ADAPTIVE = 'pass2-adaptive'/u);
    assert.match(extract, /collectReactMetadata/u);
    assert.match(extract, /conversationmessageid\|cmid/u);
    assert.match(extract, /Number\(item\.peerId\) === Number\(targetPeerId\)/u);
});

test('heuristic pass is based on repeated structural content blocks, not class names', () => {
    const extract = section(chat, 'async function extractRenderedMessages', 'async function scrollConversationUp');
    assert.match(extract, /const PASS_HEURISTIC = 'pass3-heuristic'/u);
    assert.match(extract, /discoverRepeatedContentRoots/u);
    assert.match(extract, /repeatedBlockSignature/u);
    assert.match(extract, /repeatedBlockEvidence/u);
    assert.match(extract, /group\.length < 3/u);
    assert.match(extract, /message\|msg\|convo\|chat\|post\|item\|row/u); // weak bonus only
});

test('chat media ignores UI images and admits poster-sized generic media', () => {
    const extract = section(chat, 'async function extractRenderedMessages', 'async function scrollConversationUp');
    assert.match(extract, /avatar\|profile\|emoji\|reaction\|sticker\|icon\|badge\|logo\|favicon\|smile/u);
    assert.match(extract, /w >= 300 && h >= 300/u);
    assert.match(extract, /embeddedNodeDepth/u);
    assert.match(extract, /data-post-nesting-lvl/u);
});

test('public parser has exact/adaptive/heuristic container stages and deepest repost text', () => {
    const extract = section(publicScraper, 'async function extractRenderedVkPosts', 'async function primeLatestVkPostMedia');
    assert.match(extract, /pass1-exact/u);
    assert.match(extract, /pass2-adaptive/u);
    assert.match(extract, /pass3-heuristic/u);
    assert.match(extract, /repeatedSiblingCount/u);
    assert.match(extract, /genericContainerScore/u);
    assert.match(extract, /data-post-nesting-lvl/u);
    assert.match(extract, /deepestNestedText/u);
});

test('public media capture is lossless across outer and nested repost layers', () => {
    const exact = section(publicScraper, 'export async function extractExactVkPostsFromDomSnapshot', 'async function extractRenderedVkPosts');
    const rendered = section(publicScraper, 'async function extractRenderedVkPosts', 'async function primeLatestVkPostMedia');
    assert.match(exact, /origin: 'repost-wall'/u);
    assert.match(exact, /origin: 'outer-message'/u);
    assert.match(rendered, /nested-primary/u);
    assert.match(rendered, /outer-primary/u);
    assert.match(rendered, /origin: candidate\.mediaHint\.startsWith\('nested-'\) \? 'repost-wall' : 'outer-message'/u);
    assert.doesNotMatch(rendered, /hasOwnedAnnouncementMedia/u);
});


test('AI dedupe skips only exact text that already produced an announcement', () => {
    const chatProcess = section(chat, 'async function processMessage', 'export function createVkChatEventScraper');
    const publicProcess = section(publicScraper, 'async function processPost', 'export function createVkPublicScraper');
    assert.match(chatProcess, /exactKnownAnnouncementText/u);
    assert.match(chatProcess, /Number\(previous\?\.eventCount \?\? 0\) > 0/u);
    assert.match(chatProcess, /previous\?\.rawText/u);
    assert.doesNotMatch(chatProcess, /previous\?\.contentHash === contentHash/u);
    assert.match(publicProcess, /previous-pass-produced-no-announcement/u);
    assert.match(publicProcess, /!exactKnownAnnouncementText/u);
    assert.doesNotMatch(publicProcess, /nearDuplicateText && !imageChanged \? 'unchanged-near-duplicate'/u);
});

test('scroll locator itself has exact, adaptive, and heuristic stages', () => {
    const scroll = section(chat, 'async function scrollConversationUp', 'function isTransientBrowserError');
    assert.match(scroll, /pass1-exact-scroll/u);
    assert.match(scroll, /pass2-adaptive-scroll/u);
    assert.match(scroll, /pass3-heuristic-scroll/u);
    assert.match(scroll, /data-scrollbar="scrollable"/u);
    assert.match(scroll, /WheelEvent/u);
});

test('release identity is wired into package and bot build', () => {
    assert.match(pkg.version, /^0\.188\./u);
    assert.match(app, /events-v1886[01]-/u);
});
