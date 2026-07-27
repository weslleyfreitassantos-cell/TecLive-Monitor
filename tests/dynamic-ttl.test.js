'use strict';

// Testes unitarios para o TTL dinamico de playlist HLS.
// Ver requisito: IMPLEMENTAR CANDIDATO DE CORRECAO PARA PLAYLIST STALE EM EXTINF CURTO.
//
// Casos A-H previstos no requisito:
//   A) configured=15000, EXTINF=2          -> effective=4000
//   B) configured=15000, EXTINF=5          -> effective=10000
//   C) configured=15000, EXTINF=8          -> effective=15000 (cap em configuredTtl)
//   D) EXTINF invalido, TARGETDURATION=2   -> effective=4000 (fallback TD)
//   E) EXTINF e TD invalidos               -> effective=15000 (fallback cfg)
//   F) multiplos EXTINF (2,3,5)           -> maior valido (5*2=10000)
//   G) TTL nunca ultrapassa configuredTtl
//   H) cache continua funcionando (smoke single-flight structure)

const assert = require('assert');
const {
    extractMaxExtinfSeconds,
    extractTargetDurationSeconds,
    computeDynamicPlaylistTtl,
    parseCanaryVideoIds,
    extractVideoIdFromCacheKey,
    resolveEffectivePlaylistTtl,
    isDynamicTtlCanaryVideo
} = require('../services/dynamicTtl');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function buildMediaPlaylist(opts = {}) {
    const seq = opts.seq || 1000;
    const count = opts.count || 4;
    const dur = opts.dur;          // numero (extinf por segmento, igual para todos)
    const extinfs = opts.extinfs;  // array alternativo: lista de duracoes por segmento
    const target = opts.target;    // TARGETDURATION inteiro
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    if (target !== undefined) lines.push(`#EXT-X-TARGETDURATION:${target}`);
    lines.push(`#EXT-X-MEDIA-SEQUENCE:${seq}`);
    for (let i = 0; i < count; i++) {
        const d = extinfs ? extinfs[i % extinfs.length] : dur;
        if (d !== undefined && d !== null) {
            lines.push(`#EXTINF:${d},`);
        }
        lines.push(`https://upstream.test/seg${seq + i}.ts`);
    }
    return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// A) configured=15000 EXTINF=2 -> effective=4000
// ---------------------------------------------------------------------------
assert.strictEqual(
    computeDynamicPlaylistTtl(15000, buildMediaPlaylist({ dur: 2.0, target: 2 })),
    4000,
    'A: configured=15000 EXTINF=2 deve resultar em 4000'
);

// ---------------------------------------------------------------------------
// B) configured=15000 EXTINF=5 -> effective=10000
// ---------------------------------------------------------------------------
assert.strictEqual(
    computeDynamicPlaylistTtl(15000, buildMediaPlaylist({ dur: 5.0, target: 5 })),
    10000,
    'B: configured=15000 EXTINF=5 deve resultar em 10000'
);

// ---------------------------------------------------------------------------
// C) configured=15000 EXTINF=8 -> effective=15000 (cap em configuredTtl)
// ---------------------------------------------------------------------------
assert.strictEqual(
    computeDynamicPlaylistTtl(15000, buildMediaPlaylist({ dur: 8.0, target: 8 })),
    15000,
    'C: configured=15000 EXTINF=8 deve resultar em 15000 (cap configured)'
);

// ---------------------------------------------------------------------------
// D) EXTINF invalido, TARGETDURATION=2 -> effective=4000 (fallback TD)
// ---------------------------------------------------------------------------
{
    const playlist = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:2',
        '#EXT-X-MEDIA-SEQUENCE:100',
        '#EXTINF:abc,',
        'https://upstream.test/seg100.ts',
        '#EXTINF:-3,',
        'https://upstream.test/seg101.ts',
        '#EXTINF:0,',
        'https://upstream.test/seg102.ts'
    ].join('\n') + '\n';
    assert.strictEqual(
        computeDynamicPlaylistTtl(15000, playlist),
        4000,
        'D: EXTINF invalido + TD=2 deve resultar em 4000'
    );
}

// ---------------------------------------------------------------------------
// E) EXTINF e TD invalidos -> effective=15000 (fallback cfg)
// ---------------------------------------------------------------------------
{
    const playlist = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:abc',
        '#EXT-X-MEDIA-SEQUENCE:100',
        '#EXTINF:xyz,',
        'https://upstream.test/seg100.ts'
    ].join('\n') + '\n';
    assert.strictEqual(
        computeDynamicPlaylistTtl(15000, playlist),
        15000,
        'E: EXTINF e TD invalidos deve resultar em 15000 (cfg)'
    );
}

