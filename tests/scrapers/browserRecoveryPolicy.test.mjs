import assert from 'node:assert/strict';
import { isScraperTargetClosedError } from '../../src/features/scrapers/browserRecoveryPolicy.js';

const positive = [
  'page.waitForTimeout: Target page, context or browser has been closed',
  'browserContext.newPage: Protocol error (Target.createTarget): Failed to open a new tab',
  'browserContext.newPage: Target page, context or browser has been closed',
];
for (const message of positive) {
  assert.equal(isScraperTargetClosedError(new Error(message)), true, message);
}
assert.equal(isScraperTargetClosedError(new Error('HTTP 500')), false);
console.log('browserRecoveryPolicy.test.mjs OK');
