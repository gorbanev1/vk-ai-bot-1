/**
 * V188.137: diagnostic-only forensic snapshots for an explicit parser run.
 * Never downloads remote photos, changes parser decisions, or mutates event rows.
 */
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { detectRasterImageDimensions } from '../events/eventImageSelection.js';
import { getEventPosterSafetyAssessment } from '../events/eventProvenance.js';

const MAX_MEDIA_COPY_BYTES = 20 * 1024 * 1024;
const REDACT_KEY = /^(?:authorization|cookie|set-cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)$/iu;

function serialize(value) {
    // A source array can occur both in `post` and in audit convenience fields.
    // Treat only TRUE recursive references as cycles; do not discard repeated data.
    const ancestors = [];
    return JSON.stringify(value, function replace(key, item) {
        if (REDACT_KEY.test(key)) return '[REDACTED]';
        if (typeof item === 'bigint') return String(item);
        if (item instanceof Error) return { name: item.name, message: item.message, code: item.code, stack: item.stack };
        if (item && typeof item === 'object') {
            while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
            if (ancestors.includes(item)) return '[CIRCULAR]';
            ancestors.push(item);
        }
        return item;
    });
}

function localMediaPaths(value, out = new Set(), depth = 0) {
    if (!value || depth > 7) return out;
    if (Array.isArray(value)) {
        for (const item of value) localMediaPaths(item, out, depth + 1);
        return out;
    }
    if (typeof value !== 'object') return out;
    for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'string' && /(?:imagePath|localPath|boundPath|sourcePath|verifiedPath)$/iu.test(key)) {
            if (child.trim()) out.add(child.trim());
        } else if (Array.isArray(child) && /^(?:imagePaths|verifiedImagePaths|_sourceImagePaths)$/iu.test(key)) {
            for (const path of child) if (typeof path === 'string' && path.trim()) out.add(path.trim());
        } else if (key === 'imagePathsJson' && typeof child === 'string') {
            try { localMediaPaths({ imagePaths: JSON.parse(child) }, out, depth + 1); } catch {}
        } else if (child && typeof child === 'object') {
            localMediaPaths(child, out, depth + 1);
        }
    }
    return out;
}

function eventChanges(before = [], after = []) {
    const oldItems = Array.isArray(before) ? before : [];
    const newItems = Array.isArray(after) ? after : [];
    const identity = (event, index) => String(event?.id ?? '') || `index:${index}:${event?.eventDate || ''}`;
    const oldById = new Map(oldItems.map((event, index) => [identity(event, index), event]));
    const newById = new Map(newItems.map((event, index) => [identity(event, index), event]));
    const changes = [];
    for (const [id, old] of oldById) {
        if (!newById.has(id)) { changes.push({ id, type: 'removed', before: old }); continue; }
        const fresh = newById.get(id);
        const fields = ['title', 'eventDate', 'eventTime', 'description', 'imagePaths', 'verifiedImagePaths',
            'posterImageIndex', 'posterMatchStatus', 'posterMatchReason', 'posterVisionFacts', 'sourceUrl'];
        const differences = {};
        for (const field of fields) {
            if (serialize(old?.[field] ?? null) !== serialize(fresh?.[field] ?? null)) {
                differences[field] = { before: old?.[field] ?? null, after: fresh?.[field] ?? null };
            }
        }
        if (Object.keys(differences).length) changes.push({ id, type: 'updated', differences });
    }
    for (const [id, fresh] of newById) {
        if (!oldById.has(id)) changes.push({ id, type: 'added', after: fresh });
    }
    return changes;
}

