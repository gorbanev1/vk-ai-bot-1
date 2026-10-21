import { parseExternalProviderCommand } from './externalProviderRouting.js';

function clean(value) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim();
}

function normalizeBaseUrl(value, fallback) {
    return clean(value || fallback).replace(/\/+$/u, '');
}

const PLACEHOLDER_MODEL_PATTERN = /^(?:organization\/model-name|org\/model-name|model-name|your-model|example-model|<model>|\{model\}|модель|название-модели)$/iu;
const AUTO_MODEL_PATTERN = /^(?:авто|auto|automatic|автоматически)$/iu;
const FULL_TEST_PATTERN = /^(?:автотест|авто-тест|полный\s+тест|полная\s+проверка|тест\s+(?:все|всё)|full\s*test|smoke\s*test)$/iu;
const DISCOVER_MODEL_PATTERN = /^(?:рабочая\s+модель|найти\s+модель|подобрать\s+модель|discover|find\s+model)$/iu;
const NON_CHAT_MODEL_PATTERN = /(?:embed|embedding|rerank|retriev|vector|guard|safety|moderation|reward|classifier|speech|audio|tts|asr|vision|vlm|detector|parse|clip)/iu;

const PREFERRED_CHAT_MODELS = [
    /^meta\/llama-3\.1-8b-instruct$/iu,
    /^meta\/llama-3\.2-3b-instruct$/iu,
    /^mistralai\/mistral-7b-instruct-v0\.3$/iu,
    /^google\/gemma-3-4b-it$/iu,
    /^nvidia\/nemotron-mini-4b-instruct$/iu,
    /^zyphra\/zamba2-7b-instruct$/iu,
    /^openai\/gpt-oss-20b$/iu,
    /^meta\/llama-3\.3-70b-instruct$/iu,
    /^mistralai\/mistral-large-2-instruct$/iu,
];

export function isPlaceholderModelSelector(value) {
    return PLACEHOLDER_MODEL_PATTERN.test(clean(value));
}

function normalizeProviderName(value) {
    return /^(?:nvidia|нвидиа|энвидиа)$/iu.test(clean(value))
        ? 'nvidia'
        : 'openai';
}

