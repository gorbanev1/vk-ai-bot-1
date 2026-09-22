import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const versionSource = readFileSync(new URL('../../src/shared/buildVersion.js', import.meta.url), 'utf8');

test('V188.102 Astra Responses transport remains stream-capable', () => {
    assert.match(appSource, /stream: resolvedStreaming/u);
    assert.match(appSource, /Accept: resolvedStreaming \? 'text\/event-stream' : 'application\/json'/u);
    assert.match(appSource, /type === 'response\.output_text\.delta'/u);
    assert.match(appSource, /type === 'response\.completed'/u);
});

test('V188.102 Astra exposes Code Interpreter for model-created files', () => {
    assert.match(appSource, /type: 'code_interpreter'/u);
    assert.match(appSource, /container: \{ type: 'auto', memory_limit: '4g' \}/u);
    assert.match(appSource, /canReturnGeneratedFiles = isAstraModel\(model\)/u);
});

test('V188.102 downloads exact container_file_citation bytes', () => {
    assert.match(appSource, /container_file_citation/u);
    assert.match(appSource, /\/containers\/\$\{encodeURIComponent\(containerId\)\}\/files\/\$\{encodeURIComponent\(fileId\)\}\/content/u);
    assert.match(appSource, /OPENAI_RESPONSE_ARTIFACT_MAX_BYTES/u);
    assert.match(appSource, /OPENAI_RESPONSE_ARTIFACT_MAX_MB/u);
});

test('V188.102 relays generated artifacts as Telegram documents', () => {
    assert.match(appSource, /generatedResponseArtifacts/u);
    assert.match(appSource, /createTelegramDocumentAttachment\(\{[\s\S]*?buffer: artifact\.buffer[\s\S]*?filename: artifact\.filename/u);
    assert.match(appSource, /message: `📎 \$\{artifact\.filename\}`/u);
    assert.match(appSource, /if \(!text && artifactResult\.files\.length\) \{[\s\S]*?text = 'Готово\.'/u);
});

test('V188.102 build version is bumped', () => {
    assert.ok(Number(versionSource.match(/V188\.(\d+)/u)?.[1] ?? -1) >= 102);
});
