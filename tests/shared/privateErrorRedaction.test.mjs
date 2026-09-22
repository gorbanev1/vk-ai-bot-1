import assert from 'node:assert/strict';
import { formatPrivateError } from '../../src/shared/errors.js';

const rawNvidiaKey = ['nvapi', 'ExampleSecret_1234567890'].join('-');

const directKey = formatPrivateError(
    new Error(`NVIDIA request failed for ${rawNvidiaKey}`),
);
assert.equal(directKey.message.includes(rawNvidiaKey), false);
assert.match(directKey.message, /\[NVIDIA_API_KEY_REDACTED\]/u);

const bearerKey = formatPrivateError(
    new Error(`Authorization: Bearer ${rawNvidiaKey}`),
);
assert.equal(bearerKey.message.includes(rawNvidiaKey), false);
assert.match(bearerKey.message, /\[NVIDIA_API_KEY_REDACTED\]/u);

const envAssignment = formatPrivateError(
    `NVIDIA_API_KEY=${rawNvidiaKey}`,
);
assert.equal(envAssignment.value.includes(rawNvidiaKey), false);
assert.equal(
    envAssignment.value,
    'NVIDIA_API_KEY=[NVIDIA_API_KEY_REDACTED]',
);

const existingOpenAiProtection = formatPrivateError(
    new Error(`Bearer ${['sk', 'ExampleSecret_1234567890'].join('-')}`),
);
assert.match(existingOpenAiProtection.message, /\[API_KEY_REDACTED\]/u);

console.log('Private error redaction tests passed.');