function parseProviderTail(provider, tailValue, options = {}) {
    const tail = clean(tailValue);
    const compact = Boolean(options.compact);
    const direct = Boolean(options.direct);
    const base = {
        matched: true,
        provider,
        ...(compact ? { compact: true } : {}),
    };

    if (!tail) {
        return direct
            ? { ...base, action: 'provider_help' }
            : { ...base, action: 'status' };
    }

    if (/^(?:помощь|help|команды|commands?|все\s+команды|примеры|examples?|готовые\s+команды)$/iu.test(tail)) {
        return direct
            ? { ...base, action: 'provider_help' }
            : { ...base, action: 'examples' };
    }

    if (/^(?:статус|status)$/iu.test(tail)) {
        return { ...base, action: 'status' };
    }

    if (/^(?:проверить|проверка|check)$/iu.test(tail)) {
        return { ...base, action: 'check' };
    }

    if (FULL_TEST_PATTERN.test(tail)) {
        return { ...base, action: 'fulltest' };
    }

    if (DISCOVER_MODEL_PATTERN.test(tail)) {
        return { ...base, action: 'discover' };
    }

    const asksForDescriptions = /модел/iu.test(tail) &&
        /(?:описан|возможност|что\s+уме|назначени|доступн[а-яё]*\s+(?:по\s+)?(?:этому\s+)?(?:api|апи)?\s*ключ)/iu.test(tail);

    if (asksForDescriptions) {
        return {
            ...base,
            action: 'models_described',
            filter: '',
        };
    }

    const models = tail.match(/^(?:доступные\s+)?(?:модели|models)(?:\s+(.*))?$/iu);
    if (models) {
        return {
            ...base,
            action: 'models',
            filter: clean(models[1]),
        };
    }

    const test = tail.match(/^(?:тест|test)(?:\s+(\S+))?$/iu);
    if (test) {
        return {
            ...base,
            action: 'test',
            model: clean(test[1]),
        };
    }

    const ask = tail.match(/^(?:запрос|спросить|ask)\s+(\S+)\s+([\s\S]+)$/iu);
    if (ask) {
        return {
            ...base,
            action: 'ask',
            model: clean(ask[1]),
            prompt: clean(ask[2]),
        };
    }

    const directText = direct
        ? tail.match(/^(?:текст|спроси|ответь)\s+([\s\S]+)$/iu)
        : null;
    if (directText) {
        return {
            ...base,
            action: 'ask',
            model: 'авто',
            prompt: clean(directText[1]),
        };
    }

    if (direct) {
        const fullVisualAudit = tail.match(/^(?:графика|картинки|изображения)\s+(?:полный\s+)?(?:тест|проверка|проверить)\s+(?:все|всё)(?:\s+([\s\S]+))?$/iu);
        if (fullVisualAudit) {
            return {
                ...base,
                action: 'image_audit_all',
                prompt: clean(fullVisualAudit[1]),
            };
        }

        const generationAudit = tail.match(/^(?:(?:графика|картинки|изображения)\s+)?(?:генерация\s+)?(?:тест|проверка|проверить)\s+(?:генерацию\s+)?(?:все|всё)(?:\s+([\s\S]+))?$/iu)
            || tail.match(/^(?:нарисуй|рисуй)\s+(?:всеми|все)\s+(?:моделями|модели)(?:\s+([\s\S]+))?$/iu);
        if (generationAudit) {
            return {
                ...base,
                action: 'image_audit_generation_all',
                prompt: clean(generationAudit[1]),
            };
        }

        const editingAudit = tail.match(/^(?:графика|картинки|изображения)\s+(?:редактирование|редактировать|редактирования)\s+(?:тест|проверка|проверить)\s+(?:все|всё)(?:\s+([\s\S]+))?$/iu)
            || tail.match(/^(?:отредактируй|редактируй|измени)\s+(?:всеми|все)\s+(?:моделями|модели)(?:\s+([\s\S]+))?$/iu);
        if (editingAudit) {
            return {
                ...base,
                action: 'image_audit_edit_all',
                prompt: clean(editingAudit[1]),
            };
        }
    }

    if (direct && /^(?:графика|картинки|изображения)(?:\s+(?:помощь|help))?$/iu.test(tail)) {
        return {
            ...base,
            action: 'image_help',
        };
    }

    if (direct && /^(?:графика|картинки|изображения)\s+(?:модели|models|список)$/iu.test(tail)) {
        return {
            ...base,
            action: 'image_models',
        };
    }

    if (direct && /^(?:графика|картинки|изображения)\s+(?:поток|stream)\s+(?:проверить|проверка|тест|test)$/iu.test(tail)) {
        return {
            ...base,
            action: 'image_stream_test',
            model: 'авто',
            prompt: 'Ночной футуристический город, неоновые вывески, мокрый асфальт, кинематографичный свет, высокая детализация',
        };
    }

    if (direct && /^(?:графика|картинки|изображения)\s+(?:проверить|проверка|тест|test)$/iu.test(tail)) {
        return {
            ...base,
            action: 'image_test',
            model: 'авто',
            prompt: 'Ночной футуристический город, неоновые вывески, мокрый асфальт, кинематографичный свет, высокая детализация',
        };
    }

    const graphicsWithModel = direct
        ? tail.match(/^(?:нарисуй|рисуй|картинка|изображение|сгенерируй\s+(?:картинку|изображение)|создай\s+(?:картинку|изображение))\s+через\s+(\S+)\s+([\s\S]+)$/iu)
        : null;
    if (graphicsWithModel) {
        return {
            ...base,
            action: 'image_generate',
            model: clean(graphicsWithModel[1]),
            prompt: clean(graphicsWithModel[2]),
        };
    }

    const graphics = direct
        ? tail.match(/^(?:нарисуй|рисуй|картинка|изображение|сгенерируй\s+(?:картинку|изображение)|создай\s+(?:картинку|изображение))(?:\s+([\s\S]*))?$/iu)
        : null;
    if (graphics) {
        return {
            ...base,
            action: 'image_generate',
            model: 'авто',
            prompt: clean(graphics[1]),
        };
    }

    if (direct) {
        return {
            ...base,
            action: 'direct_unknown',
            input: tail,
        };
    }

    return {
        ...base,
        action: 'invalid',
    };
}

