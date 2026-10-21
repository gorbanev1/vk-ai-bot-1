import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExternalProviderCommand } from '../../src/features/ai/externalProviderRouting.js';
import { parseProviderCommand } from '../../src/features/ai/providerDiagnostics.js';

test('routes Gemini/Claude/Groq/HF namespaces before ordinary GPT', () => {
  assert.equal(parseProviderCommand('openai-pool модели').provider, 'openai');
  assert.deepEqual(parseExternalProviderCommand('gemini модели'), { matched: true, provider: 'gemini', action: 'models' });
  assert.equal(parseProviderCommand('claude расскажи про CUDA').external, true);
  assert.equal(parseProviderCommand('groq через openai/gpt-oss-120b привет').action, 'ask');
  assert.deepEqual(parseExternalProviderCommand('grok модели'), { matched: true, provider: 'xai', action: 'models' });
  assert.equal(parseProviderCommand('hf проверить').provider, 'huggingface');
});
