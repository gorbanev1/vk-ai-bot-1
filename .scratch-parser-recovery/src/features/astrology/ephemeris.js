/**
 * Локальный расчёт джйотиш через Swiss Ephemeris/Moshier. Большой математический модуль без платформенной логики.
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_LATITUDE = 51.6608;
const DEFAULT_LONGITUDE = 39.2003;
const DEFAULT_ALTITUDE_METERS = 154;
const DEFAULT_LOCATION_NAME = 'Воронеж';
const DEFAULT_PRESSURE_HPA = 1013.25;
const DEFAULT_TEMPERATURE_C = 15;
const SECONDS_PER_DAY = 86400;
const NAKSHATRA_SIZE = 360 / 27;

const RASHI_NAMES = [
    'Овен', 'Телец', 'Близнецы', 'Рак', 'Лев', 'Дева',
    'Весы', 'Скорпион', 'Стрелец', 'Козерог', 'Водолей', 'Рыбы',
];

const RASHI_LORDS = [
    'Марс', 'Венера', 'Меркурий', 'Луна', 'Солнце', 'Меркурий',
    'Венера', 'Марс', 'Юпитер', 'Сатурн', 'Сатурн', 'Юпитер',
];

const NAKSHATRA_NAMES = [
    'Ашвини', 'Бхарани', 'Криттика', 'Рохини', 'Мригашира', 'Ардра',
    'Пунарвасу', 'Пушья', 'Ашлеша', 'Магха', 'Пурва-Пхалгуни',
    'Уттара-Пхалгуни', 'Хаста', 'Читра', 'Свати', 'Вишакха',
    'Анурадха', 'Джйештха', 'Мула', 'Пурва-Ашадха', 'Уттара-Ашадха',
    'Шравана', 'Дхаништха', 'Шатабхиша', 'Пурва-Бхадрапада',
    'Уттара-Бхадрапада', 'Ревати',
];

const NAKSHATRA_LORDS = [
    'Кету', 'Венера', 'Солнце', 'Луна', 'Марс', 'Раху',
    'Юпитер', 'Сатурн', 'Меркурий',
];

const YOGA_NAMES = [
    'Вишкумбха', 'Прити', 'Аюшман', 'Саубхагья', 'Шобхана', 'Атиганда',
    'Сукарма', 'Дхрити', 'Шула', 'Ганда', 'Вриддхи', 'Дхрува',
    'Вьягхата', 'Харшана', 'Ваджра', 'Сиддхи', 'Вьятипата', 'Вариян',
    'Паригха', 'Шива', 'Сиддха', 'Садхья', 'Шубха', 'Шукла',
    'Брахма', 'Индра', 'Вайдхрити',
];

const TITHI_NAMES = [
    'Пратипада', 'Двития', 'Трития', 'Чатуртхи', 'Панчами', 'Шашти',
    'Саптами', 'Аштами', 'Навами', 'Дашами', 'Экадаши', 'Двадаши',
    'Трайодаши', 'Чатурдаши', 'Пурнима/Амавасья',
];

const KARANA_SEQUENCE = [
    'Бава', 'Балава', 'Каулава', 'Тайтила', 'Гара', 'Ваниджа', 'Вишти',
];

const VIMSHOTTARI_SEQUENCE = [
    ['Кету', 7], ['Венера', 20], ['Солнце', 6], ['Луна', 10],
    ['Марс', 7], ['Раху', 18], ['Юпитер', 16], ['Сатурн', 19],
    ['Меркурий', 17],
];

const HOUSE_SYSTEMS = [
    ['W', 'Whole Sign'],
    ['E', 'Equal'],
    ['P', 'Placidus'],
    ['O', 'Porphyry'],
    ['K', 'Koch'],
    ['R', 'Regiomontanus'],
    ['C', 'Campanus'],
    ['A', 'Equal (Ascendant)'],
    ['V', 'Vehlow Equal'],
    ['X', 'Axial Rotation'],
    ['H', 'Horizontal/Azimuthal'],
    ['T', 'Polich/Page'],
    ['B', 'Alcabitius'],
    ['M', 'Morinus'],
    ['U', 'Krusinski/Pisa/Goelzer'],
];

const MAJOR_ASPECTS = [
    ['соединение', 0, 8],
    ['секстиль', 60, 5],
    ['квадрат', 90, 7],
    ['трин', 120, 7],
    ['квинконс', 150, 3],
    ['оппозиция', 180, 8],
];

const DIGNITIES = {
    Солнце: { own: [4], exalted: 0, debilitated: 6, moolatrikona: 4 },
    Луна: { own: [3], exalted: 1, debilitated: 7, moolatrikona: 1 },
    Меркурий: { own: [2, 5], exalted: 5, debilitated: 11, moolatrikona: 5 },
    Венера: { own: [1, 6], exalted: 11, debilitated: 5, moolatrikona: 6 },
    Марс: { own: [0, 7], exalted: 9, debilitated: 3, moolatrikona: 0 },
    Юпитер: { own: [8, 11], exalted: 3, debilitated: 9, moolatrikona: 8 },
    Сатурн: { own: [9, 10], exalted: 6, debilitated: 0, moolatrikona: 10 },
};

const COMBUSTION_ORBS = {
    Луна: 12,
    Меркурий: 14,
    Венера: 10,
    Марс: 17,
    Юпитер: 11,
    Сатурн: 15,
};

const CORE_BODY_NAMES = new Set([
    'Солнце', 'Луна', 'Меркурий', 'Венера', 'Марс',
    'Юпитер', 'Сатурн', 'Раху истинный',
]);

const MAXIMUM_PRIMARY_BODY_NAMES = Object.freeze([
    'Солнце', 'Луна', 'Меркурий', 'Венера', 'Марс', 'Юпитер', 'Сатурн',
    'Раху истинный', 'Кету истинный', 'Уран', 'Нептун', 'Плутон',
]);

const DIRECT_MAXIMUM_BODY_NAMES = Object.freeze(
    MAXIMUM_PRIMARY_BODY_NAMES.filter((name) => name !== 'Кету истинный'),
);

const MAXIMUM_REQUESTED_BODY_NAMES = Object.freeze([
    'Солнце', 'Луна', 'Меркурий', 'Венера', 'Марс', 'Юпитер', 'Сатурн',
    'Уран', 'Нептун', 'Плутон', 'Раху средний', 'Раху истинный',
    'Кету средний', 'Кету истинный', 'Лилит средняя',
    'Лилит осциллирующая', 'Хирон', 'Фол', 'Церера', 'Паллада',
    'Юнона', 'Веста', 'Лилит интерполированная',
    'Перигей интерполированный',
]);

const REQUESTED_FIXED_STARS = Object.freeze([
    'Spica', 'Regulus', 'Aldebaran', 'Antares', 'Fomalhaut',
    'Sirius', 'Algol', 'Pollux', 'Castor', 'Vega',
]);

const DEFAULT_TIME_ZONE = 'Europe/Moscow';

let swephModulePromise = null;
let configuredEphemerisPath = null;

async function loadSweph() {
    if (!swephModulePromise) {
        swephModulePromise = import('sweph').catch((error) => {
            swephModulePromise = null;
            const wrapped = new Error(
                'Swiss Ephemeris не подключён. Выполни «pnpm add sweph@2.10.3-7», затем перезапусти бота.',
            );
            wrapped.cause = error;
            throw wrapped;
        });
    }

    const module = await swephModulePromise;
    const api = module.default?.calc_ut
        ? module.default
        : module.sweph?.calc_ut
            ? module.sweph
            : module;
    const constants = module.constants ?? api.constants;

    if (!api?.calc_ut || !api?.houses_ex2 || !constants) {
        throw new Error(
            'Пакет sweph загрузился, но его API не распознано. Проверь установленную версию.',
        );
    }

    const requestedPath = process.env.EPHEMERIS_PATH?.trim();
    const requireSwissFiles = true; // V188.49: natal/prashna never fall back to Moshier/model math.
    let ephemerisPath = null;
    let hasEphemerisFiles = false;

    if (requestedPath) {
        ephemerisPath = resolve(requestedPath);
        if (!existsSync(ephemerisPath)) {
            throw new Error(`EPHEMERIS_PATH не существует: ${ephemerisPath}`);
        }

        hasEphemerisFiles = directoryContainsSwissEphemerisFiles(ephemerisPath);
        if (!hasEphemerisFiles) {
            throw new Error(
                `В EPHEMERIS_PATH не найдены файлы Swiss Ephemeris (*.se1): ${ephemerisPath}`,
            );
        }

        if (configuredEphemerisPath !== ephemerisPath) {
            api.set_ephe_path(ephemerisPath);
            configuredEphemerisPath = ephemerisPath;
        }
    }

    if (requireSwissFiles && !hasEphemerisFiles) {
        throw new Error(
            'Для натала/прашны обязателен локальный Swiss Ephemeris: EPHEMERIS_PATH с файлами *.se1 не настроен. Расчёт остановлен; модель не будет вычислять карту по памяти.',
        );
    }

    return {
        api,
        constants,
        hasEphemerisFiles,
        ephemerisPath,
        requireSwissFiles,
    };
}

function directoryContainsSwissEphemerisFiles(directory) {
    try {
        return readdirSync(directory, { withFileTypes: true }).some((entry) =>
            entry.isFile() && /\.se1$/iu.test(entry.name),
        );
    } catch (error) {
        throw new Error(
            `Не удалось прочитать EPHEMERIS_PATH ${directory}: ${errorMessage(error)}`,
        );
    }
}

export async function calculateJyotishPrashna({
    date = new Date(),
    periodReferenceDate = new Date(),
    latitude = DEFAULT_LATITUDE,
    longitude = DEFAULT_LONGITUDE,
    altitudeMeters = DEFAULT_ALTITUDE_METERS,
    locationName = DEFAULT_LOCATION_NAME,
    timeZone = DEFAULT_TIME_ZONE,
    pressureHpa = DEFAULT_PRESSURE_HPA,
    temperatureC = DEFAULT_TEMPERATURE_C,
} = {}) {
    assertValidDate(date);
    assertValidDate(periodReferenceDate);
    assertTimeZone(timeZone);
    assertCoordinate(latitude, -90, 90, 'широта');
    assertCoordinate(longitude, -180, 180, 'долгота');

    const lat = Number(latitude);
    const lon = Number(longitude);
    const altitude = finiteOr(Number(altitudeMeters), DEFAULT_ALTITUDE_METERS);
    const pressure = finiteOr(Number(pressureHpa), DEFAULT_PRESSURE_HPA);
    const temperature = finiteOr(Number(temperatureC), DEFAULT_TEMPERATURE_C);
    const warnings = [];

    const {
        api,
        constants,
        hasEphemerisFiles,
        ephemerisPath,
        requireSwissFiles,
    } = await loadSweph();

    api.set_sid_mode(constants.SE_SIDM_LAHIRI ?? 1, 0, 0);
    if (typeof api.set_topo === 'function') {
        api.set_topo(lon, lat, altitude);
    }

    const utc = dateToUtcParts(date);
    const julian = api.utc_to_jd(
        utc.year,
        utc.month,
        utc.day,
        utc.hour,
        utc.minute,
        utc.second,
        constants.SE_GREG_CAL ?? 1,
    );
    assertResultData(julian, 'преобразовать UTC в Julian Day');

    const [julianEt, julianUt] = julian.data;
    const ephemerisFlag = hasEphemerisFiles
        ? (constants.SEFLG_SWIEPH ?? 2)
        : (constants.SEFLG_MOSEPH ?? 4);
    const speedFlag = constants.SEFLG_SPEED ?? 256;
    const siderealFlag = constants.SEFLG_SIDEREAL ?? 65536;
    const equatorialFlag = constants.SEFLG_EQUATORIAL ?? 2048;
    const topoFlag = constants.SEFLG_TOPOCTR ?? 32768;

    const requestedCalculationEngine = hasEphemerisFiles
        ? 'Swiss Ephemeris files (SEFLG_SWIEPH)'
        : 'встроенная Moshier ephemeris (SEFLG_MOSEPH)';

    const time = calculateTimeAndEarthOrientation({
        api,
        constants,
        julianEt,
        julianUt,
        ephemerisFlag,
        lon,
        date,
        warnings,
    });

    const ayanamsas = calculateAyanamsaComparison({
        api,
        constants,
        julianUt,
        warnings,
    });
    api.set_sid_mode(constants.SE_SIDM_LAHIRI ?? 1, 0, 0);

    const houseSystems = calculateAllHouseSystems({
        api,
        constants,
        julianUt,
        lat,
        lon,
        siderealFlag,
        warnings,
    });

    const wholeSign = houseSystems.W;
    if (!wholeSign) {
        throw new Error('Swiss Ephemeris не смог рассчитать Whole Sign дома.');
    }

    const ascendant = normalizeDegrees(wholeSign.points.ascendant);
    const ascendantSign = Math.floor(ascendant / 30);
    const bodyDefinitions = getBodyDefinitions(constants);
    const bodies = [];

    for (const definition of bodyDefinitions) {
        const body = calculateBodyMaximum({
            api,
            constants,
            definition,
            julianEt,
            julianUt,
            ephemerisFlag,
            speedFlag,
            siderealFlag,
            equatorialFlag,
            topoFlag,
            lat,
            lon,
            altitude,
            pressure,
            temperature,
            ascendantSign,
            strictSwissFiles: requireSwissFiles,
            warnings,
        });

        if (body) {
            bodies.push(body);
        } else if (CORE_BODY_NAMES.has(definition.name)) {
            throw new Error(`Не удалось рассчитать обязательное тело: ${definition.name}.`);
        }
    }

    appendKetuBodies(bodies, ascendantSign);
    const ephemerisUsage = evaluateEphemerisFlagCoverage({
        bodies,
        swissFlag: constants.SEFLG_SWIEPH ?? 2,
        moshierFlag: constants.SEFLG_MOSEPH ?? 4,
        requestedSwiss: hasEphemerisFiles,
    });

    if (requireSwissFiles && !ephemerisUsage.allDirectPrimaryUseSwiss) {
        throw new Error(
            `Обязательный Swiss Ephemeris не подтверждён фактическими флагами расчёта для всех основных тел: ${ephemerisUsage.nonSwissDirectPrimaryBodies.join(', ') || 'неизвестный пробел'}.`,
        );
    }

    const calculationEngine = ephemerisUsage.allDirectPrimaryUseSwiss
        ? 'Swiss Ephemeris files (подтверждено return flags)'
        : ephemerisUsage.anyDirectPrimaryUsesMoshier
            ? 'Moshier fallback (подтверждено return flags)'
            : requestedCalculationEngine;
    const primaryBodies = getPrimaryJyotishBodies(bodies);
    const sun = findBody(primaryBodies, 'Солнце');
    const moon = findBody(primaryBodies, 'Луна');
    const rahu = findBody(primaryBodies, 'Раху истинный');

    if (!sun || !moon || !rahu) {
        throw new Error('Не удалось получить Солнце, Луну или истинный Раху.');
    }

    const panchanga = calculatePanchanga({
        api,
        constants,
        julianUt,
        ephemerisFlag,
        speedFlag,
        siderealFlag,
        sun,
        moon,
        date,
        timeZone,
        time,
        warnings,
    });

    const relationships = calculateRelationships(primaryBodies);
    const jyotishDerived = calculateJyotishDerived({
        bodies: primaryBodies,
        ascendant,
        ascendantSign,
        houseSystems,
        panchanga,
        date,
        periodReferenceDate,
    });

    const harmonicCharts = calculateHarmonicCharts({
        ascendant,
        bodies: primaryBodies,
        maxDivision: 60,
    });

    const fixedStars = calculateFixedStars({
        api,
        constants,
        julianUt,
        ephemerisFlag,
        speedFlag,
        siderealFlag,
        warnings,
    });

    const result = {
        schema: 'gigorave-jyotish-maximum-v3',
        generatedAt: new Date().toISOString(),
        input: {
            requestTimeUtc: date.toISOString(),
            periodReferenceTimeUtc: periodReferenceDate.toISOString(),
            locationName,
            timeZone,
            latitude: lat,
            longitude: lon,
            altitudeMeters: altitude,
            pressureHpa: pressure,
            temperatureC: temperature,
        },
        engine: {
            library: 'Swiss Ephemeris via sweph',
            version: safeCall(() => api.version(), 'unknown'),
            requestedCalculationEngine,
            calculationEngine,
            ephemerisPath,
            siderealMode: 'Lahiri',
            highPrecisionFilesLoaded: hasEphemerisFiles,
            coreCalculationsUsedSwissFiles: ephemerisUsage.allDirectPrimaryUseSwiss,
            strictSwissFilesRequired: requireSwissFiles,
            fallbackUsed: !ephemerisUsage.allDirectPrimaryUseSwiss,
            ephemerisUsage,
        },
        time,
        ayanamsas,
        angles: {
            ascendant: zodiacRecord(ascendant),
            ascendantNakshatra: calculateNakshatra(ascendant),
            ascendantSignLord: RASHI_LORDS[ascendantSign],
        },
        houseSystems,
        bodies,
        primaryJyotishBodies: primaryBodies.map((body) => body.name),
        panchanga,
        relationships,
        jyotishDerived,
        harmonicCharts,
        fixedStars,
        warnings: uniqueStrings(warnings),
        coverage: buildCoverage({
            bodies,
            houseSystems,
            harmonicCharts,
            fixedStars,
        }),
        calculationScope: {
            level: 'maximum-available',
            astronomicalEngine: calculationEngine,
            highPrecisionFilesLoaded: hasEphemerisFiles,
            traditionalScope: [
                'D1 Whole Sign',
                'панчанга с границами',
                'управители домов',
                'достоинства',
                'сожжение',
                'чара-караки',
                'парашари-дришти',
                'арудха-пады',
                'вимшоттари маха/антар/пратьянтар-даша',
            ],
            harmonicScope: 'D1-D60 are mathematical harmonics, not a claim that every school-specific varga rule is implemented.',
        },
    };

    result.audit = buildMaximumCalculationAudit(result);
    assertMaximumCalculationAudit(result.audit);

    /*
     * Полная структура остаётся в result/data. Дорогую сериализацию огромного
     * отладочного JSON делаем только при явном PRASHNA_KEEP_FULL_JSON=1.
     */
    const keepFullJson = process.env.PRASHNA_KEEP_FULL_JSON === '1';
    const json = keepFullJson ? stableStringify(result, 2) : null;
    const fastGptPayload = buildOptimizedGptPayload(result, 'fast');
    const balancedGptPayload = buildOptimizedGptPayload(result, 'balanced');
    const fullGptPayload = buildOptimizedGptPayload(result, 'full');
    const maximumGptPayload = buildCompactGptPayload(result);
    result.coverage.serializedJsonCharacters = json?.length ?? 0;
    result.coverage.compactGptPayloadCharacters = maximumGptPayload.length;
    result.coverage.maximumGptPayloadCharacters = maximumGptPayload.length;
    result.coverage.fastGptPayloadCharacters = fastGptPayload.length;
    result.coverage.balancedGptPayloadCharacters = balancedGptPayload.length;
    result.coverage.fullGptPayloadCharacters = fullGptPayload.length;
    const text = buildMaximumCalculationText(result);

    return {
        date,
        latitude: lat,
        longitude: lon,
        locationName,
        julianEt,
        julianUt,
        ayanamsa: ayanamsas.Lahiri?.valueDegrees ?? api.get_ayanamsa_ut(julianUt),
        ascendant,
        planets: primaryBodies.map(toLegacyPlanetRecord),
        tithi: panchanga.tithi,
        moonNakshatra: panchanga.nakshatra,
        ascNakshatra: calculateNakshatra(ascendant),
        yoga: panchanga.yoga,
        calculationEngine,
        warnings: result.warnings,
        data: result,
        json,
        text,
        /*
         * Полная структура остаётся локально в data. Для обычных вызовов сохранены
         * компактные профили, но локальная астрология маршрутизируется только в
         * gptPayloadMaximum: он содержит все рассчитанные поля без усечения.
         */
        gptPayload: balancedGptPayload,
        gptPayloadFast: fastGptPayload,
        gptPayloadBalanced: balancedGptPayload,
        gptPayloadFull: fullGptPayload,
        gptPayloadMaximum: maximumGptPayload,
        audit: result.audit,
        statistics: result.coverage,
    };
}

