const path = require('path');
const { CLASSIFICATION } = require('./ytdlpStreamSelector');

const DEFAULT_COOKIE_FILES = Object.freeze(['cookie1.txt', 'cookie2.txt', 'cookie3.txt']);

const EXTRACTION_BACKOFF_SEQUENCE = Object.freeze([30, 60, 120, 300, 600]);
const NETWORK_BACKOFF_SEQUENCE = Object.freeze([15, 30, 60, 120, 300]);
const TERMINAL_BACKOFF_SEQUENCE = Object.freeze([600]);

function positiveNumberOr(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeCookieName(value) {
    if (!value) return null;
    const base = path.basename(String(value));
    const match = base.match(/^(cookie[123])(?:\.txt)?$/i);
    return match ? `${match[1].toLowerCase()}.txt` : null;
}

function resolveCookiePath(cookiesDir, cookieName) {
    const normalized = normalizeCookieName(cookieName);
    return normalized ? path.join(cookiesDir, normalized) : null;
}

function buildCookieAttemptOrder(options = {}) {
    const cookieFiles = (options.cookieFiles || DEFAULT_COOKIE_FILES)
        .map(normalizeCookieName)
        .filter(Boolean);
    const allowed = new Set(cookieFiles);
    const attempted = new Set();
    const order = [];
    const cookieExists = typeof options.cookieExists === 'function'
        ? options.cookieExists
        : () => true;

    const add = (candidate) => {
        const cookie = normalizeCookieName(candidate);
        if (!cookie || !allowed.has(cookie) || attempted.has(cookie)) return;
        if (!cookieExists(cookie)) return;
        attempted.add(cookie);
        order.push(cookie);
    };

    add(options.lastSuccessfulCookie);
    add(options.selectedCookiePath);
    for (const cookie of cookieFiles) add(cookie);

    return order;
}

function getBackoffMaxSeconds(classification, options = {}) {
    if (classification === CLASSIFICATION.RATE_LIMIT) {
        return positiveNumberOr(
            options.rateLimitMaxSeconds ?? process.env.YTDLP_RATE_LIMIT_BACKOFF_MAX_SECONDS,
            600
        );
    }
    if (
        classification === CLASSIFICATION.NETWORK ||
        classification === CLASSIFICATION.TIMEOUT ||
        classification === CLASSIFICATION.SERVER_5XX
    ) {
        return positiveNumberOr(options.networkMaxSeconds, 300);
    }
    return positiveNumberOr(options.extractionMaxSeconds, 600);
}

function getBackoffSequence(classification, options = {}) {
    if (classification === CLASSIFICATION.RATE_LIMIT) {
        return [60, 120, 300, 600];
    }
    if (
        classification === CLASSIFICATION.NETWORK ||
        classification === CLASSIFICATION.TIMEOUT ||
        classification === CLASSIFICATION.SERVER_5XX
    ) {
        return NETWORK_BACKOFF_SEQUENCE;
    }
    if (
        classification === CLASSIFICATION.LIVE_ENDED ||
        classification === CLASSIFICATION.VIDEO_PRIVATE ||
        classification === CLASSIFICATION.VIDEO_UNAVAILABLE ||
        classification === CLASSIFICATION.VIDEO_REMOVED
    ) {
        const terminalSeconds = positiveNumberOr(options.terminalBackoffSeconds, TERMINAL_BACKOFF_SEQUENCE[0]);
        return [terminalSeconds];
    }
    return EXTRACTION_BACKOFF_SEQUENCE;
}

function shouldApplyExtractionBackoff(classification) {
    return classification !== CLASSIFICATION.AUTH_COOKIE;
}

function computeBackoffSeconds(classification, consecutiveFailures, options = {}) {
    if (!shouldApplyExtractionBackoff(classification)) return 0;
    const failures = Math.max(1, Number(consecutiveFailures) || 1);
    const sequence = getBackoffSequence(classification, options);
    const fromSequence = sequence[Math.min(failures - 1, sequence.length - 1)];
    return Math.min(fromSequence, getBackoffMaxSeconds(classification, options));
}

function applyExtractionFailure(state, classification, nowMs = Date.now(), options = {}) {
    if (!state || !shouldApplyExtractionBackoff(classification)) {
        return state;
    }

    const consecutive = (Number(state.consecutiveExtractionFailures) || 0) + 1;
    const backoffSeconds = computeBackoffSeconds(classification, consecutive, options);

    state.consecutiveExtractionFailures = consecutive;
    state.lastExtractionFailureAt = nowMs;
    state.lastFailureClassification = classification || CLASSIFICATION.UNKNOWN;
    state.backoffSeconds = backoffSeconds;
    state.nextRetryAt = backoffSeconds > 0 ? nowMs + backoffSeconds * 1000 : 0;
    state._recoveryLoggedForFailureSequence = false;
    return state;
}

function resetExtractionBackoff(state, cookieName, nowMs = Date.now()) {
    if (!state) return false;
    const hadFailure = Boolean(
        state.consecutiveExtractionFailures ||
        state.nextRetryAt ||
        state.backoffSeconds ||
        state.lastFailureClassification
    );

    state.consecutiveExtractionFailures = 0;
    state.lastExtractionFailureAt = null;
    state.lastFailureClassification = null;
    state.nextRetryAt = 0;
    state.backoffSeconds = 0;
    state.lastSuccessfulCookie = normalizeCookieName(cookieName) || state.lastSuccessfulCookie || null;
    state.lastExtractionSuccessAt = nowMs;
    state._lastBackoffLogAt = 0;
    state._lastBackoffLogRetryAt = 0;
    state._recoveryLoggedForFailureSequence = true;
    return hadFailure;
}

function getBackoffDelayMs(state, nowMs = Date.now()) {
    const retryAt = Number(state?.nextRetryAt) || 0;
    return retryAt > nowMs ? retryAt - nowMs : 0;
}

function shouldLogBackoffSuppression(state, nowMs = Date.now(), minIntervalMs = 30000) {
    if (!state) return false;
    const retryAt = Number(state.nextRetryAt) || 0;
    if (!retryAt || retryAt <= nowMs) return false;
    const lastLogAt = Number(state._lastBackoffLogAt) || 0;
    const lastRetryAt = Number(state._lastBackoffLogRetryAt) || 0;
    if (retryAt !== lastRetryAt || nowMs - lastLogAt >= minIntervalMs) {
        state._lastBackoffLogAt = nowMs;
        state._lastBackoffLogRetryAt = retryAt;
        return true;
    }
    return false;
}

function createExtractionBackoffState(seed = {}) {
    return {
        consecutiveExtractionFailures: Number(seed.consecutiveExtractionFailures) || 0,
        lastExtractionFailureAt: seed.lastExtractionFailureAt || null,
        lastFailureClassification: seed.lastFailureClassification || null,
        nextRetryAt: Number(seed.nextRetryAt) || 0,
        backoffSeconds: Number(seed.backoffSeconds) || 0,
        lastSuccessfulCookie: normalizeCookieName(seed.lastSuccessfulCookie) || null,
        lastExtractionSuccessAt: seed.lastExtractionSuccessAt || null,
        _lastBackoffLogAt: 0,
        _lastBackoffLogRetryAt: 0,
        _recoveryLoggedForFailureSequence: false
    };
}

module.exports = {
    DEFAULT_COOKIE_FILES,
    normalizeCookieName,
    resolveCookiePath,
    buildCookieAttemptOrder,
    computeBackoffSeconds,
    applyExtractionFailure,
    resetExtractionBackoff,
    getBackoffDelayMs,
    shouldApplyExtractionBackoff,
    shouldLogBackoffSuppression,
    createExtractionBackoffState
};
