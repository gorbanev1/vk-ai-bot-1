import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);
const ephemerisSource = readFileSync(
    new URL('../../src/features/astrology/ephemeris.js', import.meta.url),
    'utf8',
);
const routingSource = readFileSync(
    new URL('../../src/features/astrology/astrologyRouting.js', import.meta.url),
    'utf8',
);

// Технический пакет не публикуется отдельным сообщением в чат.
assert.equal(appSource.includes('🔭 ПРАШНА РАССЧИТАНА'), false);
assert.equal(appSource.includes('🌌 НАТАЛЬНАЯ КАРТА РАССЧИТАНА'), false);
assert.equal(appSource.includes('buildPrashnaTechnicalPreview'), false);
assert.equal(appSource.includes('buildNatalTechnicalPreview'), false);
assert.equal(appSource.includes('[ASTROLOGY PAYLOAD HIDDEN]'), true);
assert.equal(appSource.includes('const responseHeader = visibleTextModelHeader(effectiveResponseModel);'), true);

// Любой локальный маршрут, включая pro, обязан использовать maximum-пакет.
assert.match(routingSource, /packet: localCalculation \? 'maximum' : 'none'/u);
assert.match(routingSource, /explicit-local-maximum/u);
assert.match(appSource, /maximum: astrologyCalculation\.gptPayloadMaximum/u);
assert.match(appSource, /ПАКЕТ_МАКСИМУМ_БЕЗ_УСЕЧЕНИЯ/u);
assert.match(appSource, /АУДИТ_МАКСИМАЛЬНОГО_РАСЧЁТА/u);

// Максимальный пакет включает полный результат вычислителя и аудит покрытия.
assert.match(ephemerisSource, /schema: 'gigorave-jyotish-maximum-v3'/u);
assert.match(ephemerisSource, /function buildMaximumCalculationAudit/u);
assert.match(ephemerisSource, /gptPayloadMaximum: maximumGptPayload/u);
assert.match(ephemerisSource, /pratyantardashaCount/u);
assert.match(ephemerisSource, /harmonicsD1toD60/u);
assert.match(ephemerisSource, /ASTROLOGY_REQUIRE_SWISS_FILES/u);
assert.match(ephemerisSource, /without the shorter LLM profile omissions or silent truncation/u);

console.log('astrologyOutputPolicy tests: OK');