function calculateTimeAndEarthOrientation({
    api,
    constants,
    julianEt,
    julianUt,
    ephemerisFlag,
    lon,
    date,
    warnings,
}) {
    const result = {
        utcIso: date.toISOString(),
        julianDayEt: julianEt,
        julianDayUt: julianUt,
        deltaTSeconds: null,
        greenwichSiderealTimeHours: null,
        localSiderealTimeHours: null,
        equationOfTimeMinutes: null,
        trueObliquityDegrees: null,
        meanObliquityDegrees: null,
        nutationLongitudeDegrees: null,
        nutationObliquityDegrees: null,
    };

    if (typeof api.deltat_ex === 'function') {
        const delta = safeApiResult(
            () => api.deltat_ex(julianUt, ephemerisFlag),
            'Delta T',
            warnings,
        );
        if (delta && Number.isFinite(delta.data)) {
            result.deltaTSeconds = delta.data * SECONDS_PER_DAY;
        }
    } else if (typeof api.deltat === 'function') {
        const delta = safeCall(() => api.deltat(julianUt), null);
        const value = typeof delta === 'number' ? delta : delta?.data;
        if (Number.isFinite(value)) {
            result.deltaTSeconds = value * SECONDS_PER_DAY;
        }
    }

    if (typeof api.sidtime === 'function') {
        result.greenwichSiderealTimeHours = normalizeHours(api.sidtime(julianUt));
        result.localSiderealTimeHours = normalizeHours(
            result.greenwichSiderealTimeHours + lon / 15,
        );
    }

    if (typeof api.time_equ === 'function') {
        const equation = safeApiResult(
            () => api.time_equ(julianUt),
            'уравнение времени',
            warnings,
        );
        if (equation && Number.isFinite(equation.data)) {
            result.equationOfTimeMinutes = equation.data * 24 * 60;
        }
    }

    const eclNut = safeApiResult(
        () => api.calc_ut(
            julianUt,
            constants.SE_ECL_NUT ?? -1,
            ephemerisFlag,
        ),
        'наклон эклиптики и нутацию',
        warnings,
    );
    if (eclNut?.data) {
        result.trueObliquityDegrees = finiteOrNull(eclNut.data[0]);
        result.meanObliquityDegrees = finiteOrNull(eclNut.data[1]);
        result.nutationLongitudeDegrees = finiteOrNull(eclNut.data[2]);
        result.nutationObliquityDegrees = finiteOrNull(eclNut.data[3]);
    }

    return result;
}

function calculateAyanamsaComparison({ api, constants, julianUt, warnings }) {
    const definitions = [
        ['Lahiri', constants.SE_SIDM_LAHIRI ?? 1],
        ['Raman', constants.SE_SIDM_RAMAN ?? 3],
        ['Krishnamurti', constants.SE_SIDM_KRISHNAMURTI ?? 5],
        ['True Chitra', constants.SE_SIDM_TRUE_CITRA ?? 27],
        ['True Revati', constants.SE_SIDM_TRUE_REVATI ?? 28],
        ['Lahiri ICRC', constants.SE_SIDM_LAHIRI_ICRC ?? 46],
    ];
    const result = {};

    for (const [name, mode] of definitions) {
        try {
            api.set_sid_mode(mode, 0, 0);
            const value = api.get_ayanamsa_ut(julianUt);
            result[name] = {
                mode,
                valueDegrees: Number(value),
                formatted: formatDegrees(value),
            };
        } catch (error) {
            warnings.push(`Аянамша ${name}: ${errorMessage(error)}`);
        }
    }

    return result;
}

function calculateAllHouseSystems({
    api,
    constants,
    julianUt,
    lat,
    lon,
    siderealFlag,
    warnings,
}) {
    const systems = {};

    for (const [code, name] of HOUSE_SYSTEMS) {
        const result = safeApiResult(
            () => api.houses_ex2(julianUt, siderealFlag, lat, lon, code),
            `дома ${name}`,
            warnings,
        );
        if (!result?.data) {
            continue;
        }

        const points = result.data.points ?? [];
        systems[code] = {
            code,
            name,
            cusps: Array.from(result.data.houses ?? []).map((value, index) => ({
                house: index + 1,
                longitude: normalizeDegrees(value),
                zodiac: zodiacRecord(value),
                speedDegreesPerDay: finiteOrNull(result.data.housesSpeed?.[index]),
            })),
            points: {
                ascendant: normalizeDegrees(points[0]),
                mc: normalizeDegrees(points[1]),
                armc: normalizeDegrees(points[2]),
                vertex: normalizeDegrees(points[3]),
                equatorialAscendant: normalizeDegrees(points[4]),
                coAscendantKoch: normalizeDegrees(points[5]),
                coAscendantMunkasey: normalizeDegrees(points[6]),
                polarAscendant: normalizeDegrees(points[7]),
            },
            pointSpeeds: {
                ascendant: finiteOrNull(result.data.pointsSpeed?.[0]),
                mc: finiteOrNull(result.data.pointsSpeed?.[1]),
                armc: finiteOrNull(result.data.pointsSpeed?.[2]),
                vertex: finiteOrNull(result.data.pointsSpeed?.[3]),
                equatorialAscendant: finiteOrNull(result.data.pointsSpeed?.[4]),
                coAscendantKoch: finiteOrNull(result.data.pointsSpeed?.[5]),
                coAscendantMunkasey: finiteOrNull(result.data.pointsSpeed?.[6]),
                polarAscendant: finiteOrNull(result.data.pointsSpeed?.[7]),
            },
        };
    }

    return systems;
}

