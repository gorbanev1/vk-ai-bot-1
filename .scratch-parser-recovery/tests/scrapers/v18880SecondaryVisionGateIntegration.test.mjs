import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const vk = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const tg = readFileSync(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8');

test('secondary sources only enqueue poster vision after deterministic semantic-text gate', () => {
  for (const source of [vk, tg]) {
    assert.match(source, /secondaryTextGate\?\.visionEligible/);
    assert.match(source, /secondaryJointGate:\s*secondaryMode/);
    assert.match(source, /sourceText:\s*String\(post\?\.text/);
    assert.match(source, /clean-mode-content-metadata-known-97/);
    assert.match(source, /threshold:\s*0\.97/);
    assert.match(source, /item\.final-decision/);
  }
});

test('joint poster gate receives semantic text and explicit joint announcement decision', () => {
  assert.match(app, /secondaryJointGate:\s*Boolean\(request\.secondaryJointGate\)/);
  assert.match(app, /sourceText:\s*String\(request\.sourceText/);
  assert.match(app, /Совокупность текста и картинки является анонсом: да\/нет/);
  assert.match(app, /SECONDARY_PARTY_AUTO_TASK_KEY/);
  assert.match(app, /parser-all-clean:secondary:auto/);
  assert.match(app, /similarityThreshold:\s*0\.97/);
});
