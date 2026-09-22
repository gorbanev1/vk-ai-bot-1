/**
 * Ранжирование афиш событий и чтение размеров локальных raster-изображений.
 */
function finiteDimension(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function cleanUrl(value) {
    const url = String(value ?? '').trim();
    return /^https?:\/\//iu.test(url) ? url : '';
}

const MEDIA_HINT_WEIGHT = Object.freeze({
    'direct-photo': 1_000_000_000,
    'repost-photo': 950_000_000,
    'link-photo': 760_000_000,
    'dom-photo-anchor': 720_000_000,
    'dom-media': 620_000_000,
    'dom-generic': 420_000_000,
    'local-source': 500_000_000,
    generated: 20_000_000,
});

export function isLikelyEventAnnouncementImage(candidate = {}) {
    const width = finiteDimension(candidate.width);
    const height = finiteDimension(candidate.height);
    const byteLength = Math.max(0, Number(candidate.byteLength) || 0);

    // If dimensions are known, reject obvious avatars/icons/thumbnails.
    if (width && height) {
        const area = width * height;
        return width >= 180 && height >= 180 && area >= 45_000;
    }

    // Some formats (for example AVIF variants) may not expose dimensions to
    // the lightweight header parser. Keep a reasonably sized downloaded
    // image instead of silently dropping a potentially valid poster.
    return byteLength >= 12 * 1024;
}

export function scoreEventImageCandidate(candidate = {}) {
    const width = finiteDimension(candidate.width);
    const height = finiteDimension(candidate.height);
    const area = width && height ? width * height : 0;
    const byteLength = Math.max(0, Number(candidate.byteLength) || 0);
    const hint = String(candidate.mediaHint ?? '').trim();
    let score = MEDIA_HINT_WEIGHT[hint] ?? 300_000_000;

    if (area) {
        score += Math.min(area, 80_000_000);
        const ratio = width / height;
        if (ratio >= 0.55 && ratio <= 1.35) {
            score += Math.min(12_000_000, Math.round(area * 0.18));
        } else if (ratio > 2.6 || ratio < 0.28) {
            score -= 25_000_000;
        }

        if (width < 180 || height < 180 || area < 45_000) {
            score -= 700_000_000;
        }
    } else if (byteLength) {
        score += Math.min(8_000_000, Math.round(byteLength / 2));
    }

    if (candidate.isGeneratedFallback) {
        score -= 430_000_000;
    }

    return score;
}

export function rankEventImageCandidates(candidates, { limit = 4 } = {}) {
    const source = Array.isArray(candidates) ? candidates : [];
    const byUrl = new Map();

    source.forEach((candidate, index) => {
        const url = cleanUrl(candidate?.url);
        if (!url) return;
        const normalized = {
            ...candidate,
            url,
            _order: index,
        };
        normalized._score = scoreEventImageCandidate(normalized);
        const previous = byUrl.get(url);
        if (!previous || normalized._score > previous._score) {
            byUrl.set(url, normalized);
        }
    });

    return [...byUrl.values()]
        .sort((left, right) => (
            right._score - left._score ||
            left._order - right._order
        ))
        .slice(0, Math.max(1, Math.min(12, Number(limit) || 4)))
        .map(({ _score, _order, ...candidate }) => candidate);
}

export function detectRasterImageDimensions(buffer) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
    if (bytes.length < 10) return { width: 0, height: 0 };

    // PNG: signature + IHDR width/height.
    if (
        bytes.length >= 24 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    ) {
        return {
            width: bytes.readUInt32BE(16),
            height: bytes.readUInt32BE(20),
        };
    }

    // GIF87a / GIF89a.
    if (bytes.length >= 10 && bytes.subarray(0, 3).toString('ascii') === 'GIF') {
        return {
            width: bytes.readUInt16LE(6),
            height: bytes.readUInt16LE(8),
        };
    }

    // JPEG: walk markers until a Start Of Frame marker.
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < bytes.length) {
            if (bytes[offset] !== 0xff) {
                offset += 1;
                continue;
            }
            const marker = bytes[offset + 1];
            if (marker === 0xd8 || marker === 0xd9) {
                offset += 2;
                continue;
            }
            if (offset + 4 > bytes.length) break;
            const segmentLength = bytes.readUInt16BE(offset + 2);
            if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) break;
            const isSof = (
                marker >= 0xc0 && marker <= 0xc3 ||
                marker >= 0xc5 && marker <= 0xc7 ||
                marker >= 0xc9 && marker <= 0xcb ||
                marker >= 0xcd && marker <= 0xcf
            );
            if (isSof && offset + 9 < bytes.length) {
                return {
                    height: bytes.readUInt16BE(offset + 5),
                    width: bytes.readUInt16BE(offset + 7),
                };
            }
            offset += 2 + segmentLength;
        }
    }

    // WebP VP8X / VP8 / VP8L common headers.
    if (
        bytes.length >= 30 &&
        bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
        const chunk = bytes.subarray(12, 16).toString('ascii');
        if (chunk === 'VP8X' && bytes.length >= 30) {
            return {
                width: 1 + bytes.readUIntLE(24, 3),
                height: 1 + bytes.readUIntLE(27, 3),
            };
        }
        if (chunk === 'VP8 ' && bytes.length >= 30) {
            return {
                width: bytes.readUInt16LE(26) & 0x3fff,
                height: bytes.readUInt16LE(28) & 0x3fff,
            };
        }
        if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
            const b1 = bytes[21];
            const b2 = bytes[22];
            const b3 = bytes[23];
            const b4 = bytes[24];
            return {
                width: 1 + (((b2 & 0x3f) << 8) | b1),
                height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
            };
        }
    }

    return { width: 0, height: 0 };
}