function getBodyDefinitions(constants) {
    const candidates = [
        ['Солнце', 'SE_SUN', 0, 'luminary'],
        ['Луна', 'SE_MOON', 1, 'luminary'],
        ['Меркурий', 'SE_MERCURY', 2, 'classical'],
        ['Венера', 'SE_VENUS', 3, 'classical'],
        ['Марс', 'SE_MARS', 4, 'classical'],
        ['Юпитер', 'SE_JUPITER', 5, 'classical'],
        ['Сатурн', 'SE_SATURN', 6, 'classical'],
        ['Уран', 'SE_URANUS', 7, 'outer'],
        ['Нептун', 'SE_NEPTUNE', 8, 'outer'],
        ['Плутон', 'SE_PLUTO', 9, 'outer'],
        ['Раху средний', 'SE_MEAN_NODE', 10, 'node'],
        ['Раху истинный', 'SE_TRUE_NODE', 11, 'node'],
        ['Лилит средняя', 'SE_MEAN_APOG', 12, 'apogee'],
        ['Лилит осциллирующая', 'SE_OSCU_APOG', 13, 'apogee'],
        ['Хирон', 'SE_CHIRON', 15, 'centaur'],
        ['Фол', 'SE_PHOLUS', 16, 'centaur'],
        ['Церера', 'SE_CERES', 17, 'asteroid'],
        ['Паллада', 'SE_PALLAS', 18, 'asteroid'],
        ['Юнона', 'SE_JUNO', 19, 'asteroid'],
        ['Веста', 'SE_VESTA', 20, 'asteroid'],
        ['Лилит интерполированная', 'SE_INTP_APOG', 21, 'apogee'],
        ['Перигей интерполированный', 'SE_INTP_PERG', 22, 'apogee'],
    ];

    return candidates.map(([name, key, fallbackId, category]) => ({
        name,
        id: constants[key] ?? fallbackId,
        category,
    }));
}

function calculateBodyMaximum({
    api,
    constants,
    definition,
    julianEt,
    julianUt,
    ephemerisFlag,
    speedFlag,
    siderealFlag,
    equatorialFlag,
    topoFlag,
    lat,
    lon,
    altitude,
    pressure,
    temperature,
    ascendantSign,
    strictSwissFiles,
    warnings,
}) {
    const baseFlags = ephemerisFlag | speedFlag;
    const sidereal = safeCalc(
        api,
        julianUt,
        definition.id,
        baseFlags | siderealFlag,
        `${definition.name}: сидерические координаты`,
        warnings,
        {
            requiredEphemerisFlag: ephemerisFlag,
            strictEphemeris: strictSwissFiles,
        },
    );

    if (!sidereal) {
        return null;
    }

    const tropical = safeCalc(
        api,
        julianUt,
        definition.id,
        baseFlags,
        `${definition.name}: тропические координаты`,
        warnings,
        {
            requiredEphemerisFlag: ephemerisFlag,
            strictEphemeris: strictSwissFiles,
        },
    );
    const equatorial = safeCalc(
        api,
        julianUt,
        definition.id,
        baseFlags | equatorialFlag,
        `${definition.name}: экваториальные координаты`,
        warnings,
        {
            requiredEphemerisFlag: ephemerisFlag,
            strictEphemeris: strictSwissFiles,
        },
    );
    const topocentricSidereal = safeCalc(
        api,
        julianUt,
        definition.id,
        baseFlags | siderealFlag | topoFlag,
        `${definition.name}: топоцентрические сидерические координаты`,
        warnings,
        {
            requiredEphemerisFlag: ephemerisFlag,
            strictEphemeris: strictSwissFiles,
        },
    );
    const topocentricEquatorial = safeCalc(
        api,
        julianUt,
        definition.id,
        baseFlags | equatorialFlag | topoFlag,
        `${definition.name}: топоцентрические экваториальные координаты`,
        warnings,
        {
            requiredEphemerisFlag: ephemerisFlag,
            strictEphemeris: strictSwissFiles,
        },
    );

    const siderealPosition = eclipticRecord(sidereal.data);
    const tropicalPosition = tropical ? eclipticRecord(tropical.data) : null;
    const equatorialPosition = equatorial ? equatorialRecord(equatorial.data) : null;
    const topoSiderealPosition = topocentricSidereal
        ? eclipticRecord(topocentricSidereal.data)
        : null;
    const topoEquatorialPosition = topocentricEquatorial
        ? equatorialRecord(topocentricEquatorial.data)
        : null;

    const horizontal = calculateHorizontal({
        api,
        constants,
        julianUt,
        lon,
        lat,
        altitude,
        pressure,
        temperature,
        equatorialPosition: topoEquatorialPosition ?? equatorialPosition,
        warnings,
        name: definition.name,
    });

    const phenomena = calculatePhenomena({
        api,
        julianUt,
        bodyId: definition.id,
        flags: ephemerisFlag | topoFlag,
        warnings,
        name: definition.name,
    });

    const orbitalElements = calculateOrbitalElements({
        api,
        julianEt,
        bodyId: definition.id,
        flags: ephemerisFlag,
        warnings,
        name: definition.name,
    });

    const nodesAndApsides = calculateNodesAndApsides({
        api,
        constants,
        julianUt,
        bodyId: definition.id,
        flags: baseFlags | siderealFlag,
        warnings,
        name: definition.name,
    });

    const events = calculateRiseSetTransit({
        api,
        constants,
        julianUt,
        bodyId: definition.id,
        ephemerisFlag,
        lon,
        lat,
        altitude,
        pressure,
        temperature,
        warnings,
        name: definition.name,
    });

    return {
        name: definition.name,
        id: definition.id,
        category: definition.category,
        sidereal: siderealPosition,
        tropical: tropicalPosition,
        topocentricSidereal: topoSiderealPosition,
        equatorial: equatorialPosition,
        topocentricEquatorial: topoEquatorialPosition,
        calculationFlags: {
            sidereal: calculationFlagRecord(sidereal, baseFlags | siderealFlag),
            tropical: calculationFlagRecord(tropical, baseFlags),
            equatorial: calculationFlagRecord(equatorial, baseFlags | equatorialFlag),
            topocentricSidereal: calculationFlagRecord(
                topocentricSidereal,
                baseFlags | siderealFlag | topoFlag,
            ),
            topocentricEquatorial: calculationFlagRecord(
                topocentricEquatorial,
                baseFlags | equatorialFlag | topoFlag,
            ),
        },
        horizontal,
        phenomena,
        orbitalElements,
        nodesAndApsides,
        events,
        jyotish: buildJyotishBodyRecord({
            name: definition.name,
            position: siderealPosition,
            ascendantSign,
        }),
    };
}

function safeCalc(
    api,
    jd,
    bodyId,
    flags,
    label,
    warnings,
    { requiredEphemerisFlag = 0, strictEphemeris = false } = {},
) {
    const result = safeApiResult(
        () => api.calc_ut(jd, bodyId, flags),
        label,
        warnings,
    );

    if (!result?.data) {
        return null;
    }

    const returnedFlag = Number(result.flag);
    const requiredFlag = Number(requiredEphemerisFlag);

    if (
        Number.isFinite(returnedFlag) &&
        Number.isFinite(requiredFlag) &&
        requiredFlag !== 0 &&
        (returnedFlag & requiredFlag) !== requiredFlag
    ) {
        const message = `${label}: Swiss Ephemeris вернул flag=${returnedFlag} вместо обязательного ephemeris flag=${requiredFlag}; возможен внутренний fallback.`;
        if (strictEphemeris) {
            throw new Error(message);
        }
        warnings.push(message);
    }

    return result;
}

function calculationFlagRecord(result, requestedFlag) {
    return {
        requested: Number(requestedFlag),
        returned: Number.isFinite(Number(result?.flag))
            ? Number(result.flag)
            : null,
        error: String(result?.error ?? '').trim() || null,
    };
}

export function evaluateEphemerisFlagCoverage({
    bodies,
    swissFlag,
    moshierFlag,
    requestedSwiss = false,
}) {
    const byName = new Map((bodies ?? []).map((body) => [body.name, body]));
    const directPrimary = DIRECT_MAXIMUM_BODY_NAMES.map((name) => {
        const body = byName.get(name);
        const returned = Number(body?.calculationFlags?.sidereal?.returned);
        return {
            name,
            returned: Number.isFinite(returned) ? returned : null,
            usesSwiss: Number.isFinite(returned) && (returned & swissFlag) === swissFlag,
            usesMoshier: Number.isFinite(returned) && (returned & moshierFlag) === moshierFlag,
        };
    });
    const nonSwissDirectPrimaryBodies = directPrimary
        .filter((item) => !item.usesSwiss)
        .map((item) => item.name);

    return {
        requestedSwiss: Boolean(requestedSwiss),
        allDirectPrimaryUseSwiss: directPrimary.length > 0 &&
            nonSwissDirectPrimaryBodies.length === 0,
        anyDirectPrimaryUsesMoshier: directPrimary.some((item) => item.usesMoshier),
        nonSwissDirectPrimaryBodies,
        directPrimary,
    };
}

function calculateHorizontal({
    api,
    constants,
    julianUt,
    lon,
    lat,
    altitude,
    pressure,
    temperature,
    equatorialPosition,
    warnings,
    name,
}) {
    if (!equatorialPosition || typeof api.azalt !== 'function') {
        return null;
    }

    try {
        const data = api.azalt(
            julianUt,
            constants.SE_EQU2HOR ?? 1,
            [lon, lat, altitude],
            pressure,
            temperature,
            [
                equatorialPosition.rightAscensionDegrees,
                equatorialPosition.declinationDegrees,
                equatorialPosition.distanceAu,
            ],
        );
        const values = Array.isArray(data) ? data : data?.data;
        if (!Array.isArray(values)) {
            return null;
        }
        return {
            azimuthDegrees: finiteOrNull(values[0]),
            trueAltitudeDegrees: finiteOrNull(values[1]),
            apparentAltitudeDegrees: finiteOrNull(values[2]),
        };
    } catch (error) {
        warnings.push(`${name}: горизонтальные координаты: ${errorMessage(error)}`);
        return null;
    }
}

function calculatePhenomena({ api, julianUt, bodyId, flags, warnings, name }) {
    if (typeof api.pheno_ut !== 'function') {
        return null;
    }
    const result = safeApiResult(
        () => api.pheno_ut(julianUt, bodyId, flags),
        `${name}: физические явления`,
        warnings,
    );
    if (!result?.data) {
        return null;
    }
    return {
        phaseAngleDegrees: finiteOrNull(result.data[0]),
        illuminatedFraction: finiteOrNull(result.data[1]),
        elongationDegrees: finiteOrNull(result.data[2]),
        apparentDiameterDegrees: finiteOrNull(result.data[3]),
        apparentMagnitude: finiteOrNull(result.data[4]),
        horizontalParallaxDegrees: finiteOrNull(result.data[5]),
    };
}

function calculateOrbitalElements({
    api,
    julianEt,
    bodyId,
    flags,
    warnings,
    name,
}) {
    if (typeof api.get_orbital_elements !== 'function') {
        return null;
    }
    const result = safeApiResult(
        () => api.get_orbital_elements(julianEt, bodyId, flags),
        `${name}: орбитальные элементы`,
        warnings,
    );
    if (!result?.data) {
        return null;
    }
    const d = result.data;
    return {
        semimajorAxisAu: finiteOrNull(d[0]),
        eccentricity: finiteOrNull(d[1]),
        inclinationDegrees: finiteOrNull(d[2]),
        ascendingNodeLongitudeDegrees: finiteOrNull(d[3]),
        argumentOfPeriapsisDegrees: finiteOrNull(d[4]),
        periapsisLongitudeDegrees: finiteOrNull(d[5]),
        meanAnomalyDegrees: finiteOrNull(d[6]),
        trueAnomalyDegrees: finiteOrNull(d[7]),
        eccentricAnomalyDegrees: finiteOrNull(d[8]),
        meanLongitudeDegrees: finiteOrNull(d[9]),
        siderealPeriodYears: finiteOrNull(d[10]),
        meanDailyMotionDegrees: finiteOrNull(d[11]),
        tropicalPeriodYears: finiteOrNull(d[12]),
        synodicPeriodDays: finiteOrNull(d[13]),
        perihelionPassageJulianDay: finiteOrNull(d[14]),
        perihelionDistanceAu: finiteOrNull(d[15]),
        aphelionDistanceAu: finiteOrNull(d[16]),
    };
}

