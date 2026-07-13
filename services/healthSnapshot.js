const STATUS_RANK = Object.freeze({
    ok: 0,
    warning: 1,
    degraded: 1,
    error: 2,
    critical: 3,
    offline: 2
});

const STATUS_SCORE = Object.freeze({
    ok: 100,
    warning: 60,
    degraded: 60,
    error: 25,
    critical: 0,
    offline: 25
});

const COMPONENT_LABELS = Object.freeze({
    authentication: 'Autenticacao',
    cookies: 'Cookies',
    extraction: 'Extracao',
    manifest: 'Manifesto',
    stream: 'Stream',
    agent: 'Agente Windows'
});

const TERMINAL_AVAILABILITY_CLASSIFICATIONS = Object.freeze(new Set([
    'live_ended',
    'video_unavailable',
    'video_private',
    'video_removed',
    'age_restricted',
    'members_only',
    'geo_restricted'
]));

const PERSISTENT_EXTRACTION_FAILURES = 5;

function safeClassification(value) {
    const text = String(value || 'unknown').toLowerCase();
    return /^[a-z0-9_.-]{1,80}$/.test(text) ? text : 'unknown';
}

function safeIdentifier(value, fallback = 'unknown') {
    const text = String(value || '');
    return /^[a-zA-Z0-9_.:-]{1,120}$/.test(text) ? text : fallback;
}