export function parseProviderCommand(value) {
    const external = parseExternalProviderCommand(value);
    if (external.matched) {
        return { ...external, external: true };
    }

    const text = clean(value);

    if (/^(?:(?:третий|3(?:-?й)?)\s+(?:обход|проход)\s+(?:моделей|ключей|api|апи)|(?:финальный|контрольный)\s+(?:обход|проход|recovery)\s+(?:моделей|ключей|api|апи)|(?:третий|3(?:-?й)?)\s+(?:recovery|рекавери)\s+(?:обход|проход)?)$/iu.test(text)) {
        return { matched: true, action: 'third_recovery_sweep', provider: null };
    }

    if (/^(?:(?:быстр(?:о|ая)|компактн(?:о|ая))\s+(?:проверить|проверка|тест)\s+(?:моделей|ключей(?:\s+и\s+моделей)?)|(?:проверить|проверка|тест)\s+(?:рабочие|живые)\s+(?:модели|ключи(?:\s+и\s+модели)?)|(?:ключи\s+и\s+модели|модели\s+и\s+ключи)\s+(?:проверить|проверка|тест)|(?:проверить|проверка)\s+(?:что\s+)?(?:осталось\s+)?(?:рабочим|рабочее|живым|живое))$/iu.test(text)) {
        return { matched: true, action: 'compact_models_audit', provider: null };
    }

    if (/^(?:(?:тест|проверить|проверка|аудит)\s+(?:всех|все|всё)\s+(?:моделей|модели)|(?:все|всё)\s+(?:модели|моделей)\s+(?:тест|проверить|проверка|аудит)|(?:тест|проверить|проверка|аудит)\s+(?:всех|все|всё)\s+(?:ai|ии)\s+(?:моделей|модели))$/iu.test(text)) {
        return { matched: true, action: 'full_models_audit', provider: null };
    }

    // V85: owner matrix command is a top-level bot command. It must not require
    // an artificial `api`/`ключи` prefix, otherwise it falls through to GPT.
    const directAllGraphicsKeys = text.match(
        /^(?:графика|изображения|картинки)\s+(?:тест|проверка|проверить)\s+(?:все|всё)\s+(?:ключи|ключей|всех\s+ключей)(?:\s+([\s\S]+))?$/iu,
    ) || text.match(
        /^(?:все|всё)\s+(?:графические|графика|изображения|картинки)\s+(?:модели|модель)\s+(?:всех|все|всё)\s+(?:ключей|ключи)(?:\s+([\s\S]+))?$/iu,
    );
    if (directAllGraphicsKeys) {
        return {
            matched: true,
            action: 'all_provider_visual_matrix',
            provider: null,
            prompt: clean(directAllGraphicsKeys[1]),
        };
    }

    const directMatch = text.match(/^(openai|опенаи|nvidia|нвидиа|энвидиа)(?:\s+|$)(.*)$/iu);

    if (directMatch) {
        return parseProviderTail(
            normalizeProviderName(directMatch[1]),
            directMatch[2],
            { compact: true, direct: true },
        );
    }

    const match = text.match(/^(?:api|апи|ключи|провайдеры?)\s*(.*)$/iu);

    if (!match) {
        return { matched: false };
    }

    const body = clean(match[1]);

    const allGraphicsKeys = body.match(/^(?:графика|изображения|картинки)\s+(?:тест|проверка|проверить)\s+(?:все|всё)\s+(?:ключи|ключей)(?:\s+([\s\S]+))?$/iu)
        || body.match(/^(?:все|всё)\s+(?:графические|графика|изображения)\s+(?:модели|модель)\s+(?:все|всех)\s+(?:ключи|ключей)(?:\s+([\s\S]+))?$/iu);
    if (allGraphicsKeys) {
        return { matched: true, action: 'all_provider_visual_matrix', provider: null, prompt: clean(allGraphicsKeys[1]) };
    }

    if (/^(?:проверить|проверка|тест)\s+(?:все|всё|ключи)|^(?:ключи|провайдеры)\s+(?:проверить|проверка|тест)\s*(?:все|всё)?$/iu.test(body)) {
        return {
            matched: true,
            action: 'keys_audit_all',
            provider: null,
        };
    }

    if (!body || /^(?:помощь|help|статус|status)$/iu.test(body)) {
        return {
            matched: true,
            action: 'help',
            provider: null,
        };
    }

    const providerMatch = body.match(/^(openai|опенаи|nvidia|нвидиа|энвидиа)(?:\s+|$)(.*)$/iu);

    if (!providerMatch) {
        return {
            matched: true,
            action: 'invalid',
            provider: null,
        };
    }

    return parseProviderTail(
        normalizeProviderName(providerMatch[1]),
        providerMatch[2],
    );
}

export function getProviderConfig(provider, env = process.env) {
    if (provider === 'nvidia') {
        return {
            id: 'nvidia',
            commandName: 'nvidia',
            label: 'NVIDIA NIM API',
            apiKey: clean(env.NVIDIA_API_KEY),
            baseUrl: normalizeBaseUrl(
                env.NVIDIA_BASE_URL,
                'https://integrate.api.nvidia.com/v1',
            ),
            defaultModel: clean(env.NVIDIA_MODEL_DEFAULT),
        };
    }

    return {
        id: 'openai',
        commandName: 'openai',
        label: 'OpenAI API',
        apiKey: clean(env.OPENAI_DIRECT_API_KEY),
        baseUrl: normalizeBaseUrl(
            env.OPENAI_DIRECT_BASE_URL,
            'https://api.openai.com/v1',
        ),
        defaultModel: clean(env.OPENAI_DIRECT_MODEL),
    };
}

function classifyHttpError(status, payload) {
    const message = clean(
        payload?.error?.message ||
        payload?.message ||
        payload?.detail ||
        payload?.raw ||
        '',
    );

    if (status === 401 || status === 403) {
        return `ключ отклонён (${status})${message ? `: ${message}` : ''}`;
    }

    if (status === 429) {
        return `лимит или квота исчерпаны (429)${message ? `: ${message}` : ''}`;
    }

    return `HTTP ${status}${message ? `: ${message}` : ''}`;
}

