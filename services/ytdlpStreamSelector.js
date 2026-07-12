const CLASSIFICATION = Object.freeze({
    AUTH_COOKIE: 'auth_cookie',
    NO_FORMATS: 'no_formats',
    INVALID_HLS: 'invalid_hls',
    DASH_ONLY: 'dash_only',
    EXPIRED_STREAM_URL: 'expired_stream_url',
    LIVE_ENDED: 'live_ended',
    VIDEO_PRIVATE: 'video_private',
    VIDEO_REMOVED: 'video_removed',
    VIDEO_UNAVAILABLE: 'video_unavailable',
    AGE_RESTRICTED: 'age_restricted',
    MEMBERS_ONLY: 'members_only',
    GEO_RESTRICTED: 'geo_restricted',
    RATE_LIMIT: 'rate_limit',
    NETWORK: 'network',
    TIMEOUT: 'timeout',
    SERVER_5XX: 'server_5xx',
    PLAYER_RESPONSE_INVALID: 'player_response_invalid',
    YOUTUBE_CHANGED: 'youtube_changed',
    UNKNOWN: 'unknown'
});

function normalizeText(value) {
    return String(value || '').toLowerCase();
}

function classifyYtdlpError(error) {
    const text = normalizeText(error && error.message ? error.message : error);

    if (!text) return CLASSIFICATION.UNKNOWN;
    if (/expired stream|stream url expired|url.*expired|http error 403.*expire/i.test(text)) {
        return CLASSIFICATION.EXPIRED_STREAM_URL;
    }
    if (/age[- ]?restricted|confirm (?:your )?age|inappropriate for some users/i.test(text)) {
        return CLASSIFICATION.AGE_RESTRICTED;
    }
    if (/members[- ]?only|members only|join this channel|sponsor.*only/i.test(text)) {
        return CLASSIFICATION.MEMBERS_ONLY;
    }
    if (/(not available|blocked).*(country|region)|geo.?restricted|geographic|not made available in your country/i.test(text)) {
        return CLASSIFICATION.GEO_RESTRICTED;
    }
    if (/(sign in to confirm|sign in to verify|login required|requires authentication|authentication required|cookie file|invalid cookie|invalid cookies|cookies are no longer valid|use --cookies|pass cookies|export cookies|confirm you'?re not a bot|confirm you’re not a bot|not a bot|protect our community)/i.test(text)) {
        return CLASSIFICATION.AUTH_COOKIE;
    }
    if (/timeout|timed out|etimedout/i.test(text)) return CLASSIFICATION.TIMEOUT;
    if (/429|too many requests|rate limit|ratelimit|temporarily blocked/i.test(text)) return CLASSIFICATION.RATE_LIMIT;
    if (/private video|this video is private/i.test(text)) return CLASSIFICATION.VIDEO_PRIVATE;
    if (/removed|has been removed|does not exist|deleted/i.test(text)) return CLASSIFICATION.VIDEO_REMOVED;
    if (/live event has ended|premieres in|recording is not available|this live stream recording is not available|was live/i.test(text)) {
        return CLASSIFICATION.LIVE_ENDED;
    }
    if (/no video formats found/i.test(text)) return CLASSIFICATION.NO_FORMATS;
    if (/http error 5\d\d|5\d\d server|service unavailable|bad gateway|gateway timeout/i.test(text)) {
        return CLASSIFICATION.SERVER_5XX;
    }
    if (/video unavailable|this video is unavailable|not available|unavailable/i.test(text)) return CLASSIFICATION.VIDEO_UNAVAILABLE;
    if (/url retornada.*hls|not a valid hls|invalid hls|hls invalido|hls inválido/i.test(text)) {
        return CLASSIFICATION.INVALID_HLS;
    }
    if (/player response|invalid player|unable to extract.*player|signature extraction failed/i.test(text)) {
        return CLASSIFICATION.PLAYER_RESPONSE_INVALID;
    }
    if (/youtube.*changed|unable to extract|regex.*failed|extractor failed/i.test(text)) {
        return CLASSIFICATION.YOUTUBE_CHANGED;
    }
    if (/(econnreset|econnrefused|enotfound|eai_again|socket hang up|tls|network|http error 5\d\d|5\d\d server)/i.test(text)) {
        return CLASSIFICATION.NETWORK;
    }

    return CLASSIFICATION.UNKNOWN;
}

function isCookieAuthClassification(classification) {
    return classification === CLASSIFICATION.AUTH_COOKIE;
}

const PUBLIC_FALLBACK_ALLOWED_CLASSIFICATIONS = Object.freeze(new Set([
    CLASSIFICATION.NO_FORMATS,
    CLASSIFICATION.INVALID_HLS,
    CLASSIFICATION.DASH_ONLY,
    CLASSIFICATION.PLAYER_RESPONSE_INVALID,
    CLASSIFICATION.YOUTUBE_CHANGED,
    CLASSIFICATION.NETWORK,
    CLASSIFICATION.TIMEOUT,
    CLASSIFICATION.SERVER_5XX,
    CLASSIFICATION.UNKNOWN
]));

const PUBLIC_FALLBACK_BLOCKED_CLASSIFICATIONS = Object.freeze(new Set([
    CLASSIFICATION.LIVE_ENDED,
    CLASSIFICATION.VIDEO_PRIVATE,
    CLASSIFICATION.VIDEO_REMOVED,
    CLASSIFICATION.VIDEO_UNAVAILABLE,
    CLASSIFICATION.AGE_RESTRICTED,
    CLASSIFICATION.MEMBERS_ONLY,
    CLASSIFICATION.GEO_RESTRICTED
]));

function getFailureClassification(failure) {
    if (!failure) return null;
    if (typeof failure === 'string') return failure;
    return failure.classification || null;
}

function shouldAttemptPublicFallback(failures) {
    const classifications = (failures || [])
        .map(getFailureClassification)
        .filter(Boolean);

    // If no usable cookie exists, a public live may still be extractable.
    if (classifications.length === 0) return true;

    if (classifications.some(classification => PUBLIC_FALLBACK_BLOCKED_CLASSIFICATIONS.has(classification))) {
        return false;
    }

    return classifications.some(classification => PUBLIC_FALLBACK_ALLOWED_CLASSIFICATIONS.has(classification));
}

function isHlsProtocol(protocol) {
    const value = normalizeText(protocol);
    return value === 'm3u8' || value === 'm3u8_native' || value.includes('m3u8');
}

function isDashProtocol(protocol) {
    const value = normalizeText(protocol);
    return value === 'dash' || value.includes('dash');
}

function hasHlsUrlShape(url) {
    const value = normalizeText(url);
    return value.includes('.m3u8') || value.includes('/manifest/hls') || value.includes('hls_playlist') || value.includes('hls');
}

function isPotentialHlsFormat(format) {
    if (!format || !format.url) return false;
    return isHlsProtocol(format.protocol) || isHlsProtocol(format.protocols) || hasHlsUrlShape(format.url);
}

function isPlayableHlsVariant(format) {
    if (!isPotentialHlsFormat(format)) return false;
    if (format.vcodec === 'none') return false;
    if (!format.height) return false;
    return true;
}

function safeUrlPreview(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        const segments = parsed.pathname.split('/').filter(Boolean);
        const keepCount = Math.min(segments.length, 3);
        let pathPreview = segments.length > 0 ? `/${segments.slice(0, keepCount).join('/')}` : '';
        if (segments.length > keepCount) pathPreview += '/...';
        return `${parsed.origin}${pathPreview}`;
    } catch (err) {
        return String(url).split('?')[0].slice(0, 120);
    }
}

