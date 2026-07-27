'use strict';

// ========== TTL DINAMICO DE PLAYLIST HLS ==========
//
// Causa confirmada em duas lives / dois equipamentos:
//   - EXTINF = 2.000 s, TARGETDURATION = 2
//   - M3U8_CACHE_TTL efetivo = 15000 ms (TTL/EXTINF = 7.5)
//   - mesma MEDIA-SEQUENCE servida por ate 15129 ms
//   - upstream ja havia avancado
//   - ExoPlayer 2.9.1 dispara PlaylistStuckException
//   - SBT com EXTINF=5 s nao apresenta o problema
//
// Correcao minima e segura: TTL da playlist HLS passa a ser dinamico,
// limitado a min(configuredTtl, segmentDurationMs * 2).
//
// Prefere o maior EXTINF valido da janela (mais conservador que TARGETDURATION,
// que pode ser menor que EXTINF real). Fallback para TARGETDURATION * 1000 se
// EXTINF estiver ausente/invalido. Fallback final para configuredTtl.

// Extrai o maior EXTINF valido (em segundos) da playlist.
// valores invalidos/negativos/NaN sao ignorados. Retorna null se nenhum valido.
function extractMaxExtinfSeconds(content) {
    const source = String(content || '');
    if (!source) return null;

    const extinfRegex = /#EXTINF:([0-9]+(?:\.[0-9]+)?)/g;
    let maxExtinf = null;
    let match;
    while ((match = extinfRegex.exec(source)) !== null) {
        const value = parseFloat(match[1]);
        if (Number.isFinite(value) && value > 0) {
            if (maxExtinf === null || value > maxExtinf) {
                maxExtinf = value;
            }
        }
    }
    return maxExtinf;
}

