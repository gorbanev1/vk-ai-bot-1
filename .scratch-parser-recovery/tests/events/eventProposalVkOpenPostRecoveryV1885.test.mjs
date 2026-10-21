import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyEventSourceUrl } from '../../src/features/events/eventSourceLink.js';

for (const url of [
    'https://vk.ru/wall-123_456',
    'https://vk.com/club123?w=wall-123_456',
    'https://vk.ru/public123?z=wall-123_456',
]) {
    const result = classifyEventSourceUrl(url);
    assert.equal(result.platform, 'vk');
    assert.equal(result.exactPost, true, url);
    assert.equal(result.ownerId, -123, url);
    assert.equal(result.postId, 456, url);
}

const browserSource = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');
assert.match(browserSource, /exact-visible-/u);
assert.match(browserSource, /vk-modal-dialog/u);
assert.match(browserSource, /currentPostToken/u);

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const proposalStart = appSource.indexOf('async function parseEventProposalSubmission');
const proposalEnd = appSource.indexOf('const EVENT_PROPOSAL_FIELD_LABELS', proposalStart);
const proposalSource = appSource.slice(proposalStart, proposalEnd);
assert.doesNotMatch(proposalSource, /if \(openAIApiKey\)/u);
assert.match(proposalSource, /runtimeModelCredentials\.length/u);

const defaultGptStart = appSource.indexOf('async function generateDefaultGptText');
const defaultGptEnd = appSource.indexOf('const VISION_IMAGE_MAX_COUNT', defaultGptStart);
const defaultGptSource = appSource.slice(defaultGptStart, defaultGptEnd);
assert.doesNotMatch(defaultGptSource, /if \(!openAIApiKey\)/u);
assert.match(defaultGptSource, /runtimeModelCredentials\.length/u);

console.log('event proposal VK open-post recovery V1885 tests: ok');
