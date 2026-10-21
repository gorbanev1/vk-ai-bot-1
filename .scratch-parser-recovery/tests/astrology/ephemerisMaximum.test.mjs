import assert from 'node:assert/strict';

import {
    assertMaximumCalculationAudit,
    buildMaximumCalculationAudit,
    calculateHarmonicCharts,
    calculateVimshottariDasha,
    evaluateEphemerisFlagCoverage,
} from '../../src/features/astrology/ephemeris.js';

const harmonics = calculateHarmonicCharts({
    ascendant: 12.5,
    bodies: [
        { name: 'Солнце', sidereal: { longitudeDegrees: 100 } },
        { name: 'Луна', sidereal: { longitudeDegrees: 250 } },
    ],
    maxDivision: 60,
});

assert.equal(Object.keys(harmonics).length, 60);
assert.equal(harmonics.D1.division, 1);
assert.equal(harmonics.D60.division, 60);
assert.equal(harmonics.D60.points.length, 3);

const dasha = calculateVimshottariDasha({
    moonLongitude: 45,
    birthDate: new Date('1987-03-14T16:40:00.000Z'),
    referenceDate: new Date('2026-07-30T07:48:00.000Z'),
});

assert.equal(dasha.coverage.mahadashaCount, 9);
assert.equal(dasha.coverage.antardashaCount, 81);
assert.equal(dasha.coverage.pratyantardashaCount, 729);
assert.ok(dasha.activeMahadasha);
assert.ok(dasha.activeAntardasha);
assert.ok(dasha.activePratyantardasha);

const primaryNames = [
    'Солнце', 'Луна', 'Меркурий', 'Венера', 'Марс', 'Юпитер', 'Сатурн',
    'Раху истинный', 'Кету истинный', 'Уран', 'Нептун', 'Плутон',
];
const completeResult = {
    bodies: primaryNames.map((name) => ({
        name,
        sidereal: {},
        tropical: {},
        topocentricSidereal: {},
        equatorial: {},
        topocentricEquatorial: {},
        horizontal: {},
    })),
    primaryJyotishBodies: primaryNames,
    houseSystems: {
        W: { cusps: Array.from({ length: 12 }, () => ({})) },
    },
    harmonicCharts: Object.fromEntries(
        Array.from({ length: 60 }, (_, index) => [`D${index + 1}`, {}]),
    ),
    fixedStars: [],
    panchanga: {
        tithi: { end: {} },
        nakshatra: { end: {} },
        yoga: { end: {} },
        karana: { end: {} },
    },
    jyotishDerived: {
        vimshottariDasha: {
            coverage: {
                mahadashaCount: 9,
                antardashaCount: 81,
                pratyantardashaCount: 729,
            },
        },
    },
    engine: {
        highPrecisionFilesLoaded: false,
        coreCalculationsUsedSwissFiles: false,
        strictSwissFilesRequired: false,
        fallbackUsed: true,
        ephemerisUsage: {
            directPrimary: [],
            nonSwissDirectPrimaryBodies: primaryNames.filter((name) => name !== 'Кету истинный'),
        },
    },
    warnings: [],
};

const audit = buildMaximumCalculationAudit(completeResult);
assert.equal(audit.completeForDeclaredScope, true);
assert.equal(audit.precision, 'moshier-or-mixed-fallback');
assert.equal(audit.fallbackUsed, true);
assertMaximumCalculationAudit(audit);

const directPrimaryNames = primaryNames.filter((name) => name !== 'Кету истинный');
const swissCoverage = evaluateEphemerisFlagCoverage({
    bodies: directPrimaryNames.map((name) => ({
        name,
        calculationFlags: {
            sidereal: { returned: 2 | 256 | 65536 },
        },
    })),
    swissFlag: 2,
    moshierFlag: 4,
    requestedSwiss: true,
});
assert.equal(swissCoverage.allDirectPrimaryUseSwiss, true);
assert.equal(swissCoverage.anyDirectPrimaryUsesMoshier, false);
assert.deepEqual(swissCoverage.nonSwissDirectPrimaryBodies, []);

const mixedBodies = directPrimaryNames.map((name, index) => ({
    name,
    calculationFlags: {
        sidereal: { returned: (index === 3 ? 4 : 2) | 256 | 65536 },
    },
}));
const mixedCoverage = evaluateEphemerisFlagCoverage({
    bodies: mixedBodies,
    swissFlag: 2,
    moshierFlag: 4,
    requestedSwiss: true,
});
assert.equal(mixedCoverage.allDirectPrimaryUseSwiss, false);
assert.equal(mixedCoverage.anyDirectPrimaryUsesMoshier, true);
assert.deepEqual(mixedCoverage.nonSwissDirectPrimaryBodies, [directPrimaryNames[3]]);

const incomplete = structuredClone(completeResult);
delete incomplete.harmonicCharts.D60;
const incompleteAudit = buildMaximumCalculationAudit(incomplete);
assert.equal(incompleteAudit.completeForDeclaredScope, false);
assert.match(incompleteAudit.criticalIssues.join('|'), /missing-harmonics:60/u);
assert.throws(
    () => assertMaximumCalculationAudit(incompleteAudit),
    /Максимальный локальный расчёт неполон/u,
);

console.log('ephemerisMaximum tests: OK');
