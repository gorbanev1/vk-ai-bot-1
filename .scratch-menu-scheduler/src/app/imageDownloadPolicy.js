/**
 * Validate URLs returned by a model before making a server-side image request.
 * Only exact trusted hosts are accepted. An unrecognized CDN must be explicitly
 * listed in OPENAI_IMAGE_ALLOWED_HOSTS rather than accepted by a wildcard.
 */
import { isIP } from 'node:net';

export function assertTrustedModelImageUrl(value, { baseUrls = [], additionalHosts = '' } = {}) {
    let url;
    try {
        url = new URL(String(value || ''));
    } catch {
        throw new Error('GPT image download: invalid URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
        throw new Error('GPT image download: only credential-free HTTPS URLs on port 443 are allowed');
    }
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (isIP(host.replace(/^\[|\]$/gu, ''))) {
        throw new Error('GPT image download: IP literal URLs are not allowed');
    }
    const trusted = new Set([
        'oaidalleapiprodscus.blob.core.windows.net',
        'files.oaiusercontent.com',
        'images.openai.com',
        'cdn.openai.com',
    ]);
    for (const base of baseUrls) {
        try {
            const parsed = new URL(String(base || ''));
            if (parsed.protocol === 'https:' && !isIP(parsed.hostname)) trusted.add(parsed.hostname.toLowerCase());
        } catch { /* Invalid provider base URLs do not grant access. */ }
    }
    for (const entry of String(additionalHosts || '').split(/[\s,;]+/u)) {
        const candidate = entry.trim().toLowerCase().replace(/\.$/u, '');
        if (candidate && /^[a-z0-9.-]+$/u.test(candidate) && !isIP(candidate)) trusted.add(candidate);
    }
    if (!trusted.has(host)) {
        const error = new Error('GPT image download: host is not trusted; configure OPENAI_IMAGE_ALLOWED_HOSTS if this CDN is expected');
        error.code = 'UNTRUSTED_MODEL_IMAGE_URL';
        throw error;
    }
    return url.toString();
}
