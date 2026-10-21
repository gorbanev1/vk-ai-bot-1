import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeParserVisionReports } from '../../src/features/scrapers/parserVisionCounts.js';

test('parser Vision report combines image counts from both phases', () => {
  const summary = summarizeParserVisionReports([
    { totalRequests: 2, completedRequests: 2, images: { planned: 5, recognized: 5, announcements: 2, unprocessed: 0 } },
    { totalRequests: 4, completedRequests: 4, failedRequests: 1, cacheHits: 1, images: { planned: 13, recognized: 11, announcements: 4, unprocessed: 2 } },
  ]);

  assert.equal(summary.requests, 6);
  assert.equal(summary.completedRequests, 6);
  assert.equal(summary.failedRequests, 1);
  assert.equal(summary.cacheHits, 1);
  assert.deepEqual(summary.images, { planned: 18, recognized: 16, announcements: 6, unprocessed: 2 });
  assert.equal(summary.phases.length, 2);
});

test('parser Vision report treats missing and invalid counts as zero', () => {
  const summary = summarizeParserVisionReports([null, { images: { planned: 'bad', recognized: 2 } }]);

  assert.equal(summary.phases.length, 1);
  assert.deepEqual(summary.images, { planned: 0, recognized: 2, announcements: 0, unprocessed: 0 });
});
