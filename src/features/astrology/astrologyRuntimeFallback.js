import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const EPHEMERIS_ENV_KEYS = Object.freeze([
    'EPHEMERIS_PATH',
    'SWISS_EPHEMERIS_PATH',
    'SWISSEPH_EPHEMERIS_PATH',
    'SWEPH_EPHEMERIS_PATH',
]);

const REQUIRED_SWISS_EPHEMERIS_FILES = Object.freeze([
    'sepl_18.se1',
    'semo_18.se1',
    'seas_18.se1',
]);

const OFFICIAL_EPHEMERIS_BASE_URLS = Object.freeze([
    'https://www.astro.com/ftp/swisseph/ephe',
    'https://raw.githubusercontent.com/aloistr/swisseph/master/ephe',
]);

const AUTO_SETUP_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;
let bootstrapPromise = null;
let lastBootstrapFailureAt = 0;
let lastBootstrapFailure = '';

function cleanText(value, maxLength = 900) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, maxLength);
}

function directoryHasRequiredSe1Files(directory) {
    const path = String(directory ?? '').trim();
    if (!path || !existsSync(path)) return false;
    try {
        if (!statSync(path).isDirectory()) return false;
        const names = new Set(
            readdirSync(path, { withFileTypes: true })
                .filter((entry) => entry.isFile())
                .map((entry) => entry.name.toLowerCase()),
        );
        return REQUIRED_SWISS_EPHEMERIS_FILES.every((name) => names.has(name));
    } catch {
        return false;
    }
}

function uniquePaths(values) {
    return [...new Set(values
        .map((value) => String(value ?? '').trim())
        .filter(Boolean))];
}

export function prepareLocalSwissEphemerisRuntime({
    env = process.env,
    cwd = process.cwd(),
} = {}) {
    const envCandidates = EPHEMERIS_ENV_KEYS
        .map((key) => ({ key, path: String(env?.[key] ?? '').trim() }))
        .filter((item) => item.path);
    const conventionalCandidates = [
        resolve(cwd, 'data', 'swisseph'),
        resolve(cwd, 'ephe'),
        resolve(cwd, 'ephemeris'),
        resolve(cwd, 'data', 'ephe'),
        resolve(cwd, 'data', 'ephemeris'),
        resolve(cwd, 'swisseph', 'ephe'),
        resolve(cwd, 'vendor', 'swisseph', 'ephe'),
    ];
    const candidates = uniquePaths([
        ...envCandidates.map((item) => item.path),
        ...conventionalCandidates,
    ]);
    const foundPath = candidates.find(directoryHasRequiredSe1Files) || '';

    if (foundPath) {
        env.EPHEMERIS_PATH = foundPath;
        const fromEnv = envCandidates.find((item) => item.path === foundPath);
        return {
            ready: true,
            path: foundPath,
            source: fromEnv ? `env:${fromEnv.key}` : 'auto-discovery',
            dataFilesPresent: true,
            requiredFiles: [...REQUIRED_SWISS_EPHEMERIS_FILES],
        };
    }

    return {
        ready: false,
        path: String(env?.EPHEMERIS_PATH ?? '').trim(),
        source: envCandidates.length ? `env:${envCandidates[0].key}` : 'not-found',
        dataFilesPresent: false,
        requiredFiles: [...REQUIRED_SWISS_EPHEMERIS_FILES],
    };
}

function autoSetupEnabled(env = process.env) {
    return !/^(?:0|false|off|no)$/iu.test(String(env?.ASTROLOGY_AUTO_SETUP_SWISSEPH ?? '1').trim());
}

async function fetchEphemerisFile(filename, { timeoutMs = 12_000 } = {}) {
    let lastError = null;
    for (const baseUrl of OFFICIAL_EPHEMERIS_BASE_URLS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(`${baseUrl}/${filename}`, {
                signal: controller.signal,
                redirect: 'follow',
                headers: { 'user-agent': 'Gigorave-Swiss-Ephemeris-Setup/188.95' },
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length < 1_024) {
                throw new Error(`слишком маленький файл: ${bytes.length} bytes`);
            }
            return { bytes, sourceUrl: `${baseUrl}/${filename}` };
        } catch (error) {
            lastError = error;
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`Не удалось загрузить ${filename}: ${cleanText(lastError?.message ?? lastError, 300)}`);
}

async function bootstrapSwissEphemerisData({ env = process.env, cwd = process.cwd() } = {}) {
    const targetDirectory = resolve(cwd, 'data', 'swisseph');
    mkdirSync(targetDirectory, { recursive: true });

    const downloaded = await Promise.all(REQUIRED_SWISS_EPHEMERIS_FILES.map(async (filename) => {
        const targetPath = resolve(targetDirectory, basename(filename));
        if (existsSync(targetPath) && statSync(targetPath).size >= 1_024) {
            return { filename, targetPath, sourceUrl: 'existing' };
        }
        const { bytes, sourceUrl } = await fetchEphemerisFile(filename);
        const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
        try {
            writeFileSync(tempPath, bytes);
            renameSync(tempPath, targetPath);
        } catch (error) {
            try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}
            throw error;
        }
        return { filename, targetPath, sourceUrl };
    }));

    env.EPHEMERIS_PATH = targetDirectory;
    const runtime = prepareLocalSwissEphemerisRuntime({ env, cwd });
    if (!runtime.ready) {
        throw new Error('Файлы Swiss Ephemeris загружены, но runtime не видит полный набор *.se1.');
    }
    return {
        ...runtime,
        source: 'auto-bootstrap-official-data',
        downloaded,
    };
}