function normalizeTimestampMs(value, fallback = Date.now()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function safeIsoTimestamp(value) {
    return new Date(normalizeTimestampMs(value)).toISOString();
}

function isTerminalAvailabilityClassification(classification) {
    return TERMINAL_AVAILABILITY_CLASSIFICATIONS.has(safeClassification(classification));
}

function isMonitorEnding(monitor) {
    if (!monitor || monitor._liveEnded || monitor.liveState === 'ended') return false;
    if (monitor._liveEndedFirstDetection) return true;

    const classification = safeClassification(monitor.lastFailureClassification ||
        monitor.lastExtractionFailureClassification ||
        null);
    if (classification === 'live_ended') return true;

    const metadataMessage = String(monitor.health?.metadata?.message || '').toLowerCase();
    return metadataMessage.includes('live possivelmente encerrada') ||
        metadataMessage.includes('confirmando encerramento') ||
        metadataMessage.includes('live encerrada');
}

function isMonitorTerminalAvailability(monitor) {
    if (!monitor || monitor._liveEnded || monitor.liveState === 'ended') return false;
    if (isMonitorEnding(monitor)) return true;

    const classification = safeClassification(monitor.lastFailureClassification ||
        monitor.lastExtractionFailureClassification ||
        null);
    return isTerminalAvailabilityClassification(classification);
}

function isAuthCookieClassification(classification) {
    return safeClassification(classification) === 'auth_cookie';
}

function normalizeStatus(status) {
    if (status === 'degraded') return 'warning';
    if (status === 'offline') return 'error';
    return STATUS_RANK[status] === undefined ? 'warning' : status;
}

function makeComponent(status, message, details = {}) {
    return {
        status: normalizeStatus(status),
        message: String(message || ''),
        ...details
    };
}

function worstStatus(statuses) {
    let worst = 'ok';
    for (const status of statuses) {
        const normalized = normalizeStatus(status);
        if ((STATUS_RANK[normalized] || 0) > (STATUS_RANK[worst] || 0)) {
            worst = normalized;
        }
    }
    return worst;
}

function scoreComponents(components) {
    const values = Object.values(components || {});
    if (values.length === 0) return 100;
    const total = values.reduce((sum, component) => {
        return sum + (STATUS_SCORE[normalizeStatus(component?.status)] ?? 0);
    }, 0);
    return Math.round(total / values.length);
}

function overallFromComponents(components) {
    const worst = worstStatus(Object.values(components || {}).map(component => component?.status || 'ok'));
    if (worst === 'critical') return 'critical';
    if (worst === 'error') return 'error';
    if (worst === 'warning') return 'degraded';
    return 'ok';
}

function componentFromLegacy(legacy, okMessage) {
    const status = normalizeStatus(legacy?.status || 'ok');
    return makeComponent(status, legacy?.message || okMessage, {
        failCount: Number(legacy?.failCount) || 0,
        lastCheck: legacy?.lastCheck || null
    });
}

function classifyMonitorExtraction(monitor, nowMs = Date.now()) {
    const delayMs = typeof monitor?.getExtractionBackoffDelayMs === 'function'
        ? monitor.getExtractionBackoffDelayMs(nowMs)
        : Math.max(0, Number(monitor?.nextRetryAt || 0) - nowMs);
    const classification = safeClassification(monitor?.lastFailureClassification ||
        monitor?.lastExtractionFailureClassification ||
        null);
    const consecutiveFailures = Number(monitor?.consecutiveExtractionFailures) || 0;

    if (delayMs > 0) {
        return makeComponent('warning', `Em backoff de extracao (${classification || 'unknown'})`, {
            classification,
            retryAfterSeconds: Math.ceil(delayMs / 1000),
            nextRetryAt: monitor?.nextRetryAt || null,
            consecutiveFailures
        });
    }

    if (isAuthCookieClassification(classification)) {
        return makeComponent('error', 'Falha de autenticacao durante extracao', {
            classification,
            consecutiveFailures
        });
    }

    if (classification && classification !== 'unknown') {
        const status = !isTerminalAvailabilityClassification(classification) &&
            consecutiveFailures >= PERSISTENT_EXTRACTION_FAILURES
            ? 'error'
            : 'warning';
        return makeComponent(status, `Ultima falha de extracao: ${classification}`, {
            classification,
            consecutiveFailures
        });
    }

    const metadata = monitor?.health?.metadata;
    if (metadata && normalizeStatus(metadata.status) !== 'ok') {
        return componentFromLegacy(metadata, 'Metadados instaveis');
    }

    return makeComponent('ok', 'Extracao sem falha ativa', {
        source: safeClassification(monitor?.lastSuccessfulExtractionSource || null),
        lastSuccessAt: monitor?.lastExtractionSuccessAt || null
    });
}

function classifyMonitorManifest(monitor) {
    const playlistUrls = monitor?._playlistUrls || {};
    const hasPlaylistUrls = Object.keys(playlistUrls).length > 0;
    const hasManifest = Boolean(monitor?.m3u8Url || monitor?._masterContent || hasPlaylistUrls);
    const classification = safeClassification(monitor?.lastExtractionFailureClassification || monitor?.lastFailureClassification || null);

    if (hasManifest) {
        return makeComponent('ok', 'Manifesto HLS disponivel', {
            hasMaster: Boolean(monitor?._masterContent),
            playlistCount: Object.keys(playlistUrls).length
        });
    }

    if (classification) {
        return makeComponent('warning', `Manifesto indisponivel (${classification})`, { classification });
    }

    return makeComponent('warning', 'Manifesto HLS ainda nao disponivel');
}

function classifyMonitorStream(monitor) {
    const playlist = monitor?.health?.playlist;
    if (playlist && normalizeStatus(playlist.status) !== 'ok') {
        return componentFromLegacy(playlist, 'Stream instavel');
    }

    if ((Number(monitor?.stalledCount) || 0) > 0) {
        return makeComponent('warning', `Stream sem avanco (${monitor.stalledCount} ciclo(s))`, {
            stalledCount: Number(monitor.stalledCount) || 0,
            lastMediaSequence: monitor?.lastMediaSequence ?? null
        });
    }

    if (!monitor?.m3u8Url) {
        return makeComponent('warning', 'Stream sem URL HLS ativa');
    }

    return makeComponent('ok', 'Stream HLS ativa', {
        lastMediaSequence: monitor?.lastMediaSequence ?? null
    });
}

function classifyMonitorCookies(monitor) {
    const classification = safeClassification(monitor?.lastFailureClassification ||
        monitor?.lastExtractionFailureClassification ||
        null);
    if (isAuthCookieClassification(classification)) {
        return makeComponent('error', 'Falha de autenticacao/cookie', { classification });
    }

    const cookies = monitor?.health?.cookies;
    if (cookies && normalizeStatus(cookies.status) !== 'ok') {
        return componentFromLegacy(cookies, 'Cookie instavel');
    }
    return makeComponent('ok', 'Cookies funcionais');
}

function buildMonitorHealth(monitor, options = {}) {
    const nowMs = normalizeTimestampMs(options.nowMs);
    const components = {
        cookies: classifyMonitorCookies(monitor),
        extraction: classifyMonitorExtraction(monitor, nowMs),
        manifest: classifyMonitorManifest(monitor),
        stream: classifyMonitorStream(monitor)
    };
    const status = overallFromComponents(components);
    return {
        status,
        score: scoreComponents(components),
        components,
        nextRetryAt: normalizeTimestampMs(monitor?.nextRetryAt, 0),
        backoffSeconds: Number(monitor?.backoffSeconds) || 0,
        lastFailureClassification: safeClassification(monitor?.lastFailureClassification || monitor?.lastExtractionFailureClassification || null)
    };
}

function aggregateComponent(monitors, key, emptyMessage) {
    if (!monitors.length) {
        return makeComponent('ok', emptyMessage || 'Sem lives em monitoramento', { affected: 0, total: 0 });
    }

    const statuses = monitors.map(item => item.health.components[key]?.status || 'ok');
    const worst = worstStatus(statuses);
    const affected = monitors.filter(item => normalizeStatus(item.health.components[key]?.status) !== 'ok').length;
    const worstComponents = monitors
        .map(item => item.health.components[key])
        .filter(component => normalizeStatus(component?.status) === worst);
    const primaryWorst = worstComponents[0] || {};
    const messages = monitors
        .filter(item => normalizeStatus(item.health.components[key]?.status) === worst)
        .map(item => `${safeIdentifier(item.videoId)}: ${item.health.components[key]?.message}`)
        .slice(0, 3);

    return makeComponent(worst, affected
        ? `${affected}/${monitors.length} live(s) com alerta em ${COMPONENT_LABELS[key] || key}`
        : `${COMPONENT_LABELS[key] || key} OK`, {
            affected,
            total: monitors.length,
            examples: messages,
            actionCode: primaryWorst.actionCode || null,
            recommendedAction: primaryWorst.recommendedAction || null
        });
}

function splitMonitorKey(key) {
    const parts = String(key || '').split(':');
    return {
        videoId: parts[0] || 'unknown',
        owner: parts[1] || null
    };
}

function buildBackoffExtractionEntry(key, state, nowMs) {
    const { videoId, owner } = splitMonitorKey(key);
    const retryAt = Number(state?.nextRetryAt) || 0;
    const retryAfterSeconds = retryAt > nowMs ? Math.ceil((retryAt - nowMs) / 1000) : 0;
    const classification = safeClassification(state?.lastFailureClassification || 'unknown');
    return {
        key,
        videoId: safeIdentifier(videoId),
        owner: owner ? safeIdentifier(owner, null) : null,
        status: 'degraded',
        health: {
            components: {
                extraction: makeComponent('warning', retryAfterSeconds > 0
                    ? `Conversao em backoff (${classification})`
                    : `Conversao aguardando recuperacao (${classification})`, {
                        classification,
                        retryAfterSeconds,
                        nextRetryAt: retryAt,
                        consecutiveFailures: Number(state?.consecutiveExtractionFailures) || 0
                    })
            }
        }
    };
}

function buildGlobalExtractionEntry(state, nowMs) {
    const retryAt = Number(state?.nextRetryAt) || 0;
    const retryAfterSeconds = retryAt > nowMs ? Math.ceil((retryAt - nowMs) / 1000) : 0;
    const classification = safeClassification(state?.lastFailureClassification || 'unknown');
    const refreshQueuedAt = normalizeTimestampMs(state?.lastAutomaticCookieRefreshQueuedAt, 0);
    const refreshQueued = refreshQueuedAt > 0;
    return {
        key: 'global',
        videoId: 'global',
        owner: null,
        status: 'critical',
        health: {
            components: {
                extraction: makeComponent('critical', retryAfterSeconds > 0
                    ? `Extracao global critica em backoff (${classification})`
                    : `Extracao global critica (${classification})`, {
                        classification,
                        retryAfterSeconds,
                        nextRetryAt: retryAt,
                        consecutiveFailures: Number(state?.consecutiveExtractionFailures) || 0,
                        actionCode: refreshQueued ? 'automatic_cookie_refresh_queued' : 'cookie_refresh_recommended',
                        recommendedAction: refreshQueued
                            ? 'Renovacao automatica de cookies ja solicitada; acompanhe o agente.'
                            : 'Se persistir, solicite Atualizar Todos ou aguarde a renovacao automatica.',
                        automaticCookieRefreshQueuedAt: refreshQueuedAt || null,
                        automaticCookieRefreshReason: state?.automaticCookieRefreshReason || null
                    })
            }
        }
    };
}

function classifyAuth(options = {}) {
    if (options.sessionAdmin === false) {
        return makeComponent('error', 'Sessao administrativa ausente');
    }
    return makeComponent('ok', 'Autenticacao administrativa ativa');
}

function classifyCookies(functional = {}) {
    const entries = Object.entries(functional || {});
    if (entries.length === 0) {
        return makeComponent('warning', 'Status de cookies indisponivel', { valid: 0, total: 0 });
    }

    const valid = entries.filter(([, info]) => info?.valid === true);
    const alerted = entries.filter(([, info]) => info?.alertActive === true || ['invalid', 'suspect'].includes(info?.state));
    const authValid = entries.filter(([, info]) => info?.authReady === true ||
        (info?.authReady !== false && info?.authValid !== false && info?.state !== 'invalid'));
    const extractionValid = entries.filter(([, info]) => info?.extractionValid !== false);
    const streamValid = entries.filter(([, info]) => info?.streamValid !== false);
    const streamReady = entries.filter(([, info]) => info?.streamReady === true ||
        (info?.streamReady !== false && info?.extractionValid !== false && info?.streamValid !== false && info?.hlsValid !== false));
    const streamDegraded = entries.filter(([, info]) => info?.authValid !== false &&
        (info?.capabilityStatus === 'degraded' || info?.extractionValid === false || info?.streamValid === false || info?.hlsValid === false));
    const inconclusive = entries.filter(([, info]) => info?.capabilityStatus === 'inconclusive' || info?.streamProbeStatus === 'inconclusive');

    if (authValid.length === 0) {
        return makeComponent('critical', 'Nenhum cookie autenticado valido', {
            valid: 0,
            total: entries.length,
            authValid: authValid.length,
            extractionValid: extractionValid.length,
            streamValid: streamValid.length,
            streamReady: streamReady.length
        });
    }

    if (alerted.length > 0) {
        return makeComponent('warning', `${authValid.length}/${entries.length} cookie(s) autenticado(s); ${alerted.length} com alerta`, {
            valid: valid.length,
            total: entries.length,
            authValid: authValid.length,
            extractionValid: extractionValid.length,
            streamValid: streamValid.length,
            streamReady: streamReady.length,
            alerted: alerted.map(([name]) => name)
        });
    }

    if (streamDegraded.length > 0) {
        return makeComponent('warning', `${authValid.length}/${entries.length} cookie(s) autenticado(s); ${streamReady.length}/${entries.length} apto(s) para stream autenticado`, {
            valid: valid.length,
            total: entries.length,
            authValid: authValid.length,
            extractionValid: extractionValid.length,
            streamValid: streamValid.length,
            streamReady: streamReady.length,
            degraded: streamDegraded.map(([name]) => name),
            recommendedAction: 'Fallback publico operacional quando disponivel; cookies autenticados com stream degradado.'
        });
    }

    if (inconclusive.length > 0) {
        return makeComponent('warning', `${authValid.length}/${entries.length} cookie(s) autenticado(s); validacao de stream inconclusiva`, {
            valid: valid.length,
            total: entries.length,
            authValid: authValid.length,
            extractionValid: extractionValid.length,
            streamValid: streamValid.length,
            streamReady: streamReady.length,
            inconclusive: inconclusive.map(([name]) => name)
        });
    }

    return makeComponent('ok', `${authValid.length}/${entries.length} cookie(s) autenticado(s); ${streamReady.length}/${entries.length} apto(s) para stream`, {
        valid: valid.length,
        total: entries.length,
        authValid: authValid.length,
        extractionValid: extractionValid.length,
        streamValid: streamValid.length,
        streamReady: streamReady.length
    });
}

function classifyAgent(cookieRefreshStatus = {}) {
    if (!cookieRefreshStatus.enabled) {
        return makeComponent('warning', 'Agente Windows desativado', { enabled: false });
    }

    const agent = cookieRefreshStatus.agent || {};
    const state = agent.status || (agent.online ? 'online' : 'offline');
    if (state === 'online') {
        return makeComponent('ok', 'Agente Windows online', {
            enabled: true,
            lastHeartbeatAt: agent.lastHeartbeatAt || agent.lastSeen || null
        });
    }
    if (state === 'degraded') {
        return makeComponent('warning', 'Agente Windows degradado', {
            enabled: true,
            reason: agent.reason || null,
            lastHeartbeatAt: agent.lastHeartbeatAt || agent.lastSeen || null
        });
    }
    return makeComponent('error', 'Agente Windows offline', {
        enabled: true,
        reason: agent.reason || null,
        lastHeartbeatAt: agent.lastHeartbeatAt || agent.lastSeen || null
    });
}

function getMonitorDisplayStatus(monitor, monitorHealth) {
    const raw = monitor?.liveState || (monitor?.isLive ? 'online' : 'offline');
    if (raw === 'ended' || monitor?._liveEnded) return 'ended';
    if (isMonitorEnding(monitor)) return 'ending';
    if (raw === 'offline') return 'offline';
    if (monitorHealth?.status && monitorHealth.status !== 'ok') return 'degraded';
    return raw;
}

function buildSystemHealth(options = {}) {
    const converter = options.converter;
    const nowMs = normalizeTimestampMs(options.nowMs);
    const monitorEntries = [];
    const operationalMonitorEntries = [];
    const activeKeys = new Set();
    if (converter?.activeMonitors) {
        for (const [key, monitor] of converter.activeMonitors.entries()) {
            if (monitor?._monitorStopped || monitor?._liveEnded || monitor?.liveState === 'ended') continue;
            const [videoId, owner] = String(key).split(':');
            const health = buildMonitorHealth(monitor, { nowMs });
            const displayStatus = getMonitorDisplayStatus(monitor, health);
            const ending = displayStatus === 'ending';
            const terminalAvailability = isMonitorTerminalAvailability(monitor);
            activeKeys.add(key);
            const entry = {
                key,
                videoId: safeIdentifier(videoId),
                owner: owner ? safeIdentifier(owner, null) : null,
                status: displayStatus,
                ending,
                terminalAvailability,
                health
            };
            monitorEntries.push(entry);
            if (!terminalAvailability) operationalMonitorEntries.push(entry);
        }
    }

    const extractionEntries = [...operationalMonitorEntries];
    if (converter?.extractionBackoff instanceof Map) {
        for (const [key, state] of converter.extractionBackoff.entries()) {
            if (activeKeys.has(key)) continue;
            const hasFailure = Boolean(
                state?.lastFailureClassification ||
                state?.consecutiveExtractionFailures ||
                (Number(state?.nextRetryAt) || 0) > nowMs
            );
            const classification = safeClassification(state?.lastFailureClassification || null);
            if (hasFailure && !isTerminalAvailabilityClassification(classification)) {
                extractionEntries.push(buildBackoffExtractionEntry(key, state, nowMs));
            }
        }
    }
    if (converter?.globalExtractionCritical && converter?.globalExtractionBackoff) {
        const state = converter.globalExtractionBackoff;
        const hasFailure = Boolean(
            state?.lastFailureClassification ||
            state?.consecutiveExtractionFailures ||
            (Number(state?.nextRetryAt) || 0) > nowMs
        );
        if (hasFailure) {
            extractionEntries.push(buildGlobalExtractionEntry(state, nowMs));
        }
    }

    const monitorCookieAggregate = aggregateComponent(operationalMonitorEntries, 'cookies', 'Cookies dos monitores OK');
    const functionalCookies = classifyCookies(options.cookieFunctionalStatus || {});
    const cookieStatus = worstStatus([functionalCookies.status, monitorCookieAggregate.status]);
    const cookies = makeComponent(cookieStatus, monitorCookieAggregate.status !== 'ok'
        ? monitorCookieAggregate.message
        : functionalCookies.message, {
            functional: {
                status: functionalCookies.status,
                valid: functionalCookies.valid,
                total: functionalCookies.total,
                authValid: functionalCookies.authValid,
                extractionValid: functionalCookies.extractionValid,
                streamValid: functionalCookies.streamValid,
                streamReady: functionalCookies.streamReady,
                degraded: functionalCookies.degraded || [],
                inconclusive: functionalCookies.inconclusive || [],
                alerted: functionalCookies.alerted || []
            },
            monitors: {
                affected: monitorCookieAggregate.affected || 0,
                total: monitorCookieAggregate.total || 0
            }
        });

    const authCookieFailures = operationalMonitorEntries.filter(item =>
        normalizeStatus(item.health?.components?.cookies?.status) === 'error' ||
        normalizeStatus(item.health?.components?.cookies?.status) === 'critical' ||
        isAuthCookieClassification(item.health?.lastFailureClassification)
    ).length;
    const authenticationBase = classifyAuth(options.auth || {});
    const authentication = authCookieFailures > 0
        ? makeComponent('error', `${authCookieFailures} live(s) com falha de autenticacao/cookie`, {
            affected: authCookieFailures
        })
        : authenticationBase;

    const components = {
        authentication,
        cookies,
        extraction: aggregateComponent(extractionEntries, 'extraction', 'Sem extracao ativa'),
        manifest: aggregateComponent(operationalMonitorEntries, 'manifest', 'Sem manifestos ativos'),
        stream: aggregateComponent(operationalMonitorEntries, 'stream', 'Sem streams ativos'),
        agent: classifyAgent(options.cookieRefreshStatus || {})
    };

    const status = overallFromComponents(components);
    return {
        status,
        score: scoreComponents(components),
        components,
        summary: {
            activeMonitors: operationalMonitorEntries.length,
            endingMonitors: monitorEntries.filter(item => item.status === 'ending').length,
            terminalAvailabilityMonitors: monitorEntries.filter(item => item.terminalAvailability).length,
            degradedMonitors: operationalMonitorEntries.filter(item => item.status === 'degraded').length,
            backoffMonitors: extractionEntries.filter(item => item.health?.components?.extraction?.retryAfterSeconds > 0).length,
            pendingExtractions: extractionEntries.length - operationalMonitorEntries.length
        },
        timestamp: safeIsoTimestamp(nowMs)
    };
}

module.exports = {
    COMPONENT_LABELS,
    buildMonitorHealth,
    buildSystemHealth,
    getMonitorDisplayStatus,
    isMonitorEnding,
    isMonitorTerminalAvailability,
    normalizeStatus,
    overallFromComponents,
    scoreComponents
};