// Extrai TARGETDURATION da playlist (segundos inteiros). Retorna null se
// ausente/invalido.
function extractTargetDurationSeconds(content) {
    const source = String(content || '');
    if (!source) return null;
    const match = source.match(/^#EXT-X-TARGETDURATION:(\d+)/m);
    if (!match) return null;
    const value = parseInt(match[1], 10);
    return Number.isFinite(value) && value > 0 ? value : null;
}

// Calcula o TTL dinamico da playlist.
//   segmentDurationMs = maior EXTINF valido * 1000, fallback TARGETDURATION * 1000
//   dynamicTtl = min(configuredTtl, segmentDurationMs * 2)
// Limites defensivos:
//   - nunca <= 0
//   - nunca NaN
//   - nunca maior que configuredTtl
//   - fallback para configuredTtl se parsing falhar
//   - se configuredTtl for invalido, fallback hardcoded 2000
function computeDynamicPlaylistTtl(configuredTtl, content) {
    const cfg = Number(configuredTtl);
    if (!Number.isFinite(cfg) || cfg <= 0) {
        return 2000;
    }

    const maxExtinf = extractMaxExtinfSeconds(content);
    const targetDuration = extractTargetDurationSeconds(content);

    let segmentDurationSec = null;
    if (maxExtinf !== null && Number.isFinite(maxExtinf) && maxExtinf > 0) {
        segmentDurationSec = maxExtinf;
    } else if (targetDuration !== null && Number.isFinite(targetDuration) && targetDuration > 0) {
        segmentDurationSec = targetDuration;
    }

    if (segmentDurationSec === null || !Number.isFinite(segmentDurationSec) || segmentDurationSec <= 0) {
        return cfg;
    }

    const segmentDurationMs = segmentDurationSec * 1000;
    const computed = segmentDurationMs * 2;

    if (!Number.isFinite(computed) || computed <= 0) {
        return cfg;
    }

    const dynamicTtl = Math.min(cfg, computed);
    if (!Number.isFinite(dynamicTtl) || dynamicTtl <= 0) {
        return cfg;
    }

    return dynamicTtl;
}

// ========== ALLOWLIST DE CANARIO POR VIDEOID ==========
// Permite ativacao incremental do TTL dinamico no mesmo processo PM2.
// Formato: "videoId1,videoId2" (string simples, sem env). Vazia => desabilitada.

// Faz parsing defensivo de uma string de allowlist (ex: env var).
// Retorna um Set de ids sem espacos e sem vazios. Vazio => desabilitado.
function parseCanaryVideoIds(raw) {
    const value = String(raw || '').trim();
    if (!value) return new Set();
    const ids = value.split(',')
        .map(id => id.trim())
        .filter(id => id.length > 0);
    return new Set(ids);
}

// Extrai o videoId real a partir da chave de cache usada por fetchM3u8WithCache.
// Chaves:
//   - fallback: "videoId"                        (ex: "_ePSDGh4YOw" ou "LLpNUqHVam8")
//   - variantes: "videoId_height_upstreamHash"   (ex: "_ePSDGh4YOw_720_abc123")
// O videoId do YouTube tem SEMPRE 11 caracteres de [A-Za-z0-9_-] (inclui '_').
// Logo nao basta cortar no primeiro '_'. Heuristica:
//   - Se a chave tiver > 11 chars E o char na posicao 11 for '_', os primeiros 11
//     chars sao o videoId canonico e o restante e o sufixo composto (quality/hash).
//   - Caso contrario (<= 11 chars, ou 12+ chars sem '_' na posicao 11), assume que
//     a chave inteira e o videoId (fluxo fallback) ou algum esquema novo; retorna-a
//     inteira para que a comparacao de allowlist seja feita contra a chave canonica.
// Para o canario, recomenda-se que a allowlist use o videoId canonico de 11 chars.
function extractVideoIdFromCacheKey(cacheKey) {
    if (typeof cacheKey !== 'string' || cacheKey.length === 0) return '';
    if (cacheKey.length > 11 && cacheKey[11] === '_') {
        return cacheKey.slice(0, 11);
    }
    return cacheKey;
}

// Resolve o TTL efetivo considerando a allowlist de canario.
// - allowlist vazia: retorna configuredTtl (TTL dinamica desabilitada).
// - cacheKey fora da allowlist: retorna configuredTtl.
// - cacheKey dentro da allowlist: retorna min(configuredTtl, maxExtinf*2).
function resolveEffectivePlaylistTtl(cacheKey, configuredTtl, content, canarySet) {
    const cfg = Number(configuredTtl);
    if (!Number.isFinite(cfg) || cfg <= 0) {
        return 2000;
    }
    if (!canarySet || canarySet.size === 0) return cfg;
    const videoId = extractVideoIdFromCacheKey(cacheKey);
    if (!videoId || !canarySet.has(videoId)) return cfg;
    return computeDynamicPlaylistTtl(cfg, content);
}

// Verifica se a chave de cache esta na allowlist canary (para telemetria).
function isDynamicTtlCanaryVideo(cacheKey, canarySet) {
    if (!canarySet || canarySet.size === 0) return false;
    const videoId = extractVideoIdFromCacheKey(cacheKey);
    return !!(videoId && canarySet.has(videoId));
}

// ========== AUTO SHORT-SEGMENTS ==========
// Protecao automatica para playlists de segmentos curtos (EXTINF <= threshold).
// Diferente da allowlist manual, esta logica aplica-se a todas as lives cuja
// playlist contenha um EXTINF valido <= threshold segundos. Master playlist
// nunca recebe reducao automatica (sem EXTINF). TARGETDURATION NAO e usado
// para forcar reducao: a decisao depende SOMENTE de EXTINF valido, evitando
// falsos positivos (algumas playlists tem TARGETDURATION=2 mas EXTINF=5, etc).
//
// Politica (configurada via env):
//   HLS_DYNAMIC_TTL_AUTO_SHORT_SEGMENTS=true habilita
//   HLS_DYNAMIC_TTL_SHORT_SEGMENT_MAX_SECONDS=3   (default 3)
//
// decisao:
//   auto=true AND maxExtinf valido AND 0 < maxExtinf <= threshold
//     => effectiveTtl = min(configuredTtl, maxExtinf*1000*2)
//   caso contrario
//     => effectiveTtl = configuredTtl
//
// Retorna { ttl, applied, extinf, threshold } para o chamador poder logar/telemetrar.

// Helper: faz parse do threshold (env ou valor passado). Default 3, fallback 3.
function parseShortSegmentMaxSeconds(raw) {
    const v = parseFloat(raw);
    if (!Number.isFinite(v) || v <= 0) return 3;
    return v;
}

// Resolve TTL automatico por segmento curto. Funcao pura, testavel isoladamente.
function resolveAutoShortSegmentTtl(options) {
    const cfg = Number(options.configuredTtl);
    if (!Number.isFinite(cfg) || cfg <= 0) {
        return { ttl: 2000, applied: false, extinf: null, threshold: null, reason: 'invalid_cfg' };
    }

    const autoEnabled = options.autoShortSegmentsEnabled === true ||
                        String(options.autoShortSegmentsEnabled || '').toLowerCase() === 'true';
    const threshold = Number(options.shortSegmentMaxSeconds);
    const thr = (Number.isFinite(threshold) && threshold > 0) ? threshold : parseShortSegmentMaxSeconds(options.shortSegmentMaxSeconds);

    if (!autoEnabled) {
        return { ttl: cfg, applied: false, extinf: null, threshold: thr, reason: 'auto_disabled' };
    }

    const maxExtinf = extractMaxExtinfSeconds(options.playlistBody);
    if (maxExtinf === null || !Number.isFinite(maxExtinf) || maxExtinf <= 0) {
        return { ttl: cfg, applied: false, extinf: null, threshold: thr, reason: 'no_valid_extinf' };
    }

    if (maxExtinf > thr) {
        return { ttl: cfg, applied: false, extinf: maxExtinf, threshold: thr, reason: 'extinf_above_threshold' };
    }

    const computed = maxExtinf * 1000 * 2;
    if (!Number.isFinite(computed) || computed <= 0) {
        return { ttl: cfg, applied: false, extinf: maxExtinf, threshold: thr, reason: 'computed_invalid' };
    }

    const effective = Math.min(cfg, computed);
    if (!Number.isFinite(effective) || effective <= 0) {
        return { ttl: cfg, applied: false, extinf: maxExtinf, threshold: thr, reason: 'effective_invalid' };
    }

    const applied = effective < cfg;
    return {
        ttl: effective,
        applied,
        extinf: maxExtinf,
        threshold: thr,
        reason: applied ? 'auto_short_segment_reduced' : 'effective_equal_cfg'
    };
}

module.exports = {
    extractMaxExtinfSeconds,
    extractTargetDurationSeconds,
    computeDynamicPlaylistTtl,
    parseCanaryVideoIds,
    extractVideoIdFromCacheKey,
    resolveEffectivePlaylistTtl,
    isDynamicTtlCanaryVideo,
    // novidades auto short-segments
    parseShortSegmentMaxSeconds,
    resolveAutoShortSegmentTtl
};