// ---------------------------------------------------------------------------
// F) multiplos EXTINF (2,3,5) -> maior valido = 5 -> effective=10000
// ---------------------------------------------------------------------------
{
    const playlist = buildMediaPlaylist({
        extinfs: [2.0, 3.0, 5.0],
        count: 3,
        target: 5
    });
    assert.strictEqual(extractMaxExtinfSeconds(playlist), 5.0, 'F: maior EXTINF deve ser 5');
    assert.strictEqual(
        computeDynamicPlaylistTtl(15000, playlist),
        10000,
        'F: multiplos EXTINF (max=5) deve resultar em 10000'
    );
}

// ---------------------------------------------------------------------------
// G) TTL nunca ultrapassa configuredTtl (varios cenarios)
// ---------------------------------------------------------------------------
{
    const scenarios = [
        { cfg: 15000, dur: 2.0, target: 2 },
        { cfg: 15000, dur: 5.0, target: 5 },
        { cfg: 15000, dur: 8.0, target: 8 },
        { cfg: 15000, dur: 100.0, target: 100 },
        { cfg: 2000, dur: 5.0, target: 5 },     // cfg < 2*extinf -> cfg
        { cfg: 500, dur: 2.0, target: 2 }       // cfg < 2*extinf -> cfg
    ];
    for (const s of scenarios) {
        const result = computeDynamicPlaylistTtl(s.cfg, buildMediaPlaylist({ dur: s.dur, target: s.target }));
        assert.ok(
            result <= s.cfg,
            `G: TTL resultante (${result}) nao deve ultrapassar configured (${s.cfg})`
        );
    }
}

// ---------------------------------------------------------------------------
// G2) TTL nunca <= 0 e nunca NaN
// ---------------------------------------------------------------------------
{
    const badContents = [null, undefined, '', 'not a playlist', '#EXTM3U\n'];
    for (const c of badContents) {
        const result = computeDynamicPlaylistTtl(15000, c);
        assert.ok(Number.isFinite(result) && result > 0, `G2: TTL deve ser finito > 0 para conteudo="${c}"`);
    }
    // configuredTtl invalido -> fallback 2000
    const badCfgs = [NaN, null, undefined, 0, -1, 'abc'];
    for (const cfg of badCfgs) {
        const result = computeDynamicPlaylistTtl(cfg, buildMediaPlaylist({ dur: 2.0, target: 2 }));
        assert.ok(Number.isFinite(result) && result > 0, `G2: TTL deve ser finito > 0 para cfg="${cfg}"`);
    }
}

// ---------------------------------------------------------------------------
// H) cache continua funcionando (smoke): estrutura single-flight preservada
// Verificacao indireta: as funcoes de TTL sao puras e deterministas.
// Mesmo conteudo + mesmo configuredTtl -> mesmo TTL.
// ---------------------------------------------------------------------------
{
    const playlist = buildMediaPlaylist({ dur: 5.0, target: 5 });
    const ttl1 = computeDynamicPlaylistTtl(15000, playlist);
    const ttl2 = computeDynamicPlaylistTtl(15000, playlist);
    assert.strictEqual(ttl1, ttl2, 'H: TTL determinista para mesmo input');
    assert.strictEqual(ttl1, 10000, 'H: TTL esperado 10000');
}

// ---------------------------------------------------------------------------
// Extras: extractTargetDurationSeconds
// ---------------------------------------------------------------------------
assert.strictEqual(extractTargetDurationSeconds('#EXT-X-TARGETDURATION:6'), 6);
assert.strictEqual(extractTargetDurationSeconds('#EXT-X-TARGETDURATION:0'), null);
assert.strictEqual(extractTargetDurationSeconds('#EXT-X-TARGETDURATION:-2'), null);
assert.strictEqual(extractTargetDurationSeconds('no target here'), null);
assert.strictEqual(extractTargetDurationSeconds(null), null);
assert.strictEqual(extractTargetDurationSeconds(''), null);