function calculateNodesAndApsides({
    api,
    constants,
    julianUt,
    bodyId,
    flags,
    warnings,
    name,
}) {
    if (typeof api.nod_aps_ut !== 'function') {
        return null;
    }
    const result = {};
    const methods = [
        ['mean', constants.SE_NODBIT_MEAN ?? 1],
        ['osculating', constants.SE_NODBIT_OSCU ?? 2],
    ];

    for (const [methodName, method] of methods) {
        const calculated = safeApiResult(
            () => api.nod_aps_ut(julianUt, bodyId, flags, method),
            `${name}: узлы/апсиды ${methodName}`,
            warnings,
        );
        if (!calculated?.data) {
            continue;
        }
        result[methodName] = {
            ascendingNode: calcArrayRecord(calculated.data.ascending),
            descendingNode: calcArrayRecord(calculated.data.descending),
            perihelion: calcArrayRecord(calculated.data.perihelion),
            aphelion: calcArrayRecord(calculated.data.aphelion),
        };
    }

    return Object.keys(result).length ? result : null;
}

function calculateRiseSetTransit({
    api,
    constants,
    julianUt,
    bodyId,
    ephemerisFlag,
    lon,
    lat,
    altitude,
    pressure,
    temperature,
    warnings,
    name,
}) {
    if (typeof api.rise_trans !== 'function') {
        return null;
    }

    const events = {};
    const eventDefinitions = [
        ['rise', constants.SE_CALC_RISE ?? 1],
        ['set', constants.SE_CALC_SET ?? 2],
        ['upperTransit', constants.SE_CALC_MTRANSIT ?? 4],
        ['lowerTransit', constants.SE_CALC_ITRANSIT ?? 8],
    ];

    for (const [key, eventFlag] of eventDefinitions) {
        const calculated = safeApiResult(
            () => api.rise_trans(
                julianUt,
                bodyId,
                null,
                ephemerisFlag,
                eventFlag,
                [lon, lat, altitude],
                pressure,
                temperature,
            ),
            `${name}: ${key}`,
            warnings,
            { suppressWarning: true },
        );
        if (calculated && Number.isFinite(calculated.data)) {
            events[key] = {
                julianDayUt: calculated.data,
                utcIso: julianDayToDate(calculated.data).toISOString(),
            };
        }
    }

    return Object.keys(events).length ? events : null;
}

function appendKetuBodies(bodies, ascendantSign) {
    for (const rahuName of ['Раху истинный', 'Раху средний']) {
        const rahu = bodies.find((body) => body.name === rahuName);
        if (!rahu) {
            continue;
        }
        bodies.push(buildOppositeNodeBody({
            source: rahu,
            name: rahuName === 'Раху истинный' ? 'Кету истинный' : 'Кету средний',
            ascendantSign,
        }));
    }
}

function buildOppositeNodeBody({ source, name, ascendantSign }) {
    const sidereal = oppositeEclipticRecord(source.sidereal);
    const tropical = oppositeEclipticRecord(source.tropical);
    const topo = oppositeEclipticRecord(source.topocentricSidereal);
    return {
        ...structuredCloneSafe(source),
        name,
        id: null,
        category: 'node',
        derivedFrom: source.name,
        sidereal,
        tropical,
        topocentricSidereal: topo,
        equatorial: null,
        topocentricEquatorial: null,
        calculationFlags: {
            derivedFrom: source.name,
        },
        horizontal: null,
        phenomena: null,
        orbitalElements: null,
        nodesAndApsides: null,
        events: null,
        jyotish: buildJyotishBodyRecord({
            name,
            position: sidereal,
            ascendantSign,
        }),
    };
}

function oppositeEclipticRecord(position) {
    if (!position) {
        return null;
    }
    return {
        ...position,
        longitudeDegrees: normalizeDegrees(position.longitudeDegrees + 180),
        latitudeDegrees: -position.latitudeDegrees,
        longitudeSpeedDegreesPerDay: position.longitudeSpeedDegreesPerDay,
        latitudeSpeedDegreesPerDay: -position.latitudeSpeedDegreesPerDay,
        zodiac: zodiacRecord(position.longitudeDegrees + 180),
    };
}

function getPrimaryJyotishBodies(bodies) {
    return MAXIMUM_PRIMARY_BODY_NAMES
        .map((name) => bodies.find((body) => body.name === name))
        .filter(Boolean);
}

function calculatePanchanga({
    api,
    constants,
    julianUt,
    ephemerisFlag,
    speedFlag,
    siderealFlag,
    sun,
    moon,
    date,
    timeZone,
    time,
    warnings,
}) {
    const tithi = calculateTithi(
        sun.sidereal.longitudeDegrees,
        moon.sidereal.longitudeDegrees,
    );
    const nakshatra = calculateNakshatra(moon.sidereal.longitudeDegrees);
    const yoga = calculateYoga(
        sun.sidereal.longitudeDegrees,
        moon.sidereal.longitudeDegrees,
    );
    const karana = calculateKarana(
        sun.sidereal.longitudeDegrees,
        moon.sidereal.longitudeDegrees,
    );
    const localCivil = getLocalCivilDateParts(date, timeZone);
    const localCivilWeekday = new Date(Date.UTC(
        localCivil.year,
        localCivil.month - 1,
        localCivil.day,
    )).getUTCDay();
    const varaIndex = ((localCivilWeekday + 6) % 7) + 1;
    const varaNames = [
        'Сомавара (понедельник)', 'Мангалавара (вторник)',
        'Будхавара (среда)', 'Гурувара (четверг)', 'Шукравара (пятница)',
        'Шанивара (суббота)', 'Равивара (воскресенье)',
    ];

    const boundaryContext = {
        api,
        constants,
        ephemerisFlag,
        speedFlag,
        siderealFlag,
        warnings,
    };

    const nextTithi = findNextCyclicBoundary({
        ...boundaryContext,
        startJd: julianUt,
        segmentSize: 12,
        valueAt: (sunLon, moonLon) => normalizeDegrees(moonLon - sunLon),
        label: 'конец титхи',
    });
    const nextNakshatra = findNextCyclicBoundary({
        ...boundaryContext,
        startJd: julianUt,
        segmentSize: NAKSHATRA_SIZE,
        valueAt: (_sunLon, moonLon) => moonLon,
        label: 'конец накшатры',
    });
    const nextYoga = findNextCyclicBoundary({
        ...boundaryContext,
        startJd: julianUt,
        segmentSize: NAKSHATRA_SIZE,
        valueAt: (sunLon, moonLon) => normalizeDegrees(sunLon + moonLon),
        label: 'конец йоги',
    });
    const nextKarana = findNextCyclicBoundary({
        ...boundaryContext,
        startJd: julianUt,
        segmentSize: 6,
        valueAt: (sunLon, moonLon) => normalizeDegrees(moonLon - sunLon),
        label: 'конец караны',
    });

    return {
        vara: {
            index: varaIndex,
            name: varaNames[varaIndex - 1],
            civilWeekdayLocal: date.toLocaleDateString('ru-RU', {
                weekday: 'long',
                timeZone,
            }),
            timeZone,
            localCivilDate: `${String(localCivil.day).padStart(2, '0')}.${String(localCivil.month).padStart(2, '0')}.${localCivil.year}`,
        },
        tithi: {
            ...tithi,
            end: nextTithi,
        },
        nakshatra: {
            ...nakshatra,
            lord: NAKSHATRA_LORDS[(nakshatra.index - 1) % 9],
            end: nextNakshatra,
        },
        yoga: {
            ...yoga,
            end: nextYoga,
        },
        karana: {
            ...karana,
            end: nextKarana,
        },
        moonPhase: {
            elongationDegrees: tithi.elongation,
            ageDaysApprox: tithi.elongation / 360 * 29.530588853,
            illuminatedFraction: moon.phenomena?.illuminatedFraction ?? null,
        },
        siderealTime: {
            greenwichHours: time.greenwichSiderealTimeHours,
            localHours: time.localSiderealTimeHours,
        },
    };
}

function findNextCyclicBoundary({
    api,
    constants,
    ephemerisFlag,
    speedFlag,
    siderealFlag,
    startJd,
    segmentSize,
    valueAt,
    label,
    warnings,
}) {
    try {
        const flags = ephemerisFlag | speedFlag | siderealFlag;
        const startPair = getSunMoonLongitudes(api, constants, startJd, flags);
        const startValue = normalizeDegrees(valueAt(startPair.sun, startPair.moon));
        const target = Math.floor(startValue / segmentSize + 1) * segmentSize;
        const targetUnwrapped = target <= startValue ? target + 360 : target;
        let low = startJd;
        let high = startJd + 0.125;
        const firstHighPair = getSunMoonLongitudes(api, constants, high, flags);
        let highValue = cyclicForwardValue(
            normalizeDegrees(valueAt(firstHighPair.sun, firstHighPair.moon)),
            startValue,
        );

        for (let i = 0; i < 32 && highValue < targetUnwrapped; i += 1) {
            high += 0.125;
            const pair = getSunMoonLongitudes(api, constants, high, flags);
            highValue = cyclicForwardValue(
                normalizeDegrees(valueAt(pair.sun, pair.moon)),
                startValue,
            );
        }

        if (highValue < targetUnwrapped) {
            return null;
        }

        for (let i = 0; i < 45; i += 1) {
            const mid = (low + high) / 2;
            const pair = getSunMoonLongitudes(api, constants, mid, flags);
            const midValue = cyclicForwardValue(
                normalizeDegrees(valueAt(pair.sun, pair.moon)),
                startValue,
            );
            if (midValue >= targetUnwrapped) {
                high = mid;
            } else {
                low = mid;
            }
        }

        return {
            julianDayUt: high,
            utcIso: julianDayToDate(high).toISOString(),
            hoursFromRequest: (high - startJd) * 24,
        };
    } catch (error) {
        warnings.push(`${label}: ${errorMessage(error)}`);
        return null;
    }
}

function getSunMoonLongitudes(api, constants, jd, flags) {
    const sun = api.calc_ut(jd, constants.SE_SUN ?? 0, flags);
    const moon = api.calc_ut(jd, constants.SE_MOON ?? 1, flags);
    assertResultData(sun, 'рассчитать Солнце для границы панчанги');
    assertResultData(moon, 'рассчитать Луну для границы панчанги');
    return {
        sun: normalizeDegrees(sun.data[0]),
        moon: normalizeDegrees(moon.data[0]),
    };
}

function calculateRelationships(bodies) {
    const available = bodies.filter((body) => body.sidereal);
    const angularMatrix = [];
    const aspects = [];

    for (let i = 0; i < available.length; i += 1) {
        for (let j = i + 1; j < available.length; j += 1) {
            const a = available[i];
            const b = available[j];
            const difference = shortestAngularDistance(
                a.sidereal.longitudeDegrees,
                b.sidereal.longitudeDegrees,
            );
            angularMatrix.push({
                body1: a.name,
                body2: b.name,
                separationDegrees: difference,
            });

            for (const [name, exact, orb] of MAJOR_ASPECTS) {
                const deviation = Math.abs(difference - exact);
                if (deviation <= orb) {
                    const relativeSpeed =
                        (a.sidereal.longitudeSpeedDegreesPerDay ?? 0) -
                        (b.sidereal.longitudeSpeedDegreesPerDay ?? 0);
                    const signedDifference = signedAngularDifference(
                        a.sidereal.longitudeDegrees,
                        b.sidereal.longitudeDegrees,
                    );
                    aspects.push({
                        body1: a.name,
                        body2: b.name,
                        aspect: name,
                        exactAngleDegrees: exact,
                        actualAngleDegrees: difference,
                        orbDegrees: deviation,
                        applyingApprox: signedDifference * relativeSpeed < 0,
                    });
                }
            }
        }
    }

    return {
        angularSeparationMatrix: angularMatrix,
        majorAspects: aspects.sort((a, b) => a.orbDegrees - b.orbDegrees),
        planetaryWarCandidates: findPlanetaryWars(available),
    };
}

