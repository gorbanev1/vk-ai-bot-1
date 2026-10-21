import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    describeProviderModel,
    findWorkingProviderChatModel,
    formatNvidiaCommandGuide,
    formatProviderExamples,
    formatProviderModelsWithDescriptions,
    getProviderConfig,
    isPlaceholderModelSelector,
    parseProviderCommand,
    resolveProviderModelSelector,
    runProviderFullTest,
    selectLikelyChatModel,
} from '../../src/features/ai/providerDiagnostics.js';

test('provider commands identify OpenAI and NVIDIA separately', () => {
    assert.deepEqual(
        parseProviderCommand('api openai проверить'),
        {
            matched: true,
            action: 'check',
            provider: 'openai',
        },
    );

    assert.deepEqual(
        parseProviderCommand('api nvidia проверить'),
        {
            matched: true,
            action: 'check',
            provider: 'nvidia',
        },
    );
});



test('short NVIDIA aliases open help directly without the GPT router', () => {
    for (const value of ['nvidia', 'нвидиа', 'энвидиа', 'nvidia помощь', 'нвидиа примеры']) {
        assert.deepEqual(
            parseProviderCommand(value),
            {
                matched: true,
                provider: 'nvidia',
                compact: true,
                action: 'provider_help',
            },
            value,
        );
    }

    const guide = formatNvidiaCommandGuide();
    assert.match(guide, /Гигорейв nvidia полный тест/u);
    assert.match(guide, /Гигорейв nvidia запрос авто/u);
    assert.match(guide, /доступные по этому апи ключу модели с описанием/u);
});



test('direct NVIDIA graphics are routed to real Visual generation', () => {
    assert.deepEqual(
        parseProviderCommand('nvidia нарисуй ночной Воронеж в стиле киберпанка'),
        {
            matched: true,
            provider: 'nvidia',
            compact: true,
            action: 'image_generate',
            model: 'авто',
            prompt: 'ночной Воронеж в стиле киберпанка',
        },
    );

    assert.deepEqual(
        parseProviderCommand('nvidia нарисуй через flux.1-schnell рыжего кота-космонавта'),
        {
            matched: true,
            provider: 'nvidia',
            compact: true,
            action: 'image_generate',
            model: 'flux.1-schnell',
            prompt: 'рыжего кота-космонавта',
        },
    );

    assert.deepEqual(
        parseProviderCommand('nvidia графика модели'),
        {
            matched: true,
            provider: 'nvidia',
            compact: true,
            action: 'image_models',
        },
    );

    assert.equal(
        parseProviderCommand('nvidia графика проверить').action,
        'image_test',
    );

    assert.deepEqual(
        parseProviderCommand('нвидиа сделай что-нибудь странное'),
        {
            matched: true,
            provider: 'nvidia',
            compact: true,
            action: 'direct_unknown',
            input: 'сделай что-нибудь странное',
        },
    );

    assert.deepEqual(
        parseProviderCommand('nvidia текст Объясни RAG одним абзацем'),
        {
            matched: true,
            provider: 'nvidia',
            compact: true,
            action: 'ask',
            model: 'авто',
            prompt: 'Объясни RAG одним абзацем',
        },
    );
});

test('application performs NVIDIA Visual generation and keeps unknown fallback short', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );

    assert.match(source, /events-v\d+-[a-z0-9-]+/u);
    assert.match(source, /generateNvidiaVisualImage/u);
    assert.match(source, /NVIDIA IMAGE GENERATED/u);
    assert.match(source, /Запрос не отправлен ни в NVIDIA, ни в обычный GPT/u);
    assert.doesNotMatch(source, /NVIDIA-графика в этой сборке не подключена/u);
});

test('natural NVIDIA catalog request asks for descriptions of every visible model', () => {
    assert.deepEqual(
        parseProviderCommand('nvidia доступные по этому апи ключу модели с описанием возможностей каждой'),
        {
            matched: true,
            provider: 'nvidia',
            compact: true,
            action: 'models_described',
            filter: '',
        },
    );

    assert.deepEqual(
        parseProviderCommand('нвидиа модели с описанием возможностей каждой'),
        {
            matched: true,
            provider: 'nvidia',
            compact: true,
            action: 'models_described',
            filter: '',
        },
    );
});

