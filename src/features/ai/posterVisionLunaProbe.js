import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { POSTER_VISION_LUNA_PROBE } from './parserModelLadder.js';

const DEFAULT_PATH = resolve(process.env.GIGORAVE_DATA_DIR || 'data', 'poster-vision-luna-probe.json');

function normalize(value = {}) {
    const distance = Number(value.nextProbeAfterImages);
    return {
        version: 1,
        lunaPreferred: value.lunaPreferred === true,
        imagesSinceProbe: Math.max(0, Number(value.imagesSinceProbe) || 0),
        nextProbeAfterImages: Number.isSafeInteger(distance)
            ? Math.min(POSTER_VISION_LUNA_PROBE.intervalMax, Math.max(POSTER_VISION_LUNA_PROBE.intervalMin, distance))
            : randomInt(POSTER_VISION_LUNA_PROBE.intervalMin, POSTER_VISION_LUNA_PROBE.intervalMax + 1),
        lastProbeAt: String(value.lastProbeAt || ''),
        lastProbeResult: String(value.lastProbeResult || ''),
    };
}

function readState(path) {
    try { return normalize(JSON.parse(readFileSync(path, 'utf8'))); } catch { return normalize(); }
}

function writeState(path, state) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
}

export function createPosterVisionLunaProbeController({ path = DEFAULT_PATH, random = Math.random } = {}) {
    let state = readState(path);

    function persist() { writeState(path, state); }

    return {
        getNextLadder() {
            return state.lunaPreferred
                ? { probeLuna: false, preferredLuna: true }
                : { probeLuna: state.imagesSinceProbe >= state.nextProbeAfterImages, preferredLuna: false };
        },
        recordProbeResult({ success, now = new Date() } = {}) {
            state.lastProbeAt = now.toISOString();
            state.lastProbeResult = success ? 'success' : 'failure';
            state.imagesSinceProbe = 0;
            state.lunaPreferred = Boolean(success);
            if (!success) {
                const span = POSTER_VISION_LUNA_PROBE.intervalMax - POSTER_VISION_LUNA_PROBE.intervalMin + 1;
                state.nextProbeAfterImages = POSTER_VISION_LUNA_PROBE.intervalMin + Math.floor(random() * span);
            }
            persist();
            return { ...state };
        },
        recordOrdinaryImage() {
            if (!state.lunaPreferred) {
                state.imagesSinceProbe += 1;
                persist();
            }
            return { ...state };
        },
        snapshot() { return { ...state }; },
    };
}

export function shouldTryPosterVisionLunaProbe(ladderState) {
    return Boolean(ladderState?.probeLuna || ladderState?.preferredLuna);
}