function posterDecision(event) {
    if (!event || typeof event !== 'object') return null;
    let safety;
    try { safety = getEventPosterSafetyAssessment(event); }
    catch (error) { safety = { accepted: false, reason: 'poster-safety-assessment-error', error: String(error?.message || error) }; }
    const paths = Array.isArray(event.imagePaths) ? event.imagePaths : [];
    const verifiedPaths = Array.isArray(event.verifiedImagePaths) ? event.verifiedImagePaths : [];
    let facts = Array.isArray(event.posterVisionFacts) ? event.posterVisionFacts : [];
    if (!facts.length) {
        try {
            const parsed = JSON.parse(String(event.posterVisionFactsJson ?? event.poster_vision_facts_json ?? '[]'));
            if (Array.isArray(parsed)) facts = parsed;
        } catch {}
    }
    const selectedIndex = Number(event.posterImageIndex || 0);
    return {
        eventId: event.id ?? null, eventDate: event.eventDate ?? '', title: event.title ?? '',
        sourceUrl: event.sourceUrl ?? '', imagePaths: paths, verifiedImagePaths: verifiedPaths,
        posterMatchStatus: event.posterMatchStatus ?? '', posterMatchReason: event.posterMatchReason ?? '',
        selectedIndex, posterVisionFacts: facts,
        selectedFact: facts.find((fact) => Number(fact?.index || 0) === selectedIndex) || null,
        selectedFileExistsInEvent: Boolean(safety.boundPath && [...paths, ...verifiedPaths].some((path) => String(path).replace(/\\/gu, '/') === String(safety.boundPath).replace(/\\/gu, '/'))),
        displaySafety: {
            accepted: Boolean(safety.accepted), reason: String(safety.reason || ''),
            status: String(safety.status || ''), boundPath: String(safety.boundPath || ''),
            metadataQuality: Number(safety.metadataQuality || 0), match: safety.match || null,
        },
    };
}