export async function ensureLocalSwissEphemerisRuntime({
    env = process.env,
    cwd = process.cwd(),
} = {}) {
    const prepared = prepareLocalSwissEphemerisRuntime({ env, cwd });
    if (prepared.ready || !autoSetupEnabled(env)) return prepared;

    if (
        lastBootstrapFailureAt > 0 &&
        Date.now() - lastBootstrapFailureAt < AUTO_SETUP_FAILURE_COOLDOWN_MS
    ) {
        return {
            ...prepared,
            source: 'auto-bootstrap-cooldown',
            bootstrapError: lastBootstrapFailure,
        };
    }

    if (!bootstrapPromise) {
        bootstrapPromise = bootstrapSwissEphemerisData({ env, cwd })
            .catch((error) => {
                lastBootstrapFailureAt = Date.now();
                lastBootstrapFailure = cleanText(error?.message ?? error, 700);
                throw error;
            })
            .finally(() => {
                bootstrapPromise = null;
            });
    }

    try {
        return await bootstrapPromise;
    } catch (error) {
        return {
            ...prepared,
            source: 'auto-bootstrap-failed',
            bootstrapError: cleanText(error?.message ?? error, 700),
        };
    }
}

export function buildSwissEphemerisModelFallbackPrompt({
    kind = 'prashna',
    error = null,
    calculationDate = null,
    location = null,
    timeZone = '',
} = {}) {
    const safeKind = kind === 'natal' ? 'натальной карты' : 'прашны';
    const instant = calculationDate instanceof Date && !Number.isNaN(calculationDate.getTime())
        ? calculationDate.toISOString()
        : cleanText(calculationDate, 120);
    const locationName = cleanText(location?.name, 220) || 'не указано';
    const latitude = Number.isFinite(Number(location?.latitude)) ? Number(location.latitude) : null;
    const longitude = Number.isFinite(Number(location?.longitude)) ? Number(location.longitude) : null;
    const coordinates = latitude !== null && longitude !== null
        ? `${latitude}, ${longitude}`
        : 'не указаны';
    const failure = cleanText(error?.message ?? error, 900) || 'неизвестная ошибка локального расчёта';

    return [
        'FALLBACK_SWISS_EPHEMERIS_REQUIRED',
        `Локальный расчёт ${safeKind} был запущен первым, но завершился ошибкой: ${failure}`,
        `Точный момент расчёта UTC: ${instant || 'не указан'}`,
        `Место: ${locationName}`,
        `Координаты: ${coordinates}`,
        `Часовой пояс: ${cleanText(timeZone, 120) || 'не указан'}`,
        '',
        'ОБЯЗАТЕЛЬНЫЙ ПРОТОКОЛ РЕЗЕРВНОГО РАСЧЁТА:',
        '1. НЕ вычисляй положения планет, домов, лагны, Луны, накшатр или аспектов по памяти языковой модели.',
        '2. Используй реальную библиотеку Swiss Ephemeris. Для Node.js-проекта предпочитай штатную зависимость sweph@2.10.3-7; если библиотека отсутствует в доступной среде исполнения — установи её через npm/pnpm перед расчётом.',
        '3. Для Swiss Ephemeris укажи set_ephe_path()/EPHEMERIS_PATH на каталог с файлами *.se1. Если данные отсутствуют и среда позволяет загрузку/установку — подготовь их перед расчётом.',
        '4. Выполни расчёт библиотекой для указанного выше точного момента и координат. Только после успешного библиотечного расчёта переходи к астрологической интерпретации.',
        '5. Если в твоей среде НЕТ реального выполнения кода/инструментов и ты не можешь фактически запустить Swiss Ephemeris, прямо сообщи, что резервный расчёт технически невозможен. Не подменяй его догадкой и не выдумывай координаты небесных тел.',
    ].join('\n');
}