function calculateJyotishDerived({
    bodies,
    ascendant,
    ascendantSign,
    houseSystems,
    panchanga,
    date,
    periodReferenceDate,
}) {
    const bodyByName = new Map(bodies.map((body) => [body.name, body]));
    const classical = bodies.filter((body) => DIGNITIES[body.name]);
    const wholeSignLords = Array.from({ length: 12 }, (_, index) => {
        const signIndex = (ascendantSign + index) % 12;
        return {
            house: index + 1,
            signIndex,
            sign: RASHI_NAMES[signIndex],
            lord: RASHI_LORDS[signIndex],
            lordHouse: bodyByName.get(RASHI_LORDS[signIndex])?.jyotish?.wholeSignHouse ?? null,
        };
    });

    return {
        wholeSignHouseLords: wholeSignLords,
        dignities: classical.map((body) => calculateDignity(body)),
        combustion: calculateCombustion(bodies),
        charaKarakas: calculateCharaKarakas(bodies),
        parashariGrahaDrishti: calculateParashariAspects(bodies),
        arudhaPadas: calculateArudhaPadas({
            ascendantSign,
            bodies,
        }),
        vimshottariDasha: calculateVimshottariDasha({
            moonLongitude: bodyByName.get('Луна')?.sidereal?.longitudeDegrees,
            birthDate: date,
            referenceDate: periodReferenceDate,
        }),
        harmonicNote:
            'D1–D60 ниже являются строгими математическими гармоническими проекциями n×долгота. Это не подмена специальных традиционных правил отдельных варг (Hora, Drekkana, Trimshamsha и др.).',
        bhavaChalitReference: {
            primarySystem: 'Whole Sign',
            comparisonSystems: Object.values(houseSystems).map(({ code, name }) => ({ code, name })),
        },
        panchangaSnapshot: {
            tithi: panchanga.tithi.name,
            nakshatra: panchanga.nakshatra.name,
            yoga: panchanga.yoga.name,
            karana: panchanga.karana.name,
            vara: panchanga.vara.name,
        },
        lagna: zodiacRecord(ascendant),
    };
}

export function calculateHarmonicCharts({ ascendant, bodies, maxDivision }) {
    const points = [
        { name: 'Лагна', longitude: ascendant },
        ...bodies
            .filter((body) => body.sidereal)
            .map((body) => ({
                name: body.name,
                longitude: body.sidereal.longitudeDegrees,
            })),
    ];
    const charts = {};

    for (let division = 1; division <= maxDivision; division += 1) {
        charts[`D${division}`] = {
            division,
            method: 'harmonic longitude = normalize(D × sidereal longitude)',
            points: points.map((point) => {
                const harmonicLongitude = normalizeDegrees(point.longitude * division);
                return {
                    name: point.name,
                    longitudeDegrees: harmonicLongitude,
                    signIndex: Math.floor(harmonicLongitude / 30),
                    sign: RASHI_NAMES[Math.floor(harmonicLongitude / 30)],
                    degreesInSign: harmonicLongitude % 30,
                };
            }),
        };
    }

    return charts;
}

function calculateFixedStars({
    api,
    constants,
    julianUt,
    ephemerisFlag,
    speedFlag,
    siderealFlag,
    warnings,
}) {
    const fn = typeof api.fixstar2_ut === 'function'
        ? api.fixstar2_ut.bind(api)
        : typeof api.fixstar_ut === 'function'
            ? api.fixstar_ut.bind(api)
            : null;
    if (!fn) {
        return [];
    }

    const result = [];

    for (const star of REQUESTED_FIXED_STARS) {
        const calculated = safeApiResult(
            () => fn(star, julianUt, ephemerisFlag | speedFlag | siderealFlag),
            `фиксированная звезда ${star}`,
            warnings,
            { suppressWarning: true },
        );
        if (!calculated?.data) {
            continue;
        }
        result.push({
            requestedName: star,
            resolvedName: calculated.name ?? star,
            position: eclipticRecord(calculated.data),
            magnitude: typeof api.fixstar2_mag === 'function'
                ? safeCall(() => api.fixstar2_mag(star)?.data, null)
                : typeof api.fixstar_mag === 'function'
                    ? safeCall(() => api.fixstar_mag(star)?.data, null)
                    : null,
        });
    }

    return result;
}

function buildJyotishBodyRecord({ name, position, ascendantSign }) {
    const longitude = position.longitudeDegrees;
    const signIndex = Math.floor(longitude / 30);
    const house = ((signIndex - ascendantSign + 12) % 12) + 1;
    return {
        signIndex,
        sign: RASHI_NAMES[signIndex],
        degreesInSign: longitude % 30,
        wholeSignHouse: house,
        nakshatra: calculateNakshatra(longitude),
        retrograde: (position.longitudeSpeedDegreesPerDay ?? 0) < 0,
        signLord: RASHI_LORDS[signIndex],
        dignity: DIGNITIES[name] ? calculateDignityFromSign(name, signIndex) : null,
    };
}

function calculateDignity(body) {
    return {
        body: body.name,
        sign: body.jyotish.sign,
        status: calculateDignityFromSign(body.name, body.jyotish.signIndex),
    };
}

function calculateDignityFromSign(name, signIndex) {
    const dignity = DIGNITIES[name];
    if (!dignity) {
        return null;
    }
    if (dignity.exalted === signIndex) return 'экзальтация';
    if (dignity.debilitated === signIndex) return 'падение';
    if (dignity.moolatrikona === signIndex) return 'мулатрикона';
    if (dignity.own.includes(signIndex)) return 'собственный знак';
    return 'нейтральный/требует таблицы отношений';
}

function calculateCombustion(bodies) {
    const sun = findBody(bodies, 'Солнце');
    if (!sun) return [];
    return bodies
        .filter((body) => COMBUSTION_ORBS[body.name] && body.sidereal)
        .map((body) => {
            const separation = shortestAngularDistance(
                sun.sidereal.longitudeDegrees,
                body.sidereal.longitudeDegrees,
            );
            const threshold = COMBUSTION_ORBS[body.name];
            return {
                body: body.name,
                separationFromSunDegrees: separation,
                referenceOrbDegrees: threshold,
                combustByReferenceOrb: separation <= threshold,
            };
        });
}

function findPlanetaryWars(bodies) {
    const names = new Set(['Меркурий', 'Венера', 'Марс', 'Юпитер', 'Сатурн']);
    const candidates = bodies.filter((body) => names.has(body.name));
    const wars = [];
    for (let i = 0; i < candidates.length; i += 1) {
        for (let j = i + 1; j < candidates.length; j += 1) {
            const separation = shortestAngularDistance(
                candidates[i].sidereal.longitudeDegrees,
                candidates[j].sidereal.longitudeDegrees,
            );
            if (separation <= 1) {
                wars.push({
                    body1: candidates[i].name,
                    body2: candidates[j].name,
                    separationDegrees: separation,
                    note: 'Кандидат на граха-йуддху; победителя определяют по традиционно выбранному критерию широты/яркости/диска.',
                });
            }
        }
    }
    return wars;
}

function calculateCharaKarakas(bodies) {
    const names = ['Солнце', 'Луна', 'Марс', 'Меркурий', 'Юпитер', 'Венера', 'Сатурн'];
    const labels = [
        'Атмакарака', 'Аматьякарака', 'Бхратрикарака', 'Матрикарака',
        'Путракарака', 'Гнатикарака', 'Даракарака',
    ];
    return names
        .map((name) => findBody(bodies, name))
        .filter(Boolean)
        .map((body) => ({
            body: body.name,
            degreesInSign: body.jyotish.degreesInSign,
        }))
        .sort((a, b) => b.degreesInSign - a.degreesInSign)
        .map((item, index) => ({
            karaka: labels[index],
            ...item,
        }));
}

function calculateParashariAspects(bodies) {
    const offsets = {
        Марс: [4, 7, 8],
        Юпитер: [5, 7, 9],
        Сатурн: [3, 7, 10],
    };
    const defaultOffsets = [7];
    const result = [];

    for (const body of bodies) {
        if (!body.jyotish || ['Раху истинный', 'Кету истинный'].includes(body.name)) {
            continue;
        }
        const fromSign = body.jyotish.signIndex;
        for (const offset of offsets[body.name] ?? defaultOffsets) {
            const targetSign = (fromSign + offset - 1) % 12;
            result.push({
                body: body.name,
                aspectNumber: offset,
                targetSignIndex: targetSign,
                targetSign: RASHI_NAMES[targetSign],
            });
        }
    }
    return result;
}

function calculateArudhaPadas({ ascendantSign, bodies }) {
    const bodyByName = new Map(bodies.map((body) => [body.name, body]));
    return Array.from({ length: 12 }, (_, index) => {
        const houseSign = (ascendantSign + index) % 12;
        const lordName = RASHI_LORDS[houseSign];
        const lord = bodyByName.get(lordName);
        if (!lord?.jyotish) {
            return { house: index + 1, unavailable: true };
        }
        const distance = ((lord.jyotish.signIndex - houseSign + 12) % 12) + 1;
        let arudhaSign = (lord.jyotish.signIndex + distance - 1) % 12;
        if (arudhaSign === houseSign || arudhaSign === (houseSign + 6) % 12) {
            arudhaSign = (arudhaSign + 9) % 12;
        }
        return {
            house: index + 1,
            houseSign: RASHI_NAMES[houseSign],
            lord: lordName,
            lordSign: lord.jyotish.sign,
            arudhaSignIndex: arudhaSign,
            arudhaSign: RASHI_NAMES[arudhaSign],
        };
    });
}

export function calculateVimshottariDasha({
    moonLongitude,
    birthDate,
    referenceDate = birthDate,
}) {
    if (
        !Number.isFinite(moonLongitude) ||
        !(birthDate instanceof Date) ||
        Number.isNaN(birthDate.getTime()) ||
        !(referenceDate instanceof Date) ||
        Number.isNaN(referenceDate.getTime())
    ) {
        return null;
    }

    const nakshatra = calculateNakshatra(moonLongitude);
    const sequenceIndex = (nakshatra.index - 1) % 9;
    const [startingLord, startingYears] = VIMSHOTTARI_SEQUENCE[sequenceIndex];
    const elapsedFraction = nakshatra.degreesInNakshatra / NAKSHATRA_SIZE;
    const elapsedYears = startingYears * elapsedFraction;
    const remainingYears = startingYears - elapsedYears;
    const yearLengthDays = 365.2425;
    const msPerYear = yearLengthDays * 86400000;
    const cycleStart = new Date(birthDate.getTime() - elapsedYears * msPerYear);
    const firstMahadashaEnd = new Date(
        birthDate.getTime() + remainingYears * msPerYear,
    );
    const mahadashas = [];
    let mahaCursor = new Date(cycleStart);

    for (let i = 0; i < VIMSHOTTARI_SEQUENCE.length; i += 1) {
        const index = (sequenceIndex + i) % VIMSHOTTARI_SEQUENCE.length;
        const [lord, years] = VIMSHOTTARI_SEQUENCE[index];
        const periodStart = new Date(mahaCursor);
        const periodEnd = new Date(mahaCursor.getTime() + years * msPerYear);
        const antardashas = buildVimshottariSubPeriods({
            parentStart: periodStart,
            parentYears: years,
            startingLordIndex: index,
            referenceDate,
            msPerYear,
            includePratyantardasha: true,
        });

        mahadashas.push({
            lord,
            years,
            startUtcIso: periodStart.toISOString(),
            endUtcIso: periodEnd.toISOString(),
            activeAtReference: referenceDate >= periodStart && referenceDate < periodEnd,
            antardashas,
        });
        mahaCursor = periodEnd;
    }

    const activeMahadasha = mahadashas.find((item) => item.activeAtReference) ?? null;
    const activeAntardasha = activeMahadasha?.antardashas.find(
        (item) => item.activeAtReference,
    ) ?? null;
    const activePratyantardasha = activeAntardasha?.pratyantardashas.find(
        (item) => item.activeAtReference,
    ) ?? null;

    return {
        moonNakshatra: nakshatra.name,
        startingLord,
        elapsedFractionOfStartingMahadasha: elapsedFraction,
        balanceYearsAtBirth: remainingYears,
        birthTimeUtcIso: birthDate.toISOString(),
        referenceTimeUtcIso: referenceDate.toISOString(),
        estimatedCycleStartUtcIso: cycleStart.toISOString(),
        estimatedStartingMahadashaEndUtcIso: firstMahadashaEnd.toISOString(),
        yearLengthDays,
        mahadashas,
        timeline: mahadashas,
        activeMahadasha: activeMahadasha
            ? compactPeriodReference(activeMahadasha)
            : null,
        activeAntardasha: activeAntardasha
            ? compactPeriodReference(activeAntardasha)
            : null,
        activePratyantardasha: activePratyantardasha
            ? compactPeriodReference(activePratyantardasha)
            : null,
        coverage: {
            mahadashaCount: mahadashas.length,
            antardashaCount: mahadashas.reduce(
                (sum, item) => sum + item.antardashas.length,
                0,
            ),
            pratyantardashaCount: mahadashas.reduce(
                (sum, item) => sum + item.antardashas.reduce(
                    (inner, antara) => inner + antara.pratyantardashas.length,
                    0,
                ),
                0,
            ),
        },
        note: `Календарное преобразование использует средний тропический год ${yearLengthDays} суток. Рассчитаны маха-, антар- и пратьянтар-даши полного 120-летнего цикла.`,
    };
}