async function parseResponse(response) {
    const raw = await response.text();

    try {
        return raw ? JSON.parse(raw) : {};
    } catch {
        return { raw: raw.slice(0, 500) };
    }
}

async function providerFetch(config, path, options = {}) {
    if (!config.apiKey) {
        throw new Error(`${config.label}: ключ не указан в .env.`);
    }

    const startedAt = Date.now();
    const response = await fetch(`${config.baseUrl}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            Accept: 'application/json',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(20_000),
    });
    const payload = await parseResponse(response);

    if (!response.ok) {
        const error = new Error(classifyHttpError(response.status, payload));
        error.status = response.status;
        error.payload = payload;
        error.path = path;
        throw error;
    }

    return {
        payload,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
    };
}

export async function listProviderModels(config) {
    const result = await providerFetch(config, '/models');
    const models = Array.isArray(result.payload?.data)
        ? result.payload.data
            .map((item) => clean(item?.id))
            .filter(Boolean)
        : [];

    return {
        ...result,
        models: [...new Set(models)].sort((a, b) => a.localeCompare(b)),
    };
}

function preferredModelScore(model) {
    const index = PREFERRED_CHAT_MODELS.findIndex((pattern) => pattern.test(model));

    return index < 0
        ? 0
        : 10_000 - index * 100;
}

function modelChatScore(model) {
    const value = clean(model).toLowerCase();
    let score = preferredModelScore(value);

    if (NON_CHAT_MODEL_PATTERN.test(value)) {
        score -= 10_000;
    }

    if (/(?:^|[\/-])(?:llama2|2b|1b)(?:$|[\/-])/iu.test(value)) {
        score -= 90;
    }

    if (/(?:253b|340b|550b|120b|122b|70b|49b|31b)/iu.test(value)) {
        score -= 20;
    }

    const positiveFamilies = [
        ['instruct', 160],
        ['chat', 150],
        ['it', 120],
        ['llama', 90],
        ['mistral', 85],
        ['nemotron', 80],
        ['qwen', 75],
        ['deepseek', 70],
        ['phi', 60],
        ['gemma', 55],
        ['gpt-oss', 50],
    ];

    for (const [token, valueScore] of positiveFamilies) {
        if (value.includes(token)) {
            score += valueScore;
        }
    }

    return score;
}

export function rankLikelyChatModels(models) {
    const catalog = [...new Set((models || []).map(clean).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));

    return [...catalog].sort(
        (left, right) =>
            modelChatScore(right) - modelChatScore(left) ||
            left.localeCompare(right),
    );
}

export function selectLikelyChatModel(models) {
    return rankLikelyChatModels(models)[0] || '';
}

function numberedModelLines(models, selectedModels, limit = 12) {
    const indexByModel = new Map(models.map((model, index) => [model, index + 1]));

    return selectedModels
        .slice(0, limit)
        .map((model) => `#${indexByModel.get(model)} ${model}`);
}

export function resolveProviderModelSelector(models, selector, defaultModel = '') {
    const catalog = [...new Set((models || []).map(clean).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    const requested = clean(selector || defaultModel);

    if (!catalog.length) {
        throw new Error('Список моделей пуст: GET /models не вернул ни одного model id.');
    }

    if (isPlaceholderModelSelector(requested)) {
        throw new Error(
            `«${requested}» — пример-заглушка, а не настоящий model id. Выполни «Гигорейв api nvidia модели» и используй точный id или номер вида #17.`,
        );
    }

    if (!requested || AUTO_MODEL_PATTERN.test(requested)) {
        const model = selectLikelyChatModel(catalog);
        return {
            model,
            source: requested ? 'auto-selector' : defaultModel ? 'default' : 'auto-selector',
            index: catalog.indexOf(model) + 1,
            requested: requested || 'авто',
        };
    }

    const numberMatch = requested.match(/^#?(\d+)$/u);
    if (numberMatch) {
        const index = Number(numberMatch[1]);

        if (!Number.isSafeInteger(index) || index < 1 || index > catalog.length) {
            throw new Error(
                `Номер модели ${requested} вне диапазона. Доступны номера #1–#${catalog.length}.`,
            );
        }

        return {
            model: catalog[index - 1],
            source: 'catalog-number',
            index,
            requested,
        };
    }

    const lower = requested.toLowerCase();
    const exactIndex = catalog.findIndex((model) => model.toLowerCase() === lower);

    if (exactIndex >= 0) {
        return {
            model: catalog[exactIndex],
            source: 'exact-id',
            index: exactIndex + 1,
            requested,
        };
    }

    const matches = catalog.filter((model) => model.toLowerCase().includes(lower));

    if (matches.length === 1) {
        const model = matches[0];
        return {
            model,
            source: 'unique-filter',
            index: catalog.indexOf(model) + 1,
            requested,
        };
    }

    if (matches.length > 1) {
        throw new Error([
            `Фильтр «${requested}» неоднозначен: найдено ${matches.length} моделей.`,
            ...numberedModelLines(catalog, matches),
            'Укажи точный model id или номер #N.',
        ].join('\n'));
    }

    throw new Error([
        `Модель «${requested}» отсутствует в текущем ответе GET /models.`,
        'Выполни «Гигорейв api nvidia модели <часть названия>» и возьми точный id или #N.',
    ].join('\n'));
}

function extractChatText(payload) {
    const content = payload?.choices?.[0]?.message?.content;

    if (typeof content === 'string') {
        return clean(content);
    }

    if (Array.isArray(content)) {
        return clean(
            content
                .map((item) => typeof item === 'string' ? item : item?.text)
                .filter(Boolean)
                .join(' '),
        );
    }

    return '';
}

export async function testProviderChat(
    config,
    model,
    prompt = 'Ответь одним словом: работает',
    options = {},
) {
    const selectedModel = clean(model || config.defaultModel);
    const maxTokens = Number.isSafeInteger(options.maxTokens)
        ? Math.max(16, Math.min(options.maxTokens, 2_000))
        : 500;

    if (!selectedModel) {
        throw new Error(
            `${config.label}: модель не выбрана после проверки каталога.`,
        );
    }

    const result = await providerFetch(config, '/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
            model: selectedModel,
            messages: [
                {
                    role: 'user',
                    content: clean(prompt),
                },
            ],
            ...(config.id === 'openai'
                ? { max_completion_tokens: maxTokens }
                : { max_tokens: maxTokens }),
            stream: false,
        }),
    });

    return {
        ...result,
        model: clean(result.payload?.model) || selectedModel,
        text: extractChatText(result.payload),
    };
}

function shortErrorMessage(error) {
    return clean(error?.message || error).slice(0, 220);
}

export function isModelAvailabilityError(error) {
    const status = Number(error?.status);
    const message = shortErrorMessage(error);

    return status === 404 ||
        ((status === 400 || status === 422) &&
            /(?:model|function|not found|not available|unsupported|does not exist|invalid model)/iu.test(message));
}

export async function findWorkingProviderChatModel(
    config,
    models,
    options = {},
) {
    const catalog = [...new Set((models || []).map(clean).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    const maxAttempts = Number.isSafeInteger(options.maxAttempts)
        ? Math.max(1, Math.min(options.maxAttempts, 40))
        : 20;
    const preferred = clean(options.preferredModel);
    const ranked = rankLikelyChatModels(catalog);
    const candidates = [
        ...(preferred && catalog.includes(preferred) ? [preferred] : []),
        ...ranked,
    ].filter((model, index, all) => all.indexOf(model) === index)
        .slice(0, maxAttempts);
    const attempts = [];

    if (!candidates.length) {
        throw new Error('В каталоге нет подходящих chat/instruct-моделей для автоматической проверки.');
    }

    for (const model of candidates) {
        try {
            const result = await testProviderChat(
                config,
                model,
                options.prompt || 'Ответь ровно двумя символами: OK',
                { maxTokens: 48 },
            );

            return {
                model,
                index: catalog.indexOf(model) + 1,
                result,
                attempts,
            };
        } catch (error) {
            attempts.push({
                model,
                status: Number(error?.status) || null,
                reason: shortErrorMessage(error),
            });

            if (!isModelAvailabilityError(error)) {
                error.modelAttempts = attempts;
                throw error;
            }
        }
    }

    const error = new Error(
        `Не найдена рабочая chat-модель за ${attempts.length} попыток. Ключ и GET /models могут работать, но каталог содержит недоступные для аккаунта функции.`,
    );
    error.status = 404;
    error.modelAttempts = attempts;
    throw error;
}

export const PROVIDER_FULL_TEST_CASES = [
    {
        name: 'точный ответ',
        prompt: 'Ответь ровно одним словом: РАБОТАЕТ',
        maxTokens: 40,
    },
    {
        name: 'арифметика',
        prompt: 'Реши 17 * 24 - 39. Верни только число.',
        maxTokens: 60,
    },
    {
        name: 'JSON',
        prompt: 'Верни только валидный JSON без markdown: {"status":"ok","provider":"nvidia"}',
        maxTokens: 100,
    },
    {
        name: 'перевод',
        prompt: 'Переведи на английский и верни только перевод: Сегодня мы проверяем NVIDIA API.',
        maxTokens: 100,
    },
    {
        name: 'код',
        prompt: 'Напиши компактную функцию JavaScript safeDivide(a,b), которая бросает Error при b===0. Верни только код.',
        maxTokens: 240,
    },
];

export async function runProviderFullTest(config, model) {
    const results = [];

    for (const testCase of PROVIDER_FULL_TEST_CASES) {
        try {
            const result = await testProviderChat(
                config,
                model,
                testCase.prompt,
                { maxTokens: testCase.maxTokens },
            );
            results.push({
                ...testCase,
                ok: true,
                status: result.status,
                elapsedMs: result.elapsedMs,
                text: result.text,
            });
        } catch (error) {
            results.push({
                ...testCase,
                ok: false,
                status: Number(error?.status) || null,
                elapsedMs: null,
                text: shortErrorMessage(error),
            });
        }
    }

    return results;
}

function providerModelSizeLabel(model) {
    const matches = clean(model).match(/(?:^|[\/-])((?:\d+(?:\.\d+)?|\d+x\d+)b)(?=$|[\/-])/iu);
    return matches ? matches[1].toUpperCase() : '';
}

export function describeProviderModel(model) {
    const id = clean(model);
    const value = id.toLowerCase();
    const size = providerModelSizeLabel(id);
    const sizeSuffix = size ? ` Размер/класс: ${size}.` : '';

    if (/(?:video-detector|synthetic-video-detector)/iu.test(value)) {
        return `Детектор видео: выявление синтетического/сгенерированного видео. Специализированный endpoint; не обычный текстовый chat/completions.${sizeSuffix}`;
    }

    if (/(?:guard|safety|content-safety|topic-control|moderation)/iu.test(value)) {
        return `Модель безопасности: модерация, контроль тем и проверка содержимого. Предназначена для классификации/фильтрации, а не для обычного диалога.${sizeSuffix}`;
    }

    if (/(?:reward|calibration)/iu.test(value)) {
        return `Оценочная модель: выставляет score/награду или калибрует ответы. Обычно используется внутри пайплайна, не как чат-бот.${sizeSuffix}`;
    }

    if (/(?:rerank|ranking)/iu.test(value)) {
        return `Реранкер: сортировка найденных документов по релевантности для поиска и RAG. Нужен специализированный ranking endpoint.${sizeSuffix}`;
    }

    if (/(?:embed|embedding|bge-|arctic-embed|retriever)/iu.test(value)) {
        const modality = /(?:vl|vision|image|clip)/iu.test(value)
            ? 'текста и изображений'
            : /code/iu.test(value)
                ? 'исходного кода'
                : 'текста';
        return `Эмбеддинги ${modality}: векторизация, семантический поиск, RAG и сравнение похожести. Обычно вызывается через embeddings/специализированный endpoint, не chat/completions.${sizeSuffix}`;
    }

    if (/(?:parse|deplot)/iu.test(value)) {
        return `Извлечение структуры: разбор документов, изображений, таблиц или графиков в машиночитаемый текст/данные. Может требовать специализированный endpoint.${sizeSuffix}`;
    }

    if (/(?:translate)/iu.test(value)) {
        return `Перевод: многоязычный перевод и преобразование текста между языками. Обычно инструкционный вызов или специализированный endpoint.${sizeSuffix}`;
    }

    if (/(?:vision|vlm|\bvl\b|vila|fuyu|kosmos|neva|omni|nvclip|cosmos|diffusiongemma)/iu.test(value)) {
        const video = /(?:video|cosmos)/iu.test(value);
        return `Мультимодальная модель: анализ ${video ? 'изображений/видео' : 'изображений'} вместе с текстом, визуальные вопросы и извлечение данных. Для изображений нужен мультимодальный формат запроса; простой текстовый тест проверяет не все возможности.${sizeSuffix}`;
    }

    if (/(?:code|coder|starcoder|codestral|codellama|poolside)/iu.test(value)) {
        return `Модель для программирования: генерация, объяснение, рефакторинг и поиск ошибок в коде. Обычно работает через chat/completions.${sizeSuffix}`;
    }

    if (/(?:palmyra-med|medical|\bmed-)/iu.test(value)) {
        return `Медицинская доменная модель: работа с медицинскими текстами и терминологией. Не заменяет врача; обычно вызывается как текстовая instruct/chat-модель.${sizeSuffix}`;
    }

    if (/(?:palmyra-fin|finance|\bfin-)/iu.test(value)) {
        return `Финансовая доменная модель: анализ финансовых текстов, отчётов и терминологии. Обычно работает через chat/completions.${sizeSuffix}`;
    }

    if (/(?:creative)/iu.test(value)) {
        return `Творческая текстовая модель: истории, рекламные тексты, стилизация и идеи. Обычно работает через chat/completions.${sizeSuffix}`;
    }

    if (/(?:reason|thinking|deepseek|gpt-oss|nemotron-3|nemotron-4|glm-|kimi-|step-)/iu.test(value)) {
        return `Текстовая reasoning/instruct-модель: сложные вопросы, анализ, планирование, математика и код. Обычно работает через chat/completions; доступ конкретной функции проверяется командой «тест».${sizeSuffix}`;
    }

    if (/(?:instruct|chat|(?:^|[-/])it(?:$|[-/])|llama|mistral|gemma|jamba|dbrx|yi-large|palmyra|sea-lion|phi-)/iu.test(value)) {
        return `Универсальная текстовая instruct/chat-модель: ответы на вопросы, суммаризация, перевод, классификация и генерация текста. Обычно работает через chat/completions.${sizeSuffix}`;
    }

    return `Специализированная модель из каталога NVIDIA. Назначение нельзя надёжно определить только по model id; endpoint и формат запроса нужно проверять в карточке модели или отдельным тестом.${sizeSuffix}`;
}

export function formatProviderModelsWithDescriptions(config, models, filter = '') {
    const catalog = [...new Set((models || []).map(clean).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    const normalizedFilter = clean(filter).toLowerCase();
    const selected = normalizedFilter
        ? catalog.filter((model) => model.toLowerCase().includes(normalizedFilter))
        : catalog;
    const indexByModel = new Map(catalog.map((model, index) => [model, index + 1]));

    return [
        `${config.label}: GET /models вернул ${catalog.length} моделей; показано ${selected.length}.`,
        'Это модели, видимые данному API-ключу в каталоге. Для chat/completions конкретная функция может требовать отдельного доступа; команда «Гигорейв nvidia рабочая модель» проверяет это реальным POST.',
        '',
        ...(selected.length
            ? selected.flatMap((model) => [
                `#${indexByModel.get(model)} ${model}`,
                `  ${describeProviderModel(model)}`,
            ])
            : ['Совпадений нет.']),
    ].join('\n');
}

export function formatNvidiaCommandGuide() {
    return [
        'NVIDIA — все команды (только владелец)',
        '',
        'Справка:',
        '• Гигорейв nvidia',
        '• Гигорейв нвидиа',
        '• Гигорейв nvidia помощь',
        '• Гигорейв nvidia примеры',
        '',
        'Ключ и каталог:',
        '• Гигорейв nvidia статус',
        '• Гигорейв nvidia проверить',
        '• Гигорейв nvidia модели',
        '• Гигорейв nvidia модели llama',
        '• Гигорейв nvidia доступные по этому апи ключу модели с описанием возможностей каждой',
        '',
        'Автоматические тесты — ничего подставлять не нужно:',
        '• Гигорейв nvidia рабочая модель',
        '• Гигорейв nvidia тест авто',
        '• Гигорейв nvidia полный тест',
        '',
        'Готовые запросы — модель выбирается автоматически:',
        '• Гигорейв nvidia запрос авто Ответь ровно одним словом: работает',
        '• Гигорейв nvidia запрос авто Реши 17 * 24 - 39 и верни только число',
        '• Гигорейв nvidia запрос авто Объясни простыми словами, что такое квантовая запутанность',
        '• Гигорейв nvidia запрос авто Верни только JSON: {"status":"ok","provider":"nvidia"}',
        '• Гигорейв nvidia запрос авто Переведи на английский: Сегодня мы проверяем NVIDIA API',
        '• Гигорейв nvidia запрос авто Напиши функцию JavaScript safeDivide(a,b) с ошибкой при делении на ноль',
        '• Гигорейв nvidia запрос авто Найди ошибку: const values=[1,2,3]; console.log(values[3].toString())',
        '• Гигорейв nvidia запрос авто Сравни REST и WebSocket по задержке и направлению обмена',
        '• Гигорейв nvidia запрос авто Напиши киберпанк-сцену о ночном Воронеже, не больше 100 слов',
        '',
        'Графика NVIDIA — без ручной подстановки:',
        '• Гигорейв nvidia нарисуй ночной Воронеж в стиле киберпанка',
        '• Гигорейв nvidia графика проверить',
        '• Гигорейв nvidia графика поток проверить — диагностика хода запроса в консоли.',
        '• Гигорейв nvidia графика модели',
        '• Гигорейв nvidia нарисуй через flux.1-schnell рыжего кота-космонавта',
        '',
        'Точная текстовая модель или номер из каталога:',
        '• Гигорейв nvidia тест meta/llama-3.1-8b-instruct',
        '• Гигорейв nvidia запрос meta/llama-3.1-8b-instruct Объясни устройство нейросети',
        '• Гигорейв nvidia тест #25',
        '• Гигорейв nvidia запрос #25 Ответь одним предложением: что такое RAG',
        '',
        'Короткие команды nvidia/нвидиа перехватываются напрямую и не отправляются обычной GPT-модели.',
    ].join('\n');
}

export function formatProviderExamples(config, model, modelIndex) {
    const provider = config.commandName || config.id;
    const commandPrefix = `Гигорейв api ${provider}`;
    const selector = model || 'авто';
    const numbered = Number.isSafeInteger(modelIndex) && modelIndex > 0
        ? `#${modelIndex}`
        : selector;

    return [
        `${config.label}: полный набор диагностических команд`,
        '',
        `${commandPrefix} статус`,
        `${commandPrefix} проверить`,
        `${commandPrefix} модели`,
        `${commandPrefix} модели llama`,
        `${commandPrefix} модели nemotron`,
        `${commandPrefix} рабочая модель`,
        `${commandPrefix} тест авто`,
        `${commandPrefix} автотест`,
        `${commandPrefix} полный тест`,
        `${commandPrefix} тест ${numbered}`,
        `${commandPrefix} тест ${selector}`,
        '',
        `Для примеров выбран реальный model id из текущего GET /models: ${selector}`,
        '',
        `${commandPrefix} запрос ${selector} Ответь ровно одним словом: работает`,
        `${commandPrefix} запрос ${selector} Объясни простыми словами, что такое квантовая запутанность`,
        `${commandPrefix} запрос ${selector} Реши по шагам: 17 * 24 - 39`,
        `${commandPrefix} запрос ${selector} Верни только JSON с полями status, answer и confidence для вопроса: Земля вращается вокруг Солнца?`,
        `${commandPrefix} запрос ${selector} Напиши функцию JavaScript safeDivide(a, b) с проверкой деления на ноль и двумя примерами`,
        `${commandPrefix} запрос ${selector} Найди ошибку в коде: const values = [1,2,3]; console.log(values[3].toString())`,
        `${commandPrefix} запрос ${selector} Переведи на английский: Сегодня мы проверяем отдельный NVIDIA API`,
        `${commandPrefix} запрос ${selector} Сожми до двух предложений: Большие языковые модели предсказывают продолжение текста на основе обучающих данных`,
        `${commandPrefix} запрос ${selector} Классифицируй тон сообщения как positive, neutral или negative: Сервис работает, но отвечает медленно`,
        `${commandPrefix} запрос ${selector} Сравни в таблице REST и WebSocket по задержке, направлению обмена и типичным задачам`,
        `${commandPrefix} запрос ${selector} Напиши короткую киберпанк-сцену о ночном Воронеже, не больше 120 слов`,
        '',
        'Можно вместо полного model id использовать номер #N из команды «модели». Номера относятся к полному отсортированному каталогу.',
        'Слово «авто» просит бота выбрать вероятную chat/instruct-модель. Для точной проверки лучше использовать конкретный id.',
    ].join('\n');
}

export function formatProviderHelp() {
    return [
        'Проверка API-провайдеров (только владелец):',
        '• Гигорейв nvidia / Гигорейв нвидиа — короткая NVIDIA-справка со всеми командами и готовыми примерами.',
        '• Гигорейв nvidia доступные по этому апи ключу модели с описанием возможностей каждой — полный каталог с назначением моделей.',
        '• Гигорейв api — статус настроек и общий список команд.',
        '• Гигорейв api openai статус / api nvidia статус — показать отдельную конфигурацию.',
        '• Гигорейв api openai проверить / api nvidia проверить — проверить ключ через GET /models.',
        '• Гигорейв проверить рабочие модели — компактный параллельный live health-check всех ключей/моделей; text stream + non-stream.',
        '• Гигорейв api openai модели [фильтр] / api nvidia модели [фильтр] — показать пронумерованные model id.',
        '• Гигорейв api openai тест [model|#N|авто] / api nvidia тест [model|#N|авто] — короткий POST /chat/completions; «авто» перебирает модели до рабочей.',
        '• Гигорейв api nvidia рабочая модель — самостоятельно найти первую реально доступную chat-модель.',
        '• Гигорейв api nvidia автотест / полный тест — найти рабочую модель и прогнать готовый набор проверок без подстановок.',
        '• Гигорейв api openai запрос <model|#N|авто> <текст> — прямой запрос OpenAI.',
        '• Гигорейв api nvidia запрос <model|#N|авто> <текст> — прямой запрос NVIDIA.',
        '• Гигорейв api openai примеры / api nvidia примеры — готовый набор разнообразных тестов с реальным model id.',
        '• Гигорейв nvidia нарисуй <описание> — NVIDIA Visual генерация с автоматическим перебором доступных image-моделей.',
        '• Гигорейв nvidia графика модели / графика проверить — список Visual endpoints и живой тест с картинкой.',
        '',
        'Строки organization/model-name, model-name и <model> — только примеры-заглушки и теперь отклоняются до запроса к API.',
        'Ключи хранятся только в .env и никогда не должны отправляться в чат.',
    ].join('\n');
}