export function createParserPosterForensics({ dataDirectory, runDirectory }) {
    const dataRoot = resolve(dataDirectory);
    const directory = resolve(runDirectory, 'poster-forensics');
    const mediaDirectory = join(directory, 'images');
    mkdirSync(mediaDirectory, { recursive: true });
    const logPath = join(directory, 'events.jsonl');
    const imagesPath = join(directory, 'image-manifest.jsonl');
    writeFileSync(logPath, '', 'utf8');
    writeFileSync(imagesPath, '', 'utf8');
    const copied = new Map();
    let sequence = 0;

    function note(stage, payload = {}) {
        const record = { at: new Date().toISOString(), seq: ++sequence, stage, ...payload };
        appendFileSync(logPath, `${serialize(record)}\n`, 'utf8');
        return record;
    }

    function preserveLocalImage(imagePath, sourceId, itemId, stage) {
        const original = String(imagePath || '').trim();
        if (!original) return null;
        const fullPath = resolve(dataRoot, original);
        let record = copied.get(fullPath);
        if (!record) {
            record = { sourcePath: original, fullPath, preservedPath: '', state: '', bytes: 0, sha256: '', width: 0, height: 0 };
            try {
                const relativePath = relative(dataRoot, fullPath);
                if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
                    record.state = 'outside-data-directory';
                } else if (!existsSync(fullPath)) {
                    record.state = 'missing-on-disk';
                } else if (!lstatSync(fullPath).isFile()) {
                    record.state = 'not-a-regular-file';
                } else {
                    const size = statSync(fullPath).size;
                    record.bytes = size;
                    if (size > MAX_MEDIA_COPY_BYTES) {
                        record.state = 'oversize-no-copy';
                    } else {
                        const bytes = readFileSync(fullPath);
                        record.sha256 = createHash('sha256').update(bytes).digest('hex');
                        const dimensions = detectRasterImageDimensions(bytes);
                        record.width = dimensions.width;
                        record.height = dimensions.height;
                        const destination = join(mediaDirectory, `${record.sha256.slice(0, 20)}${extname(fullPath).toLowerCase().slice(0, 12) || '.bin'}`);
                        if (!existsSync(destination)) copyFileSync(fullPath, destination);
                        record.preservedPath = destination;
                        record.state = 'copied';
                    }
                }
            } catch (error) {
                record.state = 'copy-error';
                record.error = { code: String(error?.code || ''), message: String(error?.message || error) };
            }
            copied.set(fullPath, record);
        }
        appendFileSync(imagesPath, `${serialize({ at: new Date().toISOString(), sourceId, itemId, stage, ...record })}\n`, 'utf8');
        return record;
    }

    function recordPost(stage, { sourceId = '', itemId = '', post = null, events = [], previousEvents = [], previous = null, decision = null, ...extra } = {}) {
        const sourceMediaPaths = new Set();
        for (const item of [post, events, previousEvents, previous, extra]) localMediaPaths(item, sourceMediaPaths);
        const mediaFiles = [...sourceMediaPaths].map((path) => preserveLocalImage(path, sourceId, itemId, stage));
        return note(stage, {
            sourceId, itemId, post, originalText: String(post?.text ?? ''),
            allSourceImageUrls: Array.isArray(post?.imageUrls) ? post.imageUrls : [],
            allSourceImageMedia: Array.isArray(post?.imageMedia) ? post.imageMedia : [],
            domAudit: post?.domAudit || null, decision, previous, previousEvents, events,
            changes: stage.endsWith('after-db-write') ? {
                sourceBefore: extra.previousSource ?? null,
                sourceAfter: previous,
                events: eventChanges(previousEvents, events),
            } : null,
            posterDecisions: Array.isArray(events) ? events.map(posterDecision) : [],
            mediaFiles, ...extra,
        });
    }

    function recordFinalSnapshot(snapshot = {}, visibilityAudit = null) {
        const filePath = join(directory, 'final-announcement-cards.jsonl');
        writeFileSync(filePath, '', 'utf8');
        let count = 0;
        for (const [index, item] of (Array.isArray(snapshot?.items) ? snapshot.items : []).entries()) {
            const event = item?.event || null;
            const sourceId = `${event?.sourceType || 'unknown'}:${event?.sourceName || event?.channel || event?.screenName || ''}`;
            const itemId = String(event?.id ?? index);
            const mediaFiles = [...localMediaPaths(event)].map((path) => preserveLocalImage(path, sourceId, itemId, 'final-card'));
            appendFileSync(filePath, `${serialize({ at: new Date().toISOString(), index, event,
                compactSummary: item.compactSummary, ticketLink: item.ticketLink,
                posterDecision: posterDecision(event), mediaFiles })}\n`, 'utf8');
            count += 1;
        }
        const visibilityPath = join(directory, 'final-visibility-audit.json');
        writeFileSync(visibilityPath, `${serialize({ at: new Date().toISOString(), visibilityAudit })}\n`, 'utf8');
        note('final-snapshot-saved', { count, filePath, visibilityPath, mediaCount: copied.size });
        return { count, filePath, visibilityPath, mediaCount: copied.size };
    }

    note('forensics.start', { dataDirectory: dataRoot, directory, logPath, imagesPath,
        limitations: 'Network-only URLs have metadata/URL but no local bytes; no new image downloads. Final cards are snapshot decisions, not Telegram/VK delivery receipts.' });
    return { directory, logPath, imagesPath, recordPost, recordFinalSnapshot, note };
}

/** Delivery is not part of the parser run: log actual poster selection/upload/send separately. */
export function appendPosterDeliveryForensic({ dataDirectory = './data', stage, event, ...details }) {
    const directory = resolve(dataDirectory, 'event-poster-delivery-archives');
    try {
        mkdirSync(directory, { recursive: true });
        const filePath = join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl`);
        appendFileSync(filePath, `${serialize({ at: new Date().toISOString(), stage,
            eventId: event?.id ?? null, eventDate: event?.eventDate ?? '', title: event?.title ?? '',
            sourceUrl: event?.sourceUrl ?? '', sourceType: event?.sourceType ?? '',
            originalText: String(event?.rawText ?? event?.description ?? ''),
            event, posterDecision: posterDecision(event), ...details })}\n`, 'utf8');
        return filePath;
    } catch (error) {
        console.error('[EVENT POSTER DELIVERY FORENSICS WRITE ERROR]', stage, String(error?.code || ''), String(error?.message || error));
        return '';
    }
}
