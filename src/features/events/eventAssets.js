/**
 * Скачивание и строгая привязка только реальных исходных изображений события.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { createHash } from 'node:crypto';

import {
    browserDownloadBuffer,
} from '../../infrastructure/browser/browserGrabber.js';

import {
    appendEventIngestAudit,
} from './eventIngestAudit.js';

import {
    detectRasterImageDimensions,
} from './eventImageSelection.js';

import {
    runEventOperationWithRetries,
} from './eventRetry.js';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_SOURCE_IMAGES = 1000;
const DEFAULT_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

function safeSegment(value, fallback = 'item') {
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9а-яё_-]+/giu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 80);

    return normalized || fallback;
}

function guessImageExtension(contentType, url) {
    const type = String(contentType ?? '').toLowerCase();

    if (type.includes('png')) return '.png';
    if (type.includes('webp')) return '.webp';
    if (type.includes('gif')) return '.gif';
    if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';

    try {
        const fromUrl = extname(new URL(url).pathname).toLowerCase();
        return /^\.(?:jpe?g|png|webp|gif)$/u.test(fromUrl)
            ? fromUrl.replace('.jpeg', '.jpg')
            : '.jpg';
    } catch {
        return '.jpg';
    }
}

function uniqueHttpUrls(values, maximum = MAX_SOURCE_IMAGES) {
    const result = [];
    const safeMaximum = Math.min(
        MAX_SOURCE_IMAGES,
        Math.max(1, Number(maximum) || MAX_SOURCE_IMAGES),
    );

    for (const value of Array.isArray(values) ? values : []) {
        const url = String(value ?? '').trim();

        if (
            /^https?:\/\//iu.test(url) &&
            !result.includes(url) &&
            result.length < safeMaximum
        ) {
            result.push(url);
        }
    }

    return result;
}

async function directDownloadBuffer({
    url,
    source,
    maximumBytes,
    timeoutMs,
}) {
    const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(
            Math.max(5_000, Number(timeoutMs) || DEFAULT_IMAGE_DOWNLOAD_TIMEOUT_MS),
        ),
        headers: {
            'user-agent': 'Mozilla/5.0 GigoraveBot/0.147 event-poster-refresh',
            accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
    });
    if (!response.ok) {
        throw new Error(`${source}: HTTP ${response.status}`);
    }
    const advertisedBytes = Number(response.headers.get('content-length') || 0);
    if (advertisedBytes > maximumBytes) {
        throw new Error(`${source}: файл превысил ${maximumBytes} байт`);
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > maximumBytes) {
        throw new Error(`${source}: файл превысил ${maximumBytes} байт`);
    }
    return {
        buffer: body,
        contentType: response.headers.get('content-type') || '',
        finalUrl: response.url || url,
    };
}

async function downloadSourceImages({
    sourceKey,
    itemId,
    imageUrls,
    dataDirectory,
    targetFolder,
    notifyAttention,
    downloadTimeoutMs = DEFAULT_IMAGE_DOWNLOAD_TIMEOUT_MS,
    maxSourceImages = MAX_SOURCE_IMAGES,
    allowBrowserFallback = true,
    fetchImage = null,
}) {
    const urls = uniqueHttpUrls(imageUrls, maxSourceImages);

    if (!urls.length) {
        return [];
    }

    const safeSource = safeSegment(sourceKey, 'source');
    const safeItem = safeSegment(itemId, 'item');
    const relativeDirectory = join(targetFolder, safeSource);
    const absoluteDirectory = join(dataDirectory, relativeDirectory);
    mkdirSync(absoluteDirectory, { recursive: true });
    const paths = [];

    for (let index = 0; index < urls.length; index += 1) {
        try {
            const response = await runEventOperationWithRetries(
                async () => {
                    if (fetchImage) return fetchImage(urls[index]);
                    try {
                        return await directDownloadBuffer({
                            url: urls[index],
                            source: 'event image',
                            maximumBytes: MAX_IMAGE_BYTES,
                            timeoutMs: downloadTimeoutMs,
                        });
                    } catch (directError) {
                        if (!allowBrowserFallback) throw directError;
                        return browserDownloadBuffer({
                            url: urls[index],
                            dataDirectory,
                            notifyAttention,
                            source: 'event image',
                            maximumBytes: MAX_IMAGE_BYTES,
                            timeoutMs: downloadTimeoutMs,
                        });
                    }
                },
                {
                    label: `event-image-download:${safeSource}/${safeItem}/${index + 1}`,
                    onAttemptError: ({ round, maxRounds, willRetry, delayMs, errorMessage }) => {
                        appendEventIngestAudit({
                            dataDirectory,
                            sourceType: 'event-assets',
                            sourceKey: safeSource,
                            itemId: safeItem,
                            sourceUrl: urls[index],
                            status: 'retry-error',
                            reason: 'event-image-download',
                            details: { round, maxRounds, willRetry, delayMs, error: errorMessage },
                        });
                    },
                    onRecovered: ({ round, maxRounds }) => {
                        appendEventIngestAudit({
                            dataDirectory,
                            sourceType: 'event-assets',
                            sourceKey: safeSource,
                            itemId: safeItem,
                            sourceUrl: urls[index],
                            status: 'retry-recovered',
                            reason: 'event-image-download',
                            details: { round, maxRounds },
                        });
                    },
                },
            );

            // Source membership, not pixel count, determines whether an image
            // reaches storage/Vision. URL-level avatar, sticker and UI filters
            // run during source capture; small or compressed images remain
            // inspectable evidence and must not disappear silently here.
            const dimensions = detectRasterImageDimensions(response.buffer);

            const extension = guessImageExtension(
                response.contentType,
                response.finalUrl,
            );
            const baseFilename = `${safeItem}-${index + 1}${extension}`;
            const baseAbsolute = join(absoluteDirectory, baseFilename);
            const incomingHash = createHash('sha256').update(response.buffer).digest('hex');
            let filename = baseFilename;

            // V188.85: media files are immutable after first write. If VK
            // reorders a gallery/currentSrc, never overwrite bytes referenced by
            // an already-correct event; store the new variant under a hash name.
            if (existsSync(baseAbsolute)) {
                let existingHash = '';
                try { existingHash = createHash('sha256').update(readFileSync(baseAbsolute)).digest('hex'); } catch {}
                if (existingHash && existingHash !== incomingHash) {
                    filename = `${safeItem}-${index + 1}-${incomingHash.slice(0, 12)}${extension}`;
                }
            }

            const absolutePath = join(absoluteDirectory, filename);
            if (!existsSync(absolutePath)) writeFileSync(absolutePath, response.buffer, { flag: 'wx' });
            paths.push(join(relativeDirectory, filename).replace(/\\/gu, '/'));
        } catch (error) {
            console.error(
                '[EVENT IMAGE DOWNLOAD ERROR]',
                `source=${safeSource}`,
                `item=${safeItem}`,
                String(error?.message ?? error),
            );
        }
    }

    return paths;
}



export {
    applyPosterDerivedVenueFallback,
    assignEventImageIndexesFromFacts,
    assignEventImageIndexesFromParsedFacts,
    parseIndexedImageFacts,
    serializeIndexedImageFacts,
} from './eventPosterMatching.js';

/**
 * Event cards are publishable only with a real announcement image attached to
 * that concrete event. Relevant ingest paths call prepareEventImages with
 * generateFallback=false, therefore a non-empty imagePaths array here means a
 * downloaded/source-provided image rather than a generated placeholder.
 */