function sanitizeYtdlpMessage(message) {
    return String(message || '')
        .replace(/authorization:\s*bearer\s+[^\s]+/ig, 'Authorization: Bearer [redacted]')
        .replace(/https?:\/\/[^\s"'<>]+/g, url => safeUrlPreview(url) || '[url-redacted]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1000);
}

function uniqueSorted(values) {
    return Array.from(new Set(values.filter(Boolean).map(String))).sort();
}

function getYtdlpDiagnostics(metadata) {
    const formats = Array.isArray(metadata?.formats) ? metadata.formats : [];
    const requested = Array.isArray(metadata?.requested_formats) ? metadata.requested_formats : [];
    return {
        formatCount: formats.length,
        protocols: uniqueSorted(formats.map(format => format.protocol || format.protocols)),
        exts: uniqueSorted(formats.map(format => format.ext)),
        hasTopLevelUrl: Boolean(metadata?.url),
        hasManifestUrl: Boolean(metadata?.manifest_url),
        requestedFormatsCount: requested.length,
        requestedProtocols: uniqueSorted(requested.map(format => format.protocol || format.protocols)),
        liveStatus: metadata?.live_status || null,
        isLive: metadata?.is_live === true,
        wasLive: metadata?.was_live === true,
        hasHls: formats.some(isPotentialHlsFormat) || requested.some(isPotentialHlsFormat) || isHlsProtocol(metadata?.protocol),
        hasDash: formats.some(format => isDashProtocol(format.protocol || format.protocols)) || isDashProtocol(metadata?.protocol),
        topLevelProtocol: metadata?.protocol || null,
        topLevelExt: metadata?.ext || null
    };
}

function makeBandwidth(height) {
    if (height <= 240) return 300000;
    if (height <= 360) return 600000;
    if (height <= 480) return 1200000;
    if (height <= 720) return 2500000;
    if (height <= 1080) return 5000000;
    return 8000000;
}

function buildArtificialMaster(formats) {
    const lines = formats.map(format => {
        const height = format.height || 360;
        const width = format.width || Math.round(height * 16 / 9);
        const fps = format.fps || 30;
        return [
            `#EXT-X-STREAM-INF:BANDWIDTH=${makeBandwidth(height)},RESOLUTION=${width}x${height},FRAME-RATE=${fps}`,
            format.url
        ].join('\n');
    });

    return '#EXTM3U\n' + lines.join('\n');
}

function sortByHeightAsc(a, b) {
    return (a.height || 0) - (b.height || 0);
}

function selectHlsStream(metadata, options = {}) {
    const diagnostics = getYtdlpDiagnostics(metadata);
    const formats = Array.isArray(metadata?.formats) ? metadata.formats : [];
    const requested = Array.isArray(metadata?.requested_formats) ? metadata.requested_formats : [];
    const maxHeight = Number.isFinite(Number(options.maxHeight)) ? Number(options.maxHeight) : null;
    const forceArtificial = options.forceArtificial === true || maxHeight !== null;
    const liveStatus = normalizeText(metadata?.live_status);
    const metadataLooksEnded = liveStatus === 'was_live' ||
        liveStatus === 'post_live' ||
        (metadata?.was_live === true && metadata?.is_live !== true);

    if (metadataLooksEnded && !diagnostics.hasHls && !metadata?.manifest_url) {
        return { ok: false, classification: CLASSIFICATION.LIVE_ENDED, diagnostics };
    }

    if (diagnostics.formatCount === 0 && requested.length === 0 && !metadata?.url && !metadata?.manifest_url) {
        return { ok: false, classification: CLASSIFICATION.NO_FORMATS, diagnostics };
    }

    if (!forceArtificial && metadata?.manifest_url && hasHlsUrlShape(metadata.manifest_url)) {
        return {
            ok: true,
            type: 'manifest_url',
            url: metadata.manifest_url,
            urlPreview: safeUrlPreview(metadata.manifest_url),
            classification: null,
            diagnostics
        };
    }

    const topLevelUrl = metadata?.url || null;
    if (!forceArtificial && topLevelUrl && (isHlsProtocol(metadata?.protocol) || hasHlsUrlShape(topLevelUrl))) {
        return {
            ok: true,
            type: 'top_level',
            url: topLevelUrl,
            urlPreview: safeUrlPreview(topLevelUrl),
            classification: null,
            diagnostics
        };
    }

    const requestedHls = requested.filter(isPotentialHlsFormat);
    if (!forceArtificial && requestedHls.length > 0) {
        const chosen = requestedHls.find(item => item.url) || requestedHls[0];
        if (chosen?.url) {
            return {
                ok: true,
                type: 'requested_format',
                url: chosen.url,
                urlPreview: safeUrlPreview(chosen.url),
                classification: null,
                diagnostics
            };
        }
    }

    const masterFormat = formats.find(format =>
        isPotentialHlsFormat(format) &&
        format.url &&
        !format.height &&
        (
            normalizeText(format.format_note).includes('master') ||
            normalizeText(format.format_id).includes('hls') ||
            normalizeText(format.resolution) === 'audio only'
        )
    );
    if (!forceArtificial && masterFormat) {
        return {
            ok: true,
            type: 'master',
            url: masterFormat.url,
            urlPreview: safeUrlPreview(masterFormat.url),
            classification: null,
            diagnostics
        };
    }

    let variants = formats.filter(isPlayableHlsVariant);
    if (variants.length > 0) {
        variants = variants.slice().sort(sortByHeightAsc);
        let selectedVariants = variants;
        if (maxHeight !== null) {
            selectedVariants = variants.filter(format => (format.height || 0) <= maxHeight);
            if (selectedVariants.length === 0) selectedVariants = [variants[0]];
        }

        const best = selectedVariants[selectedVariants.length - 1];
        return {
            ok: true,
            type: selectedVariants.length > 1 ? 'artificial_master' : 'variant',
            url: best.url,
            urlPreview: safeUrlPreview(best.url),
            masterContent: selectedVariants.length > 1 ? buildArtificialMaster(selectedVariants) : null,
            playlistUrls: Object.fromEntries(selectedVariants.map(format => [format.height || 360, format.url])),
            selectedHeight: best.height || null,
            classification: null,
            diagnostics
        };
    }

    if (diagnostics.hasDash && !diagnostics.hasHls) {
        return { ok: false, classification: CLASSIFICATION.DASH_ONLY, diagnostics };
    }

    if (diagnostics.hasHls) {
        return { ok: false, classification: CLASSIFICATION.INVALID_HLS, diagnostics };
    }

    return { ok: false, classification: CLASSIFICATION.NO_FORMATS, diagnostics };
}

module.exports = {
    CLASSIFICATION,
    classifyYtdlpError,
    isCookieAuthClassification,
    getYtdlpDiagnostics,
    selectHlsStream,
    safeUrlPreview,
    sanitizeYtdlpMessage,
    shouldAttemptPublicFallback,
    isHlsProtocol,
    isPotentialHlsFormat
};
