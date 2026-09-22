import assert from 'node:assert/strict';
import test from 'node:test';
import { __FULL_AI_AUDIT_TESTING__ } from '../../src/features/ai/fullAiAudit.js';

test('V122/V123 transport success does not require exact audit marker', () => {
  const paraphrase = __FULL_AI_AUDIT_TESTING__.auditTextAssessment('Yes, the audit is successful.');
  assert.equal(paraphrase.transportOk, true);
  assert.equal(paraphrase.instructionCompliant, false);
  const exact = __FULL_AI_AUDIT_TESTING__.auditTextAssessment('GIGORAVE_AUDIT_OK');
  assert.equal(exact.transportOk, true);
  assert.equal(exact.instructionCompliant, true);
  const empty = __FULL_AI_AUDIT_TESTING__.auditTextAssessment('   ');
  assert.equal(empty.transportOk, false);
});
