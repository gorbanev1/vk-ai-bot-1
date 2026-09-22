import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
    COMMAND_ROUTE_PRIORITY,
    COMMAND_MODEL_KEY_COMPATIBILITY_CASES,
    COMMAND_ROUTING_AUDIT_CASES,
    resolveCommandPriority,
    runCommandRoutingAudit,
} from '../../src/features/routing/commandPriorityRouting.js';
import { createPublicEventRangeService } from '../../src/features/events/publicEventRange.js';

const eventRangeService = createPublicEventRangeService({
    timeZone: 'Europe/Moscow',
    now: () => new Date('2026-08-03T12:00:00.000Z'),
});

const options = {
    parsePublicEventsRangeCommand: eventRangeService.parsePublicEventsRangeCommand,
    looksLikePublicEventsQuestion: eventRangeService.looksLikePublicEventsQuestion,
};

function route(input) {
    return resolveCommandPriority(input, options);
}

test('complete built-in routing audit passes', () => {
    const result = runCommandRoutingAudit(options);
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures, null, 2));
    assert.equal(result.passed, result.total);
    assert.equal(
        result.total,
        COMMAND_ROUTING_AUDIT_CASES.length +
            COMMAND_MODEL_KEY_COMPATIBILITY_CASES.length * 2,
    );
    assert.ok(result.total >= 100);
});

test('priority table contains each route once and ends in default', () => {
    assert.equal(new Set(COMMAND_ROUTE_PRIORITY).size, COMMAND_ROUTE_PRIORITY.length);
    assert.equal(COMMAND_ROUTE_PRIORITY.at(-1), 'default');
});



test('model keys before or after every command family never destroy routing', () => {
    for (const [baseInput, expectedRoute, expectedDisposition] of COMMAND_MODEL_KEY_COMPATIBILITY_CASES) {
        for (const input of [`pro3 ${baseInput}`, `${baseInput} pro3`]) {
            const decision = route(input);
            assert.equal(decision.route, expectedRoute, input);
            assert.equal(
                decision.modelSelector.disposition,
                expectedDisposition,
                input,
            );
            assert.equal(decision.explicitMode.mode, 'pro3', input);
        }
    }
});

test('provider IDs containing pro remain intact while an external selector is stripped', () => {
    const exactId = route('nvidia тест deepseek-ai/deepseek-v4-pro');
    assert.equal(exactId.route, 'provider');
    assert.equal(exactId.selected.commandText, 'nvidia тест deepseek-ai/deepseek-v4-pro');

    const prefixed = route('pro3 nvidia проверить');
    assert.equal(prefixed.route, 'provider');
    assert.equal(prefixed.selected.commandText, 'nvidia проверить');
    assert.equal(prefixed.modelSelector.disposition, 'not-applicable');
});

test('provider namespace beats generic GPT model and image commands', () => {
    for (const input of [
        'nvidia запрос авто pro3 объясни RAG',
        'nvidia нарисуй pro3 ночной город',
        'api nvidia тест meta/llama-3.1-8b-instruct',
        'openai запрос авто нарисуй словами кота',
    ]) {
        assert.equal(route(input).route, 'provider', input);
    }
});

test('memory commands beat vision, image generation and model selectors', () => {
    assert.equal(route('запомни pro3 что на картинке').route, 'memory-remember');
    assert.equal(route('забудь нарисуй афишу').route, 'memory-forget');
    assert.equal(route('сканируй базу на запомни').route, 'memory-scan');
});

test('explicit AI actions beat semantic event routing', () => {
    assert.equal(route('нарисуй афишу тус на неделю').route, 'gpt-explicit-action');
    assert.equal(route('рисуй ночной город').route, 'gpt-explicit-action');
    assert.equal(route('pro3 прашна когда будет следующая туса').route, 'gpt-explicit-action');
    assert.equal(route('pro2 резюмируй тусы за неделю').route, 'summary');
    assert.equal(route('gpt pro3 какие тусы могли бы понравиться программисту').route, 'gpt-explicit-action');
});

test('deterministic event command wins over a bare model alias but records suppression', () => {
    const decision = route('pro3 тусы на этой неделе');
    assert.equal(decision.route, 'public-events-direct');
    assert.equal(decision.selected.suppressedExplicitMode, 'pro3');
    assert.ok(decision.suppressedRoutes.includes('gpt-explicit-selector'));
});

test('semantic event classifier never beats explicit model selector', () => {
    const decision = route('pro3 почему афиша выглядит странно');
    assert.equal(decision.route, 'gpt-explicit-selector');
    assert.ok(decision.suppressedRoutes.includes('public-events-semantic'));
});

test('all local commands are routed before default GPT', () => {
    const cases = new Map([
        ['помощь', 'help'],
        ['/help', 'help'],
        ['версия', 'version'],
        ['/версия', 'version'],
        ['пинг', 'ping'],
        ['id', 'id'],
        ['статистика', 'stats'],
        ['досье Иван', 'dossier'],
        ['лимиты сбросить', 'rate-limit-reset'],
        ['парсер статус', 'source-status'],
        ['парсер бесед стоп', 'vk-chat-stop'],
    ]);
    for (const [input, expected] of cases) {
        assert.equal(route(input).route, expected, input);
    }
});

test('every declared route has an explicit orchestrator handler', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );

    for (const routeName of COMMAND_ROUTE_PRIORITY) {
        if (routeName === 'default') continue;
        assert.match(
            source,
            new RegExp(`routeDecision\\.route === ['\"]${routeName}['\"]`, 'u'),
            routeName,
        );
    }
    assert.match(source, /routeDecision\.route === 'default'/u);
});

test('orchestrator uses centralized routing before semantic and default handlers', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /resolveCommandPriority\(requestText/u);
    assert.match(source, /\[COMMAND ROUTE\]/u);
    assert.match(source, /routeDecision\.route === 'public-events-semantic'/u);
    assert.match(source, /routeDecision\.route === 'gpt-explicit-selector'/u);
    assert.ok(
        source.indexOf("routeDecision.route === 'gpt-explicit-selector'") <
        source.indexOf("routeDecision.route === 'public-events-semantic'"),
    );
});

test('direct bot interactions bypass autonomous banter on both platforms', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /\[AUTONOMOUS ROUTE BYPASS\]/u);
    assert.match(source, /platform=vk/u);
    assert.match(source, /platform=telegram/u);
    assert.match(source, /if \(!directBotInteraction\) \{\s*if \(await handleActiveCommunicationBanter/su);
});