function buildVimshottariSubPeriods({
    parentStart,
    parentYears,
    startingLordIndex,
    referenceDate,
    msPerYear,
    includePratyantardasha = false,
}) {
    const periods = [];
    let cursor = new Date(parentStart);

    for (let i = 0; i < VIMSHOTTARI_SEQUENCE.length; i += 1) {
        const index = (startingLordIndex + i) % VIMSHOTTARI_SEQUENCE.length;
        const [lord, lordYears] = VIMSHOTTARI_SEQUENCE[index];
        const years = parentYears * lordYears / 120;
        const periodStart = new Date(cursor);
        const periodEnd = new Date(cursor.getTime() + years * msPerYear);
        const item = {
            lord,
            years,
            startUtcIso: periodStart.toISOString(),
            endUtcIso: periodEnd.toISOString(),
            activeAtReference: referenceDate >= periodStart && referenceDate < periodEnd,
        };

        if (includePratyantardasha) {
            item.pratyantardashas = buildVimshottariSubPeriods({
                parentStart: periodStart,
                parentYears: years,
                startingLordIndex: index,
                referenceDate,
                msPerYear,
                includePratyantardasha: false,
            });
        }

        periods.push(item);
        cursor = periodEnd;
    }

    return periods;
}

function compactPeriodReference(period) {
    return {
        lord: period.lord,
        years: period.years,
        startUtcIso: period.startUtcIso,
        endUtcIso: period.endUtcIso,
    };
}

function calculateTithi(sunLongitude, moonLongitude) {
    const elongation = normalizeDegrees(moonLongitude - sunLongitude);
    const absoluteIndex = Math.floor(elongation / 12) + 1;
    const paksha = absoluteIndex <= 15 ? 'Шукла-пакша' : 'Кришна-пакша';
    const pakshaIndex = ((absoluteIndex - 1) % 15) + 1;
    const name = pakshaIndex === 15
        ? absoluteIndex === 15 ? 'Пурнима' : 'Амавасья'
        : TITHI_NAMES[pakshaIndex - 1];
    return {
        absoluteIndex,
        paksha,
        pakshaIndex,
        name,
        completionPercent: ((elongation % 12) / 12) * 100,
        elongation,
    };
}

function calculateNakshatra(longitude) {
    const normalized = normalizeDegrees(longitude);
    const index = Math.min(26, Math.floor(normalized / NAKSHATRA_SIZE));
    const within = normalized - index * NAKSHATRA_SIZE;
    const pada = Math.min(4, Math.floor(within / (NAKSHATRA_SIZE / 4)) + 1);
    return {
        index: index + 1,
        name: NAKSHATRA_NAMES[index],
        pada,
        degreesInNakshatra: within,
        completionPercent: within / NAKSHATRA_SIZE * 100,
    };
}

function calculateYoga(sunLongitude, moonLongitude) {
    const sum = normalizeDegrees(sunLongitude + moonLongitude);
    const index = Math.floor(sum / NAKSHATRA_SIZE);
    return {
        index: index + 1,
        name: YOGA_NAMES[index],
        degreesInYoga: sum % NAKSHATRA_SIZE,
        completionPercent: (sum % NAKSHATRA_SIZE) / NAKSHATRA_SIZE * 100,
    };
}

function calculateKarana(sunLongitude, moonLongitude) {
    const elongation = normalizeDegrees(moonLongitude - sunLongitude);
    const halfTithiIndex = Math.floor(elongation / 6) + 1;
    let name;
    if (halfTithiIndex === 1) name = 'Кимстугхна';
    else if (halfTithiIndex >= 58) {
        name = ['Шакуни', 'Чатушпада', 'Нага'][halfTithiIndex - 58] ?? 'Кимстугхна';
    } else {
        name = KARANA_SEQUENCE[(halfTithiIndex - 2) % 7];
    }
    return {
        halfTithiIndex,
        name,
        completionPercent: ((elongation % 6) / 6) * 100,
    };
}

function eclipticRecord(data) {
    const longitude = normalizeDegrees(data[0]);
    return {
        longitudeDegrees: longitude,
        latitudeDegrees: finiteOrNull(data[1]),
        distanceAu: finiteOrNull(data[2]),
        longitudeSpeedDegreesPerDay: finiteOrNull(data[3]),
        latitudeSpeedDegreesPerDay: finiteOrNull(data[4]),
        distanceSpeedAuPerDay: finiteOrNull(data[5]),
        zodiac: zodiacRecord(longitude),
    };
}

function equatorialRecord(data) {
    return {
        rightAscensionDegrees: normalizeDegrees(data[0]),
        rightAscensionHours: normalizeHours(data[0] / 15),
        declinationDegrees: finiteOrNull(data[1]),
        distanceAu: finiteOrNull(data[2]),
        rightAscensionSpeedDegreesPerDay: finiteOrNull(data[3]),
        declinationSpeedDegreesPerDay: finiteOrNull(data[4]),
        distanceSpeedAuPerDay: finiteOrNull(data[5]),
    };
}

function calcArrayRecord(data) {
    if (!Array.isArray(data)) return null;
    return {
        longitudeDegrees: normalizeDegrees(data[0]),
        latitudeDegrees: finiteOrNull(data[1]),
        distanceAu: finiteOrNull(data[2]),
        longitudeSpeedDegreesPerDay: finiteOrNull(data[3]),
        latitudeSpeedDegreesPerDay: finiteOrNull(data[4]),
        distanceSpeedAuPerDay: finiteOrNull(data[5]),
    };
}

function zodiacRecord(longitude) {
    const normalized = normalizeDegrees(longitude);
    const signIndex = Math.floor(normalized / 30);
    return {
        absoluteLongitudeDegrees: normalized,
        signIndex,
        sign: RASHI_NAMES[signIndex],
        degreesInSign: normalized % 30,
        formatted: `${RASHI_NAMES[signIndex]} ${formatDegrees(normalized % 30)}`,
    };
}

function buildCoverage({ bodies, houseSystems, harmonicCharts, fixedStars }) {
    const coordinateFrames = bodies.reduce((sum, body) => sum + [
        body.sidereal,
        body.tropical,
        body.topocentricSidereal,
        body.equatorial,
        body.topocentricEquatorial,
        body.horizontal,
    ].filter(Boolean).length, 0);
    return {
        bodyCount: bodies.length,
        coordinateFrameCount: coordinateFrames,
        houseSystemCount: Object.keys(houseSystems).length,
        harmonicChartCount: Object.keys(harmonicCharts).length,
        fixedStarCount: fixedStars.length,
        serializedJsonCharacters: null,
    };
}

export function buildMaximumCalculationAudit(result) {
    const bodyByName = new Map(result.bodies.map((body) => [body.name, body]));
    const missingPrimaryBodies = MAXIMUM_PRIMARY_BODY_NAMES.filter(
        (name) => !bodyByName.has(name),
    );
    const missingRequestedBodies = MAXIMUM_REQUESTED_BODY_NAMES.filter(
        (name) => !bodyByName.has(name),
    );
    const missingHouseSystems = HOUSE_SYSTEMS
        .map(([code]) => code)
        .filter((code) => !result.houseSystems[code]);
    const missingHarmonics = Array.from({ length: 60 }, (_, index) => index + 1)
        .filter((division) => !result.harmonicCharts[`D${division}`]);
    const missingFixedStars = REQUESTED_FIXED_STARS.filter(
        (name) => !result.fixedStars.some((star) =>
            String(star.requestedName).toLowerCase() === name.toLowerCase()),
    );
    const primaryCoordinateGaps = MAXIMUM_PRIMARY_BODY_NAMES.flatMap((name) => {
        const body = bodyByName.get(name);
        if (!body) return [];
        const missing = [
            ['sidereal', body.sidereal],
            ['tropical', body.tropical],
            ['topocentricSidereal', body.topocentricSidereal],
            ['equatorial', body.equatorial],
            ['topocentricEquatorial', body.topocentricEquatorial],
            ['horizontal', body.horizontal],
        ].filter(([, value]) => !value).map(([frame]) => frame);
        return missing.length ? [{ body: name, missing }] : [];
    });
    const panchangaBoundaryGaps = [
        ['tithi', result.panchanga?.tithi?.end],
        ['nakshatra', result.panchanga?.nakshatra?.end],
        ['yoga', result.panchanga?.yoga?.end],
        ['karana', result.panchanga?.karana?.end],
    ].filter(([, value]) => !value).map(([name]) => name);
    const dasha = result.jyotishDerived?.vimshottariDasha;
    const criticalIssues = [];

    if (missingPrimaryBodies.length) {
        criticalIssues.push(`missing-primary-bodies:${missingPrimaryBodies.join(',')}`);
    }
    if (!result.houseSystems?.W || result.houseSystems.W.cusps?.length !== 12) {
        criticalIssues.push('whole-sign-houses-incomplete');
    }
    if (missingHarmonics.length) {
        criticalIssues.push(`missing-harmonics:${missingHarmonics.join(',')}`);
    }
    if (panchangaBoundaryGaps.length) {
        criticalIssues.push(`panchanga-boundaries:${panchangaBoundaryGaps.join(',')}`);
    }
    if (!dasha || dasha.coverage?.mahadashaCount !== 9) {
        criticalIssues.push('vimshottari-mahadasha-incomplete');
    }
    if (dasha && dasha.coverage?.antardashaCount !== 81) {
        criticalIssues.push('vimshottari-antardasha-incomplete');
    }
    if (dasha && dasha.coverage?.pratyantardashaCount !== 729) {
        criticalIssues.push('vimshottari-pratyantardasha-incomplete');
    }

    return {
        profile: 'maximum-available-v1',
        completeForDeclaredScope: criticalIssues.length === 0,
        precision: result.engine.coreCalculationsUsedSwissFiles
            ? 'swiss-files-confirmed'
            : 'moshier-or-mixed-fallback',
        strictSwissFilesRequired: result.engine.strictSwissFilesRequired,
        fallbackUsed: result.engine.fallbackUsed,
        criticalIssues,
        optionalGaps: {
            missingRequestedBodies,
            missingHouseSystems,
            missingFixedStars,
            primaryCoordinateGaps,
            nonSwissDirectPrimaryBodies:
                result.engine.ephemerisUsage?.nonSwissDirectPrimaryBodies ?? [],
        },
        counts: {
            requestedBodies: MAXIMUM_REQUESTED_BODY_NAMES.length,
            calculatedBodies: result.bodies.length,
            primaryBodies: result.primaryJyotishBodies.length,
            requestedHouseSystems: HOUSE_SYSTEMS.length,
            calculatedHouseSystems: Object.keys(result.houseSystems).length,
            harmonics: Object.keys(result.harmonicCharts).length,
            requestedFixedStars: REQUESTED_FIXED_STARS.length,
            calculatedFixedStars: result.fixedStars.length,
            warnings: result.warnings.length,
            directPrimaryEphemerisBodies:
                result.engine.ephemerisUsage?.directPrimary?.length ?? 0,
            directPrimarySwissBodies:
                result.engine.ephemerisUsage?.directPrimary?.filter((item) => item.usesSwiss).length ?? 0,
            directPrimaryMoshierBodies:
                result.engine.ephemerisUsage?.directPrimary?.filter((item) => item.usesMoshier).length ?? 0,
        },
        guarantees: [
            'All declared core bodies, Whole Sign houses, D1-D60 harmonic projections, panchanga boundaries and Vimshottari maha/antara/pratyantara periods are present.',
            'The packed maximum payload contains every locally calculated field without the shorter LLM profile omissions or silent truncation.',
            'A missing declared-core calculation aborts the request instead of being silently replaced by model invention.',
        ],
        limitations: [
            'Optional asteroids, stars, house systems and coordinate frames depend on the installed sweph API and ephemeris files; every gap is listed in optionalGaps and warnings.',
            'The engine validates actual calc_ut return flags, not only the presence of *.se1 files. Without confirmed SEFLG_SWIEPH it explicitly reports Moshier or mixed fallback; ASTROLOGY_REQUIRE_SWISS_FILES=1 forbids that fallback.',
            'D1-D60 are mathematical harmonic projections; this audit does not claim implementation of every school-specific traditional varga mapping, yoga, shadbala or ashtakavarga system.',
        ],
    };
}

