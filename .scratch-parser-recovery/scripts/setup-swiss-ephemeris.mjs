import { ensureLocalSwissEphemerisRuntime } from '../src/features/astrology/astrologyRuntimeFallback.js';

const runtime = await ensureLocalSwissEphemerisRuntime();

if (!runtime.ready) {
    console.error('Swiss Ephemeris setup failed.');
    console.error(`source=${runtime.source}`);
    console.error(`error=${runtime.bootstrapError || 'required *.se1 files not found'}`);
    process.exitCode = 1;
} else {
    console.log('Swiss Ephemeris ready.');
    console.log(`EPHEMERIS_PATH=${runtime.path}`);
    console.log(`source=${runtime.source}`);
    console.log(`files=${runtime.requiredFiles.join(',')}`);
}
