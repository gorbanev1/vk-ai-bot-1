import assert from 'node:assert/strict';
import test from 'node:test';

import {
    EVENT_OPERATION_MAX_ATTEMPTS,
    eventRetryDelayMs,
    runEventOperationWithRetries,
} from '../../src/features/events/eventRetry.js';
import {
    fingerprintRemoteImages,
    isRetryableRemoteFingerprintError,
} from '../../src/features/events/sourcePostFingerprint.js';

test('V186 retries a retryable fingerprint operation until the third pass succeeds', async () => {
    const failed = [];
    const recovered = [];
    let calls = 0;

    const result = await runEventOperationWithRetries(
        () => {
            calls += 1;
            if (calls < 3) throw new Error(`HTTP 500 temporary-${calls}`);
            return 'ok';
        },
        {
            label: 'unit-third-pass',
            sleepFn: async () => {},
            logger: { warn() {}, log() {} },
            shouldRetry: isRetryableRemoteFingerprintError,
            onAttemptError: (row) => failed.push(row),
            onRecovered: (row) => recovered.push(row),
        },
    );

    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    assert.deepEqual(failed.map((row) => row.attempt), [1, 2]);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].attempt, 3);
});

test('V186 stops after exactly five retryable HTTP 500 passes', async () => {
    let calls = 0;
    const failed = [];

    await assert.rejects(
        runEventOperationWithRetries(
            () => {
                calls += 1;
                throw new Error('Telegram image fingerprint: HTTP 500');
            },
            {
                label: 'unit-five-pass',
                sleepFn: async () => {},
                logger: { warn() {}, log() {} },
                shouldRetry: isRetryableRemoteFingerprintError,
                onAttemptError: (row) => failed.push(row),
            },
        ),
        (error) => {
            assert.equal(error.eventRetryAttempts, EVENT_OPERATION_MAX_ATTEMPTS);
            assert.equal(error.eventRetryLabel, 'unit-five-pass');
            return true;
        },
    );

    assert.equal(calls, 5);
    assert.deepEqual(failed.map((row) => row.attempt), [1, 2, 3, 4, 5]);
    assert.equal(failed.at(-1).willRetry, false);
});

test('V186 does not waste five passes on a non-retryable HTTP 404', async () => {
    let calls = 0;
    await assert.rejects(
        runEventOperationWithRetries(
            () => {
                calls += 1;
                throw new Error('Telegram image fingerprint: HTTP 404');
            },
            {
                sleepFn: async () => {},
                logger: { warn() {}, log() {} },
                shouldRetry: isRetryableRemoteFingerprintError,
            },
        ),
        /HTTP 404/u,
    );
    assert.equal(calls, 1);
});

test('V186 retry backoff is bounded and monotonic', () => {
    assert.deepEqual(
        [1, 2, 3, 4].map((attempt) => eventRetryDelayMs(attempt)),
        [500, 1000, 2000, 4000],
    );
});

test('V186 fingerprint makes five HTTP 500 passes then returns URL fallback instead of empty list', async () => {
    let calls = 0;
    const failures = [];
    const fallbacks = [];
    const url = 'https://cdn4.telesco.pe/file/example.jpg';

    const fingerprints = await fingerprintRemoteImages({
        imageUrls: [url],
        fetchBuffer: async () => {
            calls += 1;
            throw new Error('Telegram image fingerprint: HTTP 500');
        },
        retrySleepFn: async () => {},
        onAttemptError: (row) => failures.push(row),
        onFallback: (row) => fallbacks.push(row),
    });

    assert.equal(calls, 5);
    assert.equal(failures.length, 5);
    assert.equal(fallbacks.length, 1);
    assert.equal(fingerprints.length, 1);
    assert.equal(fingerprints[0].degraded, true);
    assert.equal(fingerprints[0].fingerprintSource, 'url-fallback-v186');
    assert.equal(fingerprints[0].attempts, 5);
    assert.match(fingerprints[0].visualHash, /^url-fallback:/u);
});

test('V186 fingerprint recovers on pass three without fallback', async () => {
    let calls = 0;
    const recovered = [];
    const fallbacks = [];

    const fingerprints = await fingerprintRemoteImages({
        imageUrls: ['https://example.test/poster.jpg'],
        fetchBuffer: async () => {
            calls += 1;
            if (calls < 3) throw new Error('HTTP 503 temporary CDN error');
            return Buffer.from('poster-binary');
        },
        retrySleepFn: async () => {},
        onRecovered: (row) => recovered.push(row),
        onFallback: (row) => fallbacks.push(row),
    });

    assert.equal(calls, 3);
    assert.equal(fingerprints.length, 1);
    assert.equal(fingerprints[0].degraded, undefined);
    assert.equal(recovered[0].attempt, 3);
    assert.equal(fallbacks.length, 0);
});

test('V186 non-retryable fingerprint error falls back after one pass', async () => {
    let calls = 0;
    const fingerprints = await fingerprintRemoteImages({
        imageUrls: ['https://example.test/missing.jpg'],
        fetchBuffer: async () => {
            calls += 1;
            throw new Error('Telegram image fingerprint: HTTP 404');
        },
        retrySleepFn: async () => {},
    });
    assert.equal(calls, 1);
    assert.equal(fingerprints.length, 1);
    assert.equal(fingerprints[0].attempts, 1);
    assert.equal(fingerprints[0].degraded, true);
});