export function assertMaximumCalculationAudit(audit) {
    if (!audit?.completeForDeclaredScope) {
        throw new Error(
            `Максимальный локальный расчёт неполон: ${(audit?.criticalIssues ?? []).join('; ') || 'неизвестная причина'}`,
        );
    }
}

function buildCompactGptPayload(result) {
    const bodyFields = [
        'name', 'id', 'category', 'derivedFrom',
        'sidLon', 'sidLat', 'sidDistAu', 'sidLonSpeed', 'sidLatSpeed', 'sidDistSpeed',
        'tropLon', 'tropLat', 'tropDistAu', 'tropLonSpeed', 'tropLatSpeed', 'tropDistSpeed',
        'topoSidLon', 'topoSidLat', 'topoSidDistAu', 'topoSidLonSpeed', 'topoSidLatSpeed', 'topoSidDistSpeed',
        'raDeg', 'decDeg', 'eqDistAu', 'raSpeed', 'decSpeed', 'eqDistSpeed',
        'topoRaDeg', 'topoDecDeg', 'topoEqDistAu', 'topoRaSpeed', 'topoDecSpeed', 'topoEqDistSpeed',
        'azDeg', 'trueAltDeg', 'apparentAltDeg',
        'phaseAngle', 'illumination', 'elongation', 'diameter', 'magnitude', 'parallax',
        'sign', 'degInSign', 'house', 'nakshatra', 'pada', 'retrograde', 'dignity',
        'calculationFlags', 'orbitalElements', 'nodesApsides', 'events',
    ];
    const bodyRows = result.bodies.map((body) => [
        body.name,
        body.id,
        body.category,
        body.derivedFrom ?? null,
        body.sidereal?.longitudeDegrees ?? null,
        body.sidereal?.latitudeDegrees ?? null,
        body.sidereal?.distanceAu ?? null,
        body.sidereal?.longitudeSpeedDegreesPerDay ?? null,
        body.sidereal?.latitudeSpeedDegreesPerDay ?? null,
        body.sidereal?.distanceSpeedAuPerDay ?? null,
        body.tropical?.longitudeDegrees ?? null,
        body.tropical?.latitudeDegrees ?? null,
        body.tropical?.distanceAu ?? null,
        body.tropical?.longitudeSpeedDegreesPerDay ?? null,
        body.tropical?.latitudeSpeedDegreesPerDay ?? null,
        body.tropical?.distanceSpeedAuPerDay ?? null,
        body.topocentricSidereal?.longitudeDegrees ?? null,
        body.topocentricSidereal?.latitudeDegrees ?? null,
        body.topocentricSidereal?.distanceAu ?? null,
        body.topocentricSidereal?.longitudeSpeedDegreesPerDay ?? null,
        body.topocentricSidereal?.latitudeSpeedDegreesPerDay ?? null,
        body.topocentricSidereal?.distanceSpeedAuPerDay ?? null,
        body.equatorial?.rightAscensionDegrees ?? null,
        body.equatorial?.declinationDegrees ?? null,
        body.equatorial?.distanceAu ?? null,
        body.equatorial?.rightAscensionSpeedDegreesPerDay ?? null,
        body.equatorial?.declinationSpeedDegreesPerDay ?? null,
        body.equatorial?.distanceSpeedAuPerDay ?? null,
        body.topocentricEquatorial?.rightAscensionDegrees ?? null,
        body.topocentricEquatorial?.declinationDegrees ?? null,
        body.topocentricEquatorial?.distanceAu ?? null,
        body.topocentricEquatorial?.rightAscensionSpeedDegreesPerDay ?? null,
        body.topocentricEquatorial?.declinationSpeedDegreesPerDay ?? null,
        body.topocentricEquatorial?.distanceSpeedAuPerDay ?? null,
        body.horizontal?.azimuthDegrees ?? null,
        body.horizontal?.trueAltitudeDegrees ?? null,
        body.horizontal?.apparentAltitudeDegrees ?? null,
        body.phenomena?.phaseAngleDegrees ?? null,
        body.phenomena?.illuminatedFraction ?? null,
        body.phenomena?.elongationDegrees ?? null,
        body.phenomena?.apparentDiameterDegrees ?? null,
        body.phenomena?.apparentMagnitude ?? null,
        body.phenomena?.horizontalParallaxDegrees ?? null,
        body.jyotish?.sign ?? null,
        body.jyotish?.degreesInSign ?? null,
        body.jyotish?.wholeSignHouse ?? null,
        body.jyotish?.nakshatra?.name ?? null,
        body.jyotish?.nakshatra?.pada ?? null,
        body.jyotish?.retrograde ?? null,
        body.jyotish?.dignity ?? null,
        compactObject(body.calculationFlags),
        compactObject(body.orbitalElements),
        compactObject(body.nodesAndApsides),
        compactObject(body.events),
    ]);

    const harmonicPointNames = result.harmonicCharts.D1?.points.map((point) => point.name) ?? [];
    const harmonicRows = Object.values(result.harmonicCharts).map((chart) => [
        chart.division,
        chart.points.map((point) => roundNumber(point.longitudeDegrees, 8)),
    ]);

    const houseSystems = Object.values(result.houseSystems).map((system) => [
        system.code,
        system.name,
        system.cusps.map((cusp) => roundNumber(cusp.longitude, 8)),
        system.cusps.map((cusp) => roundNumber(cusp.speedDegreesPerDay, 8)),
        [
            system.points.ascendant,
            system.points.mc,
            system.points.armc,
            system.points.vertex,
            system.points.equatorialAscendant,
            system.points.coAscendantKoch,
            system.points.coAscendantMunkasey,
            system.points.polarAscendant,
        ].map((value) => roundNumber(value, 8)),
        [
            system.pointSpeeds.ascendant,
            system.pointSpeeds.mc,
            system.pointSpeeds.armc,
            system.pointSpeeds.vertex,
            system.pointSpeeds.equatorialAscendant,
            system.pointSpeeds.coAscendantKoch,
            system.pointSpeeds.coAscendantMunkasey,
            system.pointSpeeds.polarAscendant,
        ].map((value) => roundNumber(value, 8)),
    ]);

    return stableStringify({
        schema: result.schema,
        codebook: {
            bodyFields,
            harmonicPointNames,
            harmonicRule: 'longitude_Dn = normalize(n * sidereal_longitude_Lahiri)',
            units: {
                angles: 'degrees',
                speeds: 'degrees/day',
                distance: 'AU',
                events: 'UTC ISO and JD UT',
            },
        },
        input: result.input,
        engine: result.engine,
        time: result.time,
        ayanamsas: result.ayanamsas,
        angles: result.angles,
        panchanga: result.panchanga,
        houseSystems,
        bodies: bodyRows,
        relationships: result.relationships,
        jyotishDerived: result.jyotishDerived,
        harmonicsD1toD60: harmonicRows,
        fixedStars: result.fixedStars,
        calculationScope: result.calculationScope,
        audit: result.audit,
        warnings: result.warnings,
        coverage: result.coverage,
    }, 0);
}


/*
 * Компактный отчёт для LLM. Полный расчёт всё равно выполняется и остаётся
 * в result.data, но модель получает только уникальные, астрологически полезные
 * поля. Все D1–D60 и все системы домов сохраняются в сжатом виде.
 */
function buildOptimizedGptPayload(result, profile = 'balanced') {
    const fast = profile === 'fast';
    const full = profile === 'full';
    const primaryNames = new Set(result.primaryJyotishBodies);
    const primary = result.bodies.filter((body) => primaryNames.has(body.name));
    const fmt = (value, digits = 4) => Number.isFinite(Number(value))
        ? Number(value).toFixed(digits).replace(/0+$/u, '').replace(/\.$/u, '')
        : '-';
    const bool = (value) => value ? 'R' : 'D';
    const lines = [
        'PRASHNA_SWEPH_COMPACT_V3',
        `UTC|${result.input.requestTimeUtc}`,
        `LOC|${result.input.locationName}|${fmt(result.input.latitude, 6)}|${fmt(result.input.longitude, 6)}|alt=${fmt(result.input.altitudeMeters, 0)}`,
        `ENGINE|${result.engine.calculationEngine}|version=${result.engine.version}|ayan=Lahiri|files=${result.engine.highPrecisionFilesLoaded ? 1 : 0}`,
        `TIME|jdUT=${fmt(result.time.julianDayUt, 7)}|jdET=${fmt(result.time.julianDayEt, 7)}|dT=${fmt(result.time.deltaTSeconds, 3)}|LST=${fmt(result.time.localSiderealTimeHours, 5)}`,
        `ASC|lon=${fmt(result.angles.ascendant.absoluteLongitudeDegrees, 5)}|sign=${result.angles.ascendant.sign}|deg=${fmt(result.angles.ascendant.degreesInSign, 4)}|nak=${result.angles.ascendantNakshatra.name}|pada=${result.angles.ascendantNakshatra.pada}|lord=${result.angles.ascendantSignLord}`,
        `PANCHANGA|vara=${result.panchanga.vara.name}|tithi=${result.panchanga.tithi.name}|paksha=${result.panchanga.tithi.paksha}|nak=${result.panchanga.nakshatra.name}|yoga=${result.panchanga.yoga.name}|karana=${result.panchanga.karana.name}`,
        '',
        'GRAHAS|name|sidLon|sign|deg|H|nak|pada|speed|dir|dignity',
        ...primary.map((body) => [
            body.name,
            fmt(body.sidereal?.longitudeDegrees, 5),
            body.jyotish?.sign ?? '-',
            fmt(body.jyotish?.degreesInSign, 4),
            body.jyotish?.wholeSignHouse ?? '-',
            body.jyotish?.nakshatra?.name ?? '-',
            body.jyotish?.nakshatra?.pada ?? '-',
            fmt(body.sidereal?.longitudeSpeedDegreesPerDay, 5),
            bool(body.jyotish?.retrograde),
            body.jyotish?.dignity ?? '-',
        ].join('|')),
        '',
        'ALL_BODIES_TECH|name|sidLon|sidLat|tropLon|topoSidLon|RA|Dec|Az|Alt|distAU',
        ...result.bodies.map((body) => [
            body.name,
            fmt(body.sidereal?.longitudeDegrees, 4),
            fmt(body.sidereal?.latitudeDegrees, 4),
            fmt(body.tropical?.longitudeDegrees, 4),
            fmt(body.topocentricSidereal?.longitudeDegrees, 4),
            fmt(body.equatorial?.rightAscensionDegrees, 4),
            fmt(body.equatorial?.declinationDegrees, 4),
            fmt(body.horizontal?.azimuthDegrees, 3),
            fmt(body.horizontal?.apparentAltitudeDegrees, 3),
            fmt(body.sidereal?.distanceAu, 7),
        ].join('|')),
        '',
        'HOUSE_SYSTEMS|code|name|ASC|MC|cusps1-12',
        ...Object.values(result.houseSystems).map((system) => [
            system.code,
            system.name,
            fmt(system.points?.ascendant, 4),
            fmt(system.points?.mc, 4),
            system.cusps.map((cusp) => fmt(cusp.longitude, 3)).join(','),
        ].join('|')),
        '',
        'WHOLE_SIGN_LORDS|house:sign:lord:lordHouse',
        result.jyotishDerived.wholeSignHouseLords
            .map((item) => `${item.house}:${item.sign}:${item.lord}:${item.lordHouse ?? '-'}`)
            .join('|'),
        '',
        'MAJOR_ASPECTS|body1|body2|aspect|angle|orb|applying',
        ...(fast
            ? result.relationships.majorAspects.slice(0, 24)
            : full
                ? result.relationships.majorAspects
                : result.relationships.majorAspects.slice(0, 60))
            .map((aspect) => [
                aspect.body1,
                aspect.body2,
                aspect.aspect,
                fmt(aspect.actualAngleDegrees, 3),
                fmt(aspect.orbDegrees, 3),
                aspect.applyingApprox ? 1 : 0,
            ].join('|')),
        '',
        `DIGNITIES|${result.jyotishDerived.dignities.map((x) => `${x.body}:${x.sign}:${x.status}`).join('|')}`,
        `COMBUSTION|${result.jyotishDerived.combustion.map((x) => `${x.body}:${fmt(x.separationFromSunDegrees, 3)}:${x.combustByReferenceOrb ? 1 : 0}`).join('|')}`,
        `CHARA_KARAKAS|${result.jyotishDerived.charaKarakas.map((x) => `${x.karaka}:${x.body}:${fmt(x.degreesInSign, 3)}`).join('|')}`,
        `ARUDHA|${result.jyotishDerived.arudhaPadas.map((x) => `A${x.house}:${x.arudhaSign}`).join('|')}`,
        `VIMSHOTTARI|${compactDasha(result.jyotishDerived.vimshottariDasha)}`,
        '',
        `HARMONIC_POINTS|${result.harmonicCharts.D1?.points.map((point) => point.name).join('|') ?? ''}`,
        ...Object.values(result.harmonicCharts).map((chart) => {
            const detailed = !fast || [1, 9, 10, 12, 20, 24, 30, 60].includes(chart.division);
            const values = chart.points.map((point) => detailed
                ? `${point.signIndex + 1}:${fmt(point.degreesInSign, fast ? 1 : 2)}`
                : String(point.signIndex + 1));
            return `D${chart.division}|${values.join('|')}`;
        }),
    ];

    if (full) {
        lines.push(
            '',
            'ANGULAR_SEPARATIONS|body1|body2|degrees',
            ...result.relationships.angularSeparationMatrix.map((item) => [
                item.body1,
                item.body2,
                fmt(item.separationDegrees, 4),
            ].join('|')),
            '',
            'PARASHARI_GRAHA_DRISHTI|body|aspectNumber|targetSign',
            ...result.jyotishDerived.parashariGrahaDrishti.map((item) => [
                item.body,
                item.aspectNumber,
                item.targetSign,
            ].join('|')),
            '',
            `PLANETARY_WAR_CANDIDATES|${result.relationships.planetaryWarCandidates
                .map((item) => `${item.body1}:${item.body2}:${fmt(item.separationDegrees, 4)}`)
                .join('|') || '-'}`,
        );
    }

    if (!fast && result.fixedStars.length) {
        lines.push(
            '',
            'FIXED_STARS|name|sidLon|sign|deg|mag',
            ...result.fixedStars.map((star) => [
                star.resolvedName,
                fmt(star.position?.longitudeDegrees, 4),
                star.position?.zodiac?.sign ?? '-',
                fmt(star.position?.zodiac?.degreesInSign, 3),
                fmt(Array.isArray(star.magnitude) ? star.magnitude[0] : star.magnitude, 2),
            ].join('|')),
        );
    }

    if (result.warnings.length) {
        lines.push('', `WARNINGS|${result.warnings.join(' || ')}`);
    }

    lines.push(
        '',
        `PROFILE|${profile}`,
        'NOTES|D1-D60 are mathematical harmonics n*sidereal longitude; Whole Sign is primary; all numbers are locally calculated.',
    );

    return lines.join('\n');
}