// ---------------------------------------------------------------------------
// Extras: extractMaxExtinfSeconds
// ---------------------------------------------------------------------------
assert.strictEqual(extractMaxExtinfSeconds('#EXTINF:2.0,\nseg.ts'), 2.0);
assert.strictEqual(extractMaxExtinfSeconds('#EXTINF:5,\nseg.ts\n#EXTINF:5.500,\nseg2.ts'), 5.5);
assert.strictEqual(extractMaxExtinfSeconds('#EXTINF:abc,'), null);
assert.strictEqual(extractMaxExtinfSeconds('#EXTINF:-1.0,'), null);
assert.strictEqual(extractMaxExtinfSeconds('sem extinf'), null);
assert.strictEqual(extractMaxExtinfSeconds(null), null);

console.log('OK dynamic-ttl.test.js: todos os ' +
    'casos A-H + extras passaram.');

// ===========================================================================
// Casos I-N: canario allowlist (HLS_DYNAMIC_TTL_CANARY_VIDEO_IDS)
// ===========================================================================
const CANARY_VIDEO = '_ePSDGh4YOw';
const SBT_VIDEO = 'LLpNUqHVam8';

// Helpers de playlist media/master para casos I-N
const mediaExtinf2 = buildMediaPlaylist({ dur: 2.0, target: 2, count: 3 });
const masterPlaylist = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720',
    'https://upstream.test/720.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480',
    'https://upstream.test/480.m3u8'
].join('\n') + '\n';

// ---------------------------------------------------------------------------
// I) allowlist vazia: EXTINF=2 configured=15000 -> resultado=15000 (dinamica off)
// ---------------------------------------------------------------------------
{
    const empty = parseCanaryVideoIds('');
    assert.strictEqual(empty.size, 0, 'I: allowlist vazia deve gerar Set vazio');
    const ttl = resolveEffectivePlaylistTtl(CANARY_VIDEO, 15000, mediaExtinf2, empty);
    assert.strictEqual(ttl, 15000, 'I: allowlist vazia -> TTL deve ser configuredTtl');
    assert.strictEqual(isDynamicTtlCanaryVideo(CANARY_VIDEO, empty), false, 'I: canary false em allowlist vazia');
}

// ---------------------------------------------------------------------------
// J) videoId fora da allowlist: resultado=15000 (sem dinamica)
// ---------------------------------------------------------------------------
{
    const allowed = parseCanaryVideoIds(CANARY_VIDEO);
    assert.ok(allowed.has(CANARY_VIDEO), 'J: allowlist deve conter canary');
    assert.ok(!allowed.has(SBT_VIDEO), 'J: allowlist nao deve conter SBT');
    const ttlSbt = resolveEffectivePlaylistTtl(SBT_VIDEO, 15000, mediaExtinf2, allowed);
    assert.strictEqual(ttlSbt, 15000, 'J: videoId fora da allowlist -> configuredTtl');
    assert.strictEqual(isDynamicTtlCanaryVideo(SBT_VIDEO, allowed), false, 'J: canary false para fora');
}

// ---------------------------------------------------------------------------
// K) videoId dentro da allowlist: EXTINF=2 -> resultado=4000
// ---------------------------------------------------------------------------
{
    const allowed = parseCanaryVideoIds(CANARY_VIDEO);
    const ttlCanary = resolveEffectivePlaylistTtl(CANARY_VIDEO, 15000, mediaExtinf2, allowed);
    assert.strictEqual(ttlCanary, 4000, 'K: videoId na allowlist EXTINF=2 -> 4000');
    assert.strictEqual(isDynamicTtlCanaryVideo(CANARY_VIDEO, allowed), true, 'K: canary true para dentro');
}

// ---------------------------------------------------------------------------
// L) parsing robusto: espacos, vazios, separadores extras
// ---------------------------------------------------------------------------
{
    const parsed = parseCanaryVideoIds('_ePSDGh4YOw ,  , LLpNUqHVam8 ,  ,  ');
    assert.strictEqual(parsed.size, 2, 'L: deve resultar em 2 ids apos limpeza');
    assert.ok(parsed.has('_ePSDGh4YOw'), 'L: deve conter id com espaco');
    assert.ok(parsed.has('LLpNUqHVam8'), 'L: deve conter id apos espaco');
    // null/undefined/degenerate
    assert.strictEqual(parseCanaryVideoIds(null).size, 0, 'L: null -> vazio');
    assert.strictEqual(parseCanaryVideoIds(undefined).size, 0, 'L: undefined -> vazio');
    assert.strictEqual(parseCanaryVideoIds(', ,').size, 0, 'L: so separadores -> vazio');
    assert.strictEqual(parseCanaryVideoIds('   ').size, 0, 'L: so espacos -> vazio');
}

