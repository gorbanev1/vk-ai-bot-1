import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseEventModerationCommand } from '../../src/features/events/eventModerationRouting.js';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const browser = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');

test('event Vision and text HTTP requests retain owner cancellation but have no bot deadline', () => {
  const vision = app.slice(app.indexOf('async function generateOpenAIVisionTextCore('), app.indexOf('async function generateOpenAIVisionText('));
  const textStart = app.indexOf('async function generateOpenAITextCoreAttempt(');
  const text = app.slice(textStart, textStart + 21000);
  for (const source of [vision, text]) {
    assert.ok(source.includes("/^event(?:-|:)/u.test(String(tokenUsageOperation || ''))"));
    assert.match(source, /getCurrentOperationSignal\(\) \|\| undefined/u);
  }
});

test('upstream 403 changes model/key instead of restarting same model in another transport', () => {
  const start = app.indexOf('function isTransportModeRetryError(error) {');
  const end = app.indexOf('\nasync function generateOpenAITextCore(options)', start);
  assert.ok(start > 0 && end > start);
  const ctx = vm.createContext({
    isEmptyModelTextError: () => false,
    isTechnicalModelFailure: () => false,
    isRetryableOpenAITextError: () => false,
  });
  vm.runInContext(app.slice(start, end), ctx);
  assert.equal(vm.runInContext("isTransportModeRetryError(new Error('GPT API 403: upstream provider refused'))", ctx), false);
  assert.equal(vm.runInContext("isTransportModeRetryError(new Error('GPT API 524: proxy read timeout'))", ctx), true);
});

test('future cards have two independently routed modes and a real capture-before-AI queue', () => {
  assert.equal(parseEventModerationCommand('тусы обновить будущие')?.onlyMissingPoster, false);
  assert.equal(parseEventModerationCommand('тусы обновить будущие бф')?.onlyMissingPoster, true);
  assert.equal(parseEventModerationCommand('тусы обновить будущие безфото')?.onlyMissingPoster, true);
  const start = app.indexOf('async function runUpcomingEventRefreshPipelinedV188147(');
  const end = app.indexOf('\nasync function runStoredEventLinkRefreshV188145(', start);
  const flow = app.slice(start, end);
  assert.match(flow, /noMinimumDwell: true/u);
  assert.match(flow, /5_000 \+ Math\.floor\(Math\.random\(\) \* 11_001\)/u);
  assert.match(flow, /renameSync\(temporary, cacheFile\)/u);
  assert.match(flow, /await runAiQueued\(\(\) => analyzeCaptured/u);
  assert.match(flow, /onlyIfMissingPoster: onlyMissingPoster/u);
  assert.match(browser, /minimumOpenMs === 0/u);
});