function compactDasha(dasha) {
    if (!dasha) return '-';
    const activeMaha = dasha.activeMahadasha;
    const activeAntara = dasha.activeAntardasha;
    const activePratyantara = dasha.activePratyantardasha;
    return [
        `moonNak=${dasha.moonNakshatra}`,
        `startLord=${dasha.startingLord}`,
        `balanceY=${roundNumber(dasha.balanceYearsAtBirth, 3)}`,
        activeMaha ? `maha=${activeMaha.lord}:${activeMaha.startUtcIso}:${activeMaha.endUtcIso}` : 'maha=-',
        activeAntara ? `antara=${activeAntara.lord}:${activeAntara.startUtcIso}:${activeAntara.endUtcIso}` : 'antara=-',
        activePratyantara ? `pratyantara=${activePratyantara.lord}:${activePratyantara.startUtcIso}:${activePratyantara.endUtcIso}` : 'pratyantara=-',
    ].join('|');
}

function compactObject(value) {
    if (!value) return null;
    return JSON.parse(stableStringify(value, 0));
}

function roundNumber(value, digits = 10) {
    if (!Number.isFinite(Number(value))) return null;
    const factor = 10 ** digits;
    return Math.round(Number(value) * factor) / factor;
}

function buildMaximumCalculationText(result) {
    const primary = result.bodies.filter((body) =>
        result.primaryJyotishBodies.includes(body.name),
    );
    const lines = [
        'МАКСИМАЛЬНЫЙ ЛОКАЛЬНЫЙ ТЕХНИЧЕСКИЙ РАСЧЁТ SWISS EPHEMERIS',
        'Все числовые положения уже вычислены локально. GPT должен интерпретировать данные, а не пересчитывать или придумывать их.',
        `Схема данных: ${result.schema}.`,
        `Момент карты UTC: ${result.input.requestTimeUtc}.`,
        `Контрольная дата периодов UTC: ${result.input.periodReferenceTimeUtc}.`,
        `Место: ${result.input.locationName}; ${result.input.latitude.toFixed(6)}°, ${result.input.longitude.toFixed(6)}°; высота ${result.input.altitudeMeters} м; часовой пояс ${result.input.timeZone}.`,
        `Движок: ${result.engine.calculationEngine}; версия ${result.engine.version}; сидерический режим Lahiri.`,
        `JD ET ${result.time.julianDayEt.toFixed(9)}; JD UT ${result.time.julianDayUt.toFixed(9)}; ΔT ${formatOptional(result.time.deltaTSeconds, 4)} с.`,
        `Лагна: ${result.angles.ascendant.formatted}; накшатра ${result.angles.ascendantNakshatra.name}, пада ${result.angles.ascendantNakshatra.pada}.`,
        `Панчанга: ${result.panchanga.vara.name}; ${result.panchanga.tithi.name} (${result.panchanga.tithi.paksha}); накшатра ${result.panchanga.nakshatra.name}; йога ${result.panchanga.yoga.name}; карана ${result.panchanga.karana.name}.`,
        '',
        'ОСНОВНЫЕ ГРАХИ:',
        ...primary.map((body) => [
            `${body.name}: ${body.sidereal.zodiac.formatted}`,
            `дом ${body.jyotish.wholeSignHouse}`,
            `накшатра ${body.jyotish.nakshatra.name}, пада ${body.jyotish.nakshatra.pada}`,
            `λ ${body.sidereal.longitudeDegrees.toFixed(8)}°`,
            `β ${formatOptional(body.sidereal.latitudeDegrees, 8)}°`,
            `r ${formatOptional(body.sidereal.distanceAu, 9)} AU`,
            `скорость λ ${formatOptional(body.sidereal.longitudeSpeedDegreesPerDay, 8)}°/сут`,
            body.jyotish.retrograde ? 'ретроградно' : 'директно',
        ].join('; ')),
        '',
        `Покрытие: тел ${result.coverage.bodyCount}; систем домов ${result.coverage.houseSystemCount}; гармонических карт D1–D${result.coverage.harmonicChartCount}; фиксированных звёзд ${result.coverage.fixedStarCount}.`,
        'Максимальный упакованный пакет содержит все рассчитанные поля: тропические, сидерические, геоцентрические, топоцентрические, экваториальные и горизонтальные координаты; скорости, расстояния, физические параметры диска, орбитальные элементы, узлы/апсиды, восходы/заходы/транзиты, все доступные системы домов, панчангу с моментами окончания, аспекты, достоинства, сожжение, чара-караки, арудха-пады, маха/антар/пратьянтар-даши и D1–D60.',
    ];

    if (result.warnings.length) {
        lines.push(
            '',
            'ТЕХНИЧЕСКИЕ ПРЕДУПРЕЖДЕНИЯ/НЕДОСТУПНЫЕ ОПЦИИ:',
            ...result.warnings.map((warning) => `- ${warning}`),
        );
    }

    return lines.join('\n');
}

function toLegacyPlanetRecord(body) {
    return {
        name: body.name,
        longitude: body.sidereal.longitudeDegrees,
        speed: body.sidereal.longitudeSpeedDegreesPerDay,
        retrograde: body.jyotish.retrograde,
        signIndex: body.jyotish.signIndex,
        sign: body.jyotish.sign,
        degreesInSign: body.jyotish.degreesInSign,
        house: body.jyotish.wholeSignHouse,
        nakshatra: body.jyotish.nakshatra,
    };
}

function safeApiResult(fn, label, warnings, { suppressWarning = false } = {}) {
    try {
        const result = fn();
        if (!result) {
            if (!suppressWarning) warnings.push(`${label}: пустой результат.`);
            return null;
        }
        if (result.flag === -1 || result.flag === 'ERR') {
            if (!suppressWarning) warnings.push(`${label}: ${result.error || 'ошибка Swiss Ephemeris'}`);
            return null;
        }
        if (result.error?.trim()) {
            warnings.push(`${label}: ${result.error.trim()}`);
        }
        return result;
    } catch (error) {
        if (!suppressWarning) warnings.push(`${label}: ${errorMessage(error)}`);
        return null;
    }
}

function assertResultData(result, action) {
    if (!result || result.flag === -1 || !result.data) {
        throw new Error(
            `Swiss Ephemeris не смог ${action}: ${result?.error || 'неизвестная ошибка'}`,
        );
    }
}

function dateToUtcParts(date) {
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        second: date.getUTCSeconds() + date.getUTCMilliseconds() / 1000,
    };
}

function getLocalCivilDateParts(date, timeZone) {
    const values = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(date)
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, Number(part.value)]),
    );

    return {
        year: values.year,
        month: values.month,
        day: values.day,
        hour: values.hour,
        minute: values.minute,
        second: values.second,
    };
}

function julianDayToDate(jd) {
    return new Date((Number(jd) - 2440587.5) * 86400000);
}

function cyclicForwardValue(value, startValue) {
    let result = value;
    while (result < startValue) result += 360;
    return result;
}

function shortestAngularDistance(a, b) {
    const difference = Math.abs(normalizeDegrees(a) - normalizeDegrees(b));
    return Math.min(difference, 360 - difference);
}

function signedAngularDifference(a, b) {
    return ((normalizeDegrees(a) - normalizeDegrees(b) + 540) % 360) - 180;
}

function normalizeDegrees(value) {
    return ((Number(value) % 360) + 360) % 360;
}

function normalizeHours(value) {
    return ((Number(value) % 24) + 24) % 24;
}

function formatDegrees(value) {
    const sign = Number(value) < 0 ? '-' : '';
    const totalSeconds = Math.round(Math.abs(Number(value)) * 3600 * 100) / 100;
    const degrees = Math.floor(totalSeconds / 3600);
    const afterDegrees = totalSeconds - degrees * 3600;
    const minutes = Math.floor(afterDegrees / 60);
    const seconds = afterDegrees - minutes * 60;
    return `${sign}${degrees}°${String(minutes).padStart(2, '0')}′${seconds.toFixed(2).padStart(5, '0')}″`;
}

function formatOptional(value, digits) {
    return Number.isFinite(value) ? Number(value).toFixed(digits) : 'н/д';
}

function finiteOrNull(value) {
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

function finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function findBody(bodies, name) {
    return bodies.find((body) => body.name === name);
}

function safeCall(fn, fallback) {
    try {
        return fn();
    } catch {
        return fallback;
    }
}

function errorMessage(error) {
    return String(error?.message ?? error);
}

function uniqueStrings(values) {
    return [...new Set(values.filter(Boolean).map(String))];
}

function structuredCloneSafe(value) {
    return JSON.parse(JSON.stringify(value));
}

function stableStringify(value, space = 0) {
    const seen = new WeakSet();
    return JSON.stringify(value, (key, item) => {
        if (typeof item === 'number' && Number.isFinite(item)) {
            return Math.round(item * 1e10) / 1e10;
        }
        if (item && typeof item === 'object') {
            if (seen.has(item)) return '[Circular]';
            seen.add(item);
            if (!Array.isArray(item)) {
                return Object.fromEntries(
                    Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
                );
            }
        }
        return item;
    }, space);
}

function assertValidDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        throw new TypeError('Некорректная дата для Swiss Ephemeris.');
    }
}

function assertTimeZone(timeZone) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    } catch {
        throw new RangeError(`Некорректный часовой пояс: ${String(timeZone)}`);
    }
}

function assertCoordinate(value, min, max, label) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
        throw new RangeError(`Некорректная ${label}: ${String(value)}`);
    }
}