// ---------------------------------------------------------------------------
// M) duas qualidades da mesma live: chaves de cache distintas nao devem se misturar.
//    Confirma que cacheKey composto para variantes tem TTL independente e a
//    allowlist filtra corretamente pelo videoId canonico extraido da chave.
//    Eh apenas um teste logico das funcoes puras; o single-flight fisico fica
//    a cargo de fetchM3u8WithCache (que usa a chave composta como key do Map).
// ---------------------------------------------------------------------------
{
    const allowed = parseCanaryVideoIds(CANARY_VIDEO);
    // Simula chaves reais usadas em handleM3u8Proxy (variantes):
    //   cacheKey = videoId + '_' + urlMaxHeight
    //   variantCacheKey = cacheKey + '_' + upstreamHash
    const key720 = `${CANARY_VIDEO}_720_abc123`;
    const key480 = `${CANARY_VIDEO}_480_def456`;
    // Ambos devem estar na allowlist (mesmo videoId canonico)
    assert.strictEqual(isDynamicTtlCanaryVideo(key720, allowed), true, 'M: 720p canary');
    assert.strictEqual(isDynamicTtlCanaryVideo(key480, allowed), true, 'M: 480p canary');
    // TTLs independentes por chave/computed (mesmo valor aqui pois EXTINF igual)
    const t720 = resolveEffectivePlaylistTtl(key720, 15000, mediaExtinf2, allowed);
    const t480 = resolveEffectivePlaylistTtl(key480, 15000, mediaExtinf2, allowed);
    assert.strictEqual(t720, 4000, 'M: 720p TTL=4000');
    assert.strictEqual(t480, 4000, 'M: 480p TTL=4000');
    // Chaves de qualidade de live FORA da allowlist devem receber configuredTtl
    const keySbt720 = `${SBT_VIDEO}_720_xyz`;
    assert.strictEqual(
        resolveEffectivePlaylistTtl(keySbt720, 15000, mediaExtinf2, allowed),
        15000,
        'M: SBT 720p deve receber configuredTtl'
    );
    // Single-flight chamada: confirma que extractVideoIdFromCacheKey extrai o
    // videoId canonico independentemente da qualidade/hash anexados.
    assert.strictEqual(extractVideoIdFromCacheKey(key720), CANARY_VIDEO, 'M: extrai videoId de 720p');
    // Extra: videoId canonico puro (fallback) tambem e coberto por K.
}

// ---------------------------------------------------------------------------
// N) master playlist: comportamento explicito (TTL = configuredTtl)
//    Mesmo dentro da allowlist, master nao tem EXTINF/TARGETDURATION de media ->
//    computeDynamicPlaylistTtl retorna cfg -> effectiveTtl = configuredTtl.
// ---------------------------------------------------------------------------
{
    const allowed = parseCanaryVideoIds(CANARY_VIDEO);
    const ttlMasterCanary = resolveEffectivePlaylistTtl(CANARY_VIDEO, 15000, masterPlaylist, allowed);
    assert.strictEqual(ttlMasterCanary, 15000, 'N: master playlist -> configuredTtl (sem EXTINF)');
    assert.strictEqual(isDynamicTtlCanaryVideo(CANARY_VIDEO, allowed), true, 'N: ainda e canary, mas TTL nao reduz');
    // Master fora da allowlist: o mesmo (configuredTtl), por caminho diferente.
    const ttlMasterSbt = resolveEffectivePlaylistTtl(SBT_VIDEO, 15000, masterPlaylist, allowed);
    assert.strictEqual(ttlMasterSbt, 15000, 'N: master fora canary -> configuredTtl');
}

// ---------------------------------------------------------------------------
// O) configuredTtl invalido -> fallback 2000 (mesmo com allowlist)
// ---------------------------------------------------------------------------
{
    const allowed = parseCanaryVideoIds(CANARY_VIDEO);
    assert.strictEqual(resolveEffectivePlaylistTtl(CANARY_VIDEO, 0, mediaExtinf2, allowed), 2000, 'O: cfg=0 -> 2000');
    assert.strictEqual(resolveEffectivePlaylistTtl(CANARY_VIDEO, NaN, mediaExtinf2, allowed), 2000, 'O: cfg=NaN -> 2000');
    assert.strictEqual(resolveEffectivePlaylistTtl(CANARY_VIDEO, -5, mediaExtinf2, allowed), 2000, 'O: cfg<0 -> 2000');
}

console.log('OK dynamic-ttl.test.js: casos A-O (incluindo canary allowlist) passaram.');