test('model capability descriptions distinguish chat, code, vision, embeddings and safety', () => {
    assert.match(describeProviderModel('meta/llama-3.1-8b-instruct'), /instruct\/chat-модель/u);
    assert.match(describeProviderModel('bigcode/starcoder2-15b'), /программирования/u);
    assert.match(describeProviderModel('meta/llama-3.2-11b-vision-instruct'), /Мультимодальная/u);
    assert.match(describeProviderModel('baai/bge-m3'), /Эмбеддинги/u);
    assert.match(describeProviderModel('meta/llama-guard-4-12b'), /безопасности/u);
});

test('described catalog keeps global model numbers and explains endpoint limits', () => {
    const config = getProviderConfig('nvidia', { NVIDIA_API_KEY: 'secret' });
    const output = formatProviderModelsWithDescriptions(config, [
        'baai/bge-m3',
        'meta/llama-3.1-8b-instruct',
    ]);

    assert.match(output, /#1 baai\/bge-m3/u);
    assert.match(output, /#2 meta\/llama-3\.1-8b-instruct/u);
    assert.match(output, /видимые данному API-ключу/u);
    assert.match(output, /рабочая модель/u);
});

test('provider model and prompt commands preserve explicit model selector', () => {
    assert.deepEqual(
        parseProviderCommand('api nvidia модели nemotron'),
        {
            matched: true,
            action: 'models',
            provider: 'nvidia',
            filter: 'nemotron',
        },
    );

    assert.deepEqual(
        parseProviderCommand('api openai запрос gpt-test Ответь привет'),
        {
            matched: true,
            action: 'ask',
            provider: 'openai',
            model: 'gpt-test',
            prompt: 'Ответь привет',
        },
    );

    assert.deepEqual(
        parseProviderCommand('api nvidia тест #17'),
        {
            matched: true,
            action: 'test',
            provider: 'nvidia',
            model: '#17',
        },
    );

    assert.deepEqual(
        parseProviderCommand('api nvidia примеры'),
        {
            matched: true,
            action: 'examples',
            provider: 'nvidia',
        },
    );
});

test('provider configs are isolated and use official default endpoints', () => {
    const env = {
        OPENAI_DIRECT_API_KEY: 'openai-secret',
        NVIDIA_API_KEY: 'nvidia-secret',
    };
    const openai = getProviderConfig('openai', env);
    const nvidia = getProviderConfig('nvidia', env);

    assert.equal(openai.apiKey, 'openai-secret');
    assert.equal(openai.baseUrl, 'https://api.openai.com/v1');
    assert.equal(nvidia.apiKey, 'nvidia-secret');
    assert.equal(nvidia.baseUrl, 'https://integrate.api.nvidia.com/v1');
});

test('placeholder model names are rejected before an API request', () => {
    for (const value of [
        'organization/model-name',
        'model-name',
        '<model>',
        'your-model',
    ]) {
        assert.equal(isPlaceholderModelSelector(value), true, value);
        assert.throws(
            () => resolveProviderModelSelector(
                ['meta/llama-3.1-8b-instruct'],
                value,
            ),
            /пример-заглушка/u,
        );
    }
});

test('model selector supports exact ids, global #N numbers and unique filters', () => {
    const models = [
        'nvidia/nv-embedqa-e5-v5',
        'meta/llama-3.1-8b-instruct',
        'nvidia/llama-3.1-nemotron-70b-instruct',
    ];
    const sorted = [...models].sort((a, b) => a.localeCompare(b));

    const exact = resolveProviderModelSelector(
        models,
        'meta/llama-3.1-8b-instruct',
    );
    assert.equal(exact.model, 'meta/llama-3.1-8b-instruct');
    assert.equal(exact.source, 'exact-id');

    const numbered = resolveProviderModelSelector(models, '#2');
    assert.equal(numbered.model, sorted[1]);
    assert.equal(numbered.source, 'catalog-number');

    const filtered = resolveProviderModelSelector(models, 'nemotron-70b');
    assert.equal(filtered.model, 'nvidia/llama-3.1-nemotron-70b-instruct');
    assert.equal(filtered.source, 'unique-filter');
});

test('auto selection prefers a likely chat model over embeddings', () => {
    const models = [
        'nvidia/nv-embedqa-e5-v5',
        'meta/llama-3.1-8b-instruct',
        'nvidia/llama-3.1-nemotron-70b-instruct',
    ];
    const selected = selectLikelyChatModel(models);

    assert.equal(selected, 'meta/llama-3.1-8b-instruct');
    assert.equal(
        resolveProviderModelSelector(models, 'авто').model,
        selected,
    );
});

test('ambiguous filters explain how to select a concrete model', () => {
    assert.throws(
        () => resolveProviderModelSelector(
            [
                'meta/llama-3.1-8b-instruct',
                'meta/llama-3.1-70b-instruct',
            ],
            'llama-3.1',
        ),
        /неоднозначен[\s\S]*#1[\s\S]*#2[\s\S]*точный model id/u,
    );
});

test('NVIDIA examples contain a real catalog id and no placeholder model', () => {
    const config = getProviderConfig('nvidia', {
        NVIDIA_API_KEY: 'secret',
    });
    const output = formatProviderExamples(
        config,
        'meta/llama-3.1-8b-instruct',
        7,
    );

    assert.match(output, /api nvidia тест #7/u);
    assert.match(output, /api nvidia запрос meta\/llama-3\.1-8b-instruct/u);
    assert.doesNotMatch(output, /organization\/model-name/u);
});


test('application distinguishes a working catalog key from chat endpoint 404', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );

    assert.match(source, /Авторизация подтверждена отдельно: GET \/models вернул HTTP 200/u);
    assert.match(source, /NVIDIA-ключ работает\. Общий каталог содержит модели\/функции/u);
    assert.match(source, /catalogVerified=/u);
});


test('full NVIDIA autotest commands need no model substitution', () => {
    assert.deepEqual(
        parseProviderCommand('api nvidia автотест'),
        {
            matched: true,
            action: 'fulltest',
            provider: 'nvidia',
        },
    );

    assert.deepEqual(
        parseProviderCommand('api nvidia полный тест'),
        {
            matched: true,
            action: 'fulltest',
            provider: 'nvidia',
        },
    );

    assert.deepEqual(
        parseProviderCommand('api nvidia рабочая модель'),
        {
            matched: true,
            action: 'discover',
            provider: 'nvidia',
        },
    );
});

test('automatic model probing skips account-specific 404 and returns the next working model', async () => {
    const originalFetch = globalThis.fetch;
    const requestedModels = [];

    globalThis.fetch = async (_url, options = {}) => {
        const body = JSON.parse(options.body);
        requestedModels.push(body.model);

        if (body.model === 'meta/llama-3.1-8b-instruct') {
            return new Response(JSON.stringify({
                error: {
                    message: "Function 'deadbeef': Not found for account 'test'",
                },
            }), {
                status: 404,
                headers: { 'content-type': 'application/json' },
            });
        }

        return new Response(JSON.stringify({
            model: body.model,
            choices: [
                {
                    message: {
                        content: 'OK',
                    },
                },
            ],
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    try {
        const config = getProviderConfig('nvidia', {
            NVIDIA_API_KEY: 'secret',
        });
        const result = await findWorkingProviderChatModel(
            config,
            [
                'meta/llama-3.1-8b-instruct',
                'meta/llama-3.2-3b-instruct',
            ],
            { maxAttempts: 2 },
        );

        assert.equal(result.model, 'meta/llama-3.2-3b-instruct');
        assert.equal(result.attempts.length, 1);
        assert.deepEqual(requestedModels, [
            'meta/llama-3.1-8b-instruct',
            'meta/llama-3.2-3b-instruct',
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('full provider test runs a fixed suite without user-supplied prompts', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;

    globalThis.fetch = async (_url, options = {}) => {
        calls += 1;
        const body = JSON.parse(options.body);

        return new Response(JSON.stringify({
            model: body.model,
            choices: [
                {
                    message: {
                        content: `answer-${calls}`,
                    },
                },
            ],
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    try {
        const config = getProviderConfig('nvidia', {
            NVIDIA_API_KEY: 'secret',
        });
        const results = await runProviderFullTest(
            config,
            'meta/llama-3.2-3b-instruct',
        );

        assert.equal(results.length, 5);
        assert.equal(results.every((item) => item.ok), true);
        assert.equal(calls, 5);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('application fulltest reports the working model and skipped 404 models', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );

    assert.match(source, /events-v\d+-[a-z0-9-]+/u);
    assert.match(source, /перебираю chat\/instruct-модели до первой/u);
    assert.match(source, /Недоступные модели, пропущенные автоматически/u);
    assert.match(source, /Запускаю пять готовых тестов/u);
});


test('V85 direct all-provider graphics matrix command never falls through to GPT', () => {
    assert.deepEqual(
        parseProviderCommand('графика тест все ключи cinematic black cat on a rainy neon street, full body, no text'),
        {
            matched: true,
            action: 'all_provider_visual_matrix',
            provider: null,
            prompt: 'cinematic black cat on a rainy neon street, full body, no text',
        },
    );
    assert.equal(
        parseProviderCommand('графика проверить всё всех ключей same prompt').action,
        'all_provider_visual_matrix',
    );
});