export function hasEventAnnouncementImage(event) {
    return Array.isArray(event?.imagePaths) && event.imagePaths.some((value) => {
        const clean = String(value ?? '').trim();
        return Boolean(clean) && !isGeneratedEventAssetPath(clean);
    });
}

function isGeneratedEventAssetPath(value) {
    const clean = String(value ?? '').replace(/\\/gu, '/').trim();
    return /(?:^|\/)event_message_cards\//iu.test(clean) ||
        /(?:^|\/)event_generated_fallbacks\//iu.test(clean) ||
        /(?:^|\/)event_message_source_recovery\/[^/]+\/[^/]+-event-\d+\.png$/iu.test(clean) ||
        /-event-\d+\.png$/iu.test(clean);
}

export function filterEventsWithAnnouncementImages(events, {
    onRejected = null,
} = {}) {
    const result = [];

    for (const event of Array.isArray(events) ? events : []) {
        if (!hasEventAnnouncementImage(event) && typeof onRejected === 'function') {
            onRejected(event, 'missing-source-announcement-image');
        }
        // V188.67: missing/unsafe poster is a media condition, not a reason to
        // erase an otherwise valid event. Persist it text-only and let public
        // rendering remain fail-closed for images.
        result.push(event);
    }

    return result;
}

export async function prepareEventImages({
    events,
    sourceKey,
    itemId,
    imageUrls,
    dataDirectory,
    targetFolder = 'event_announcements',
    sourceLabel,
    notifyAttention,
    downloadTimeoutMs = DEFAULT_IMAGE_DOWNLOAD_TIMEOUT_MS,
    maxSourceImages = MAX_SOURCE_IMAGES,
    allowBrowserFallback = true,
    fetchImage = null,
    generateFallback = false,
    shareSourceImagesAcrossEvents = false,
}) {
    const safeEvents = Array.isArray(events) ? events : [];

    if (!safeEvents.length) {
        return [];
    }

    const downloaded = await downloadSourceImages({
        sourceKey,
        itemId,
        imageUrls,
        dataDirectory,
        targetFolder,
        notifyAttention,
        downloadTimeoutMs,
        maxSourceImages,
        allowBrowserFallback,
        fetchImage,
    });
    const sourceImageCount = uniqueHttpUrls(imageUrls, maxSourceImages).length;
    const result = [];
    // A single source image on a multi-announcement post is the post's shared
    // announcement image. Bind that exact downloaded file to every child
    // event. This is deliberately limited to one source image; galleries still
    // require an explicit Vision-to-event binding for each child.
    const sharedMultiEventSourceBinding = Boolean(
        shareSourceImagesAcrossEvents && safeEvents.length > 1 && sourceImageCount === 1 && downloaded.length === 1,
    );

    for (let index = 0; index < safeEvents.length; index += 1) {
        const event = safeEvents[index];
        const explicitEventImages = Array.isArray(event?.imagePaths)
            ? event.imagePaths
                .map((value) => String(value ?? '').trim())
                .filter((value) => value && !isGeneratedEventAssetPath(value))
            : [];
        /* A one-image multi-announcement is intentionally shared by all of its
         * child cards. Multiple source images remain event-specific below. */
        const sourceIndexFromPath = (pathValue) => {
            const match = String(pathValue ?? '').replace(/\\+/gu, '/').match(/-(\d+)(?:-[a-f0-9]{8,64})?\.[^.]+$/iu);
            const value = Number(match?.[1] || 0);
            return Number.isInteger(value) && value > 0 ? value : 0;
        };
        const positiveFactIndexes = (Array.isArray(event?.posterVisionFacts) ? event.posterVisionFacts : [])
            .filter((fact) => fact?.poster === true && Number(fact?.posterConfidence ?? 100) >= 55)
            .map((fact) => Number(fact?.index || 0))
            .filter((value) => Number.isInteger(value) && value >= 1 && value <= maxSourceImages);
        const requestedIndexes = [...new Set([
            Number(event?.posterImageIndex || 0),
            ...(Array.isArray(event?.imageIndexes) ? event.imageIndexes.map(Number) : []),
            ...positiveFactIndexes,
        ].filter((value) => Number.isInteger(value) && value >= 1 && value <= maxSourceImages))];
        const indexedEventImages = [...new Set(requestedIndexes
            .map((value) => downloaded.find((pathValue) => sourceIndexFromPath(pathValue) === value) || '')
            .filter(Boolean))];

        // V188.86: one event card owns at most ONE proven real source image.
        // Never spray an entire single-event gallery into the card: VK/Telegram
        // posts often contain a poster plus a sticker, giveaway, ordinary photo,
        // banner or the same CDN asset more than once. Existing explicit media is
        // preserved first so a correct old card cannot be damaged by a reparse;
        // otherwise only a concrete Vision/index binding may attach a download.
        const specificCandidates = explicitEventImages.length
            ? explicitEventImages
            : indexedEventImages;
        // A post containing one announcement and one source image has an
        // unambiguous event-to-media relationship even when the first Vision
        // pass did not return an image index. Keep that image attached so a
        // later metadata pass can enrich or replace it. Multi-announcement
        // galleries still require an explicit binding per event; a one-image
        // multi-announcement is the intentional shared-source exception below.
        const singleSourceEventBinding = safeEvents.length === 1 &&
            !Boolean(event?.isMultiAnnouncement ?? event?.is_multi_announcement) &&
            downloaded.length > 0;
        const singleEventSourceMediaFallback = singleSourceEventBinding && !specificCandidates.length;
        if (singleEventSourceMediaFallback) {
            specificCandidates.push(downloaded[0]);
        }
        if (sharedMultiEventSourceBinding) {
            specificCandidates.push(downloaded[0]);
        }
        let selectedPath = '';
        for (const requestedIndex of requestedIndexes) {
            selectedPath = specificCandidates.find((pathValue) => sourceIndexFromPath(pathValue) === requestedIndex) || '';
            if (selectedPath) break;
        }
        if (!selectedPath) selectedPath = specificCandidates[0] || '';
        if (sharedMultiEventSourceBinding) selectedPath = downloaded[0];

        // Keep an explicitly rejected source out of event media. Match the
        // negative fact to the selected path/index; a non-poster fact for a
        // different gallery item must not erase an already-proven poster.
        const selectedSourceIndex = sourceIndexFromPath(selectedPath);
        const selectedPathExplicitlyRejected = Boolean(selectedPath) &&
            (Array.isArray(event?.posterVisionFacts) ? event.posterVisionFacts : [])
                .some((fact) => {
                    const negative = fact?.poster === false || /(?:ordinary[- ]?photo|event[- ]?photo|concert[- ]?photo|photo|фото|обычнw*s+фото|репортаж|logo|логотип|avatar|аватар|album[- ]?cover|обложк|ui|interface|интерфейс|sticker|emoji)/iu.test(String(fact?.imageType || ''));
                    if (!negative) return false;
                    const factPath = String(fact?.imagePath || '').replace(/\\+/gu, '/').trim();
                    if (factPath && factPath === String(selectedPath).replace(/\\+/gu, '/').trim()) return true;
                    const factIndex = Number(fact?.index || 0);
                    return selectedSourceIndex > 0 && factIndex > 0 && factIndex === selectedSourceIndex;
                });
        // A single event with one source URL has an unambiguous source-media
        // binding. Vision may still classify that image as an ordinary photo;
        // preserve the source path and the negative fact for audit instead of
        // making the card lose its only image. Strict matching remains in force
        // for galleries and multi-announcement posts.
        // A mono-announcement owns the complete source gallery. Vision facts
        // annotate those files, but even a negative/failed fact never removes
        // the original media from the card. A single-image multi-announcement
        // follows the same source-media rule for each child card.
        const eventImagePaths = sharedMultiEventSourceBinding
            ? [downloaded[0]]
            : singleSourceEventBinding && downloaded.length
                ? downloaded
            : selectedPath && !selectedPathExplicitlyRejected
                ? [selectedPath]
                : [];
        const singletonSourceMediaBinding = Boolean(
            singleSourceEventBinding && selectedPath && eventImagePaths.length > 0 && safeEvents.length === 1,
        );
        const sharedMultiSourceMediaBinding = Boolean(
            sharedMultiEventSourceBinding && selectedPath && eventImagePaths.length > 0,
        );
        if (!eventImagePaths.length && generateFallback) {
            appendEventIngestAudit({
                dataDirectory,
                sourceType: 'event-assets',
                sourceKey: String(sourceKey || ''),
                itemId: String(itemId || ''),
                status: 'generated-fallback-blocked',
                reason: 'v18886-real-source-images-only',
                details: { eventIndex: index },
            });
        }

        let posterVisionFacts = Array.isArray(event?.posterVisionFacts)
            ? event.posterVisionFacts
            : [];
        const selectedIndex = selectedPath ? sourceIndexFromPath(selectedPath) : 0;
        const existingFallbackFact = posterVisionFacts.find((fact) => Number(fact?.index || 0) === selectedIndex);
        if ((singleSourceEventBinding || sharedMultiSourceMediaBinding) && selectedPath && existingFallbackFact) {
            // Preserve any explicit Vision fact, including poster:false, while
            // recording the independent singleton source binding.
            posterVisionFacts = posterVisionFacts.map((fact) => (
                Number(fact?.index || 0) === selectedIndex
                    ? { ...fact,
                        fallbackBinding: sharedMultiSourceMediaBinding
                            ? 'multi-event-shared-source-image'
                            : (sourceImageCount === 1 ? 'single-event-single-image' : 'single-event-source-media'),
                        sourceMediaBinding: true,
                        sourceEventCount: sharedMultiSourceMediaBinding ? safeEvents.length : 1,
                        sourceImageCount,
                        imagePath: selectedPath.replace(/\\/gu, '/'),
                    }
                    : fact
            ));
        } else if ((singleSourceEventBinding || sharedMultiSourceMediaBinding) && selectedPath) {
            // Preserve the exact source binding for persistence/render safety.
            // This is deliberately a minimal fact: no OCR or event metadata is
            // invented, only the parser's one-event/one-image relationship.
            posterVisionFacts = [{
                index: selectedIndex,
                poster: null,
                posterConfidence: null,
                imageType: 'source-image-fallback',
                fallbackBinding: sharedMultiSourceMediaBinding
                    ? 'multi-event-shared-source-image'
                    : (sourceImageCount === 1 ? 'single-event-single-image' : 'single-event-source-media'),
                sourceMediaBinding: true,
                sourceEventCount: sharedMultiSourceMediaBinding ? safeEvents.length : 1,
                sourceImageCount,
                imagePath: selectedPath.replace(/\\/gu, '/'),
                visionInspected: false,
                visionStatus: 'not_run',
                text: '',
            }, ...posterVisionFacts.filter((fact) => Number(fact?.index || 0) !== selectedIndex)];
        }
        if (selectedPath && selectedIndex > 0) {
            try {
                const absolutePath = join(dataDirectory, selectedPath);
                const buffer = readFileSync(absolutePath);
                const imageSha256 = createHash('sha256').update(buffer).digest('hex');
                posterVisionFacts = posterVisionFacts.map((fact) => (
                    Number(fact?.index || 0) === selectedIndex
                        ? {
                            ...fact,
                            imagePath: selectedPath.replace(/\\/gu, '/'),
                            imageFilename: basename(selectedPath),
                            imageSha256,
                        }
                        : fact
                ));
            } catch {
                // Media persistence must not fail because evidence enrichment did.
            }
        }

        result.push({
            ...event,
            isMultiAnnouncement: sharedMultiEventSourceBinding
                ? true
                : Boolean(event?.isMultiAnnouncement ?? event?.is_multi_announcement),
            imagePaths: eventImagePaths,
            // A single event with one source image, or a multi-announcement
            // with one shared source image, has an explicit path-bound media
            // relationship even when Vision returned an error. Keep the
            // Vision fact for audit and retry; do not lose the source image.
            posterImageIndex: (singletonSourceMediaBinding || sharedMultiSourceMediaBinding)
                ? (selectedIndex || 1)
                : Number(event?.posterImageIndex || 0),
            posterMatchStatus: singletonSourceMediaBinding
                ? (['exact_poster_match', 'verified_title_date_poster'].includes(String(event?.posterMatchStatus || '').trim())
                    ? String(event.posterMatchStatus) : 'no_safe_poster')
                : sharedMultiSourceMediaBinding
                    ? 'shared_multi_event_source_image'
                    : String(event?.posterMatchStatus || ''),
            posterMatchReason: singletonSourceMediaBinding
                ? (['exact_poster_match', 'verified_title_date_poster'].includes(String(event?.posterMatchStatus || '').trim())
                    ? String(event?.posterMatchReason || 'metadata-confirmed-poster')
                    : 'single-event-source-media-fallback')
                : sharedMultiSourceMediaBinding
                    ? 'multi-event-shared-source-image'
                    : String(event?.posterMatchReason || ''),
            posterVisionFacts,
            // Source storage remains lossless for future repair/forensics.
            _sourceImagePaths: downloaded,
        });
    }

    return result;
}
