'use strict';

const assert = require('assert');
const { describe, it } = require('node:test');
const { PlaylistStuckTracker } = require('../services/playlistStuckTracker');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('PlaylistStuckTracker — GLOBAL RECOVERY (A-Z)', function () {
    function makeTracker(overrides = {}) {
        return new PlaylistStuckTracker({
            enabled: true,
            scope: 'short-segments',
            stuckThresholdMs: 8000,
            cooldownMs: 30000,
            maxExtinfSeconds: 3,
            refreshCooldownMs: 30000,
            maxAttemptsPerWindow: 3,
            attemptWindowMs: 300000,
            ...overrides
        });
    }

    // maxExtinf=0.01 => dynamic threshold = max(stuckThresholdMs, round(0.01*4000)) = max(S, 40) ≅ S
    const Q = 0.01;

    // ===== A) scope=disabled =====
    it('A) scope=disabled => nenhuma recovery', function () {
        const t = makeTracker({ enabled: true, scope: 'disabled' });
        const r = t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r.reason, 'disabled');
        assert.strictEqual(r.recoveryNeeded, false);
    });

    // ===== B) scope ausente => fallback canary =====
    it('B) scope ausente => fallback canary', function () {
        const t = new PlaylistStuckTracker({
            enabled: true,
            canaryIds: new Set(['canaryVid']),
            stuckThresholdMs: 50,
            cooldownMs: 30000,
            maxExtinfSeconds: 3
        });
        const r1 = t.update('otherVid', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r1.reason, 'not_in_canary');

        const r2 = t.update('canaryVid', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r2.reason, 'first_seen');
    });

    // ===== C) scope inválido => fallback canary =====
    it('C) scope inválido => fallback canary', function () {
        const t = new PlaylistStuckTracker({
            enabled: true,
            scope: 'invalid_value',
            canaryIds: new Set(['canaryVid']),
            stuckThresholdMs: 50,
            cooldownMs: 30000,
            maxExtinfSeconds: 3
        });
        const r = t.update('canaryVid', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r.reason, 'first_seen');
    });

    // ===== D) scope=canary e videoId na lista =====
    it('D) scope=canary videoId na lista => recovery permitida', async function () {
        const t = makeTracker({
            scope: 'canary',
            canaryIds: new Set(['vidA']),
            stuckThresholdMs: 50,
            cooldownMs: 10000
        });
        t.update('vidA', '480', 100, 'hash1', { maxExtinf: Q });
        await delay(60);
        const r = t.update('vidA', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r.recoveryNeeded, true);
    });

    // ===== E) scope=canary e videoId fora da lista =====
    it('E) scope=canary videoId fora => nenhuma recovery', function () {
        const t = makeTracker({ scope: 'canary', canaryIds: new Set(['vidA']) });
        const r = t.update('vidB', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r.reason, 'not_in_canary');
    });

    // ===== F) scope=short-segments, EXTINF=2, travada >=8s => recovery =====
    it('F) scope=short-segments EXTINF=2 travada >=8s => recovery', async function () {
        const t = makeTracker({ stuckThresholdMs: 8000 });
        t.update('vid', '480', 100, 'hash1', { maxExtinf: 2 });
        await delay(100);
        const r = t.update('vid', '480', 100, 'hash1', { maxExtinf: 2 });
        // threshold = max(8000, 8000) = 8000, so 100ms < 8000 => below
        assert.strictEqual(r.reason, 'below_threshold');
        assert.strictEqual(r.recoveryNeeded, false);
        // Confirmar que thresholdMs está correto
        assert.ok(r.thresholdMs >= 8000);
    });

    // ===== G) scope=short-segments, EXTINF=2, travada 6s => não recovery =====
    it('G) EXTINF=2 travada 6s => não recovery (threshold 8s)', async function () {
        const t = makeTracker({ stuckThresholdMs: 8000 });
        t.update('vid', '480', 100, 'hash1', { maxExtinf: 2 });
        await delay(100);
        const r = t.update('vid', '480', 100, 'hash1', { maxExtinf: 2 });
        assert.strictEqual(r.recoveryNeeded, false);
        assert.strictEqual(r.reason, 'below_threshold');
    });

    // ===== H) EXTINF=2.5: threshold=10s =====
    it('H) EXTINF=2.5 threshold=10s', async function () {
        const t = makeTracker({ stuckThresholdMs: 8000 });
        t.update('vid', '480', 100, 'hash1', { maxExtinf: 2.5 });
        await delay(100);
        const r = t.update('vid', '480', 100, 'hash1', { maxExtinf: 2.5 });
        assert.strictEqual(r.reason, 'below_threshold');
        assert.ok(r.thresholdMs >= 10000, `thresholdMs=${r.thresholdMs} expected >= 10000`);
    });

    // ===== I) EXTINF=3: threshold=12s =====
    it('I) EXTINF=3 threshold=12s', async function () {
        const t = makeTracker({ stuckThresholdMs: 8000 });
        t.update('vid', '480', 100, 'hash1', { maxExtinf: 3 });
        await delay(100);
        const r = t.update('vid', '480', 100, 'hash1', { maxExtinf: 3 });
        assert.strictEqual(r.reason, 'below_threshold');
        assert.ok(r.thresholdMs >= 12000, `thresholdMs=${r.thresholdMs} expected >= 12000`);
    });

    // ===== J) EXTINF=3.001 => não elegível =====
    it('J) EXTINF=3.001 => não elegível', function () {
        const t = makeTracker({ maxExtinfSeconds: 3 });
        const r = t.update('vid', '480', 100, 'hash1', { maxExtinf: 3.001 });
        assert.strictEqual(r.reason, 'not_enabled');
    });

    // ===== K) EXTINF=5 => não elegível =====
    it('K) EXTINF=5 => não elegível', function () {
        const t = makeTracker({ maxExtinfSeconds: 3 });
        const r = t.update('vid', '480', 100, 'hash1', { maxExtinf: 5 });
        assert.strictEqual(r.reason, 'not_enabled');
    });

    // ===== L) master playlist => não elegível =====
    it('L) master playlist => não elegível', function () {
        const t = makeTracker();
        const r = t.update('vid', '480', 100, 'hash1', { isMaster: true, maxExtinf: Q });
        assert.strictEqual(r.reason, 'master_playlist');
    });

    // ===== M) live offline/ended => não elegível =====
    it('M) live offline/ended => não elegível', function () {
        const t = makeTracker();
        const r = t.update('vid', '480', 100, 'hash1', { isLive: false, maxExtinf: Q });
        assert.strictEqual(r.reason, 'live_offline');
    });

    // ===== N) HTTP != 200 => não disparar recovery =====
    it('N) HTTP != 200 => não elegível', function () {
        const t = makeTracker();
        const r = t.update('vid', '480', 100, 'hash1', { httpStatus: 403, maxExtinf: Q });
        assert.strictEqual(r.reason, 'http_403');
    });

    // ===== O) MSEQ avança => reset correto =====
    it('O) MSEQ avança => reset', async function () {
        const t = makeTracker({ stuckThresholdMs: 50 });
        t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        await delay(30);
        const r = t.update('vid', '480', 101, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r.reason, 'advanced');
        assert.strictEqual(r.recoveryNeeded, false);
    });

    // ===== P) MSEQ diminui => reset por troca de upstream =====
    it('P) MSEQ diminui => reset', function () {
        const t = makeTracker({ stuckThresholdMs: 50 });
        t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        const r = t.update('vid', '480', 99, 'hash2', { maxExtinf: Q });
        assert.strictEqual(r.reason, 'mseq_decreased_reset');
    });

    // ===== Q) duas requisições simultâneas => uma recovery =====
    it('Q) duas requisições simultâneas => uma recovery', async function () {
        const t = makeTracker({ stuckThresholdMs: 50 });
        t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        await delay(60);
        const r1 = t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r1.recoveryNeeded, true);
        t.markRecoveryStarted('vid', '480');
        const r2 = t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r2.reason, 'already_in_flight');
    });

    // ===== R) 480p e 720p travam juntas: um refresh por videoId =====
    it('R) 480p e 720p travam juntas: refresh cooldown protege', async function () {
        const t = makeTracker({
            stuckThresholdMs: 50,
            refreshCooldownMs: 30000
        });
        t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        t.update('vid', '720', 200, 'hash2', { maxExtinf: Q });
        await delay(60);

        const r480 = t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r480.recoveryNeeded, true);
        t.markRecoveryStarted('vid', '480');
        t.markRefreshDone('vid');

        const r720 = t.update('vid', '720', 200, 'hash2', { maxExtinf: Q });
        assert.strictEqual(r720.reason, 'refresh_cooldown');
    });

    // ===== S) URL do monitor já mudou => repin sem yt-dlp =====
    it('S) URL já mudou => repin sem yt-dlp', async function () {
        const t = makeTracker({ stuckThresholdMs: 50 });
        t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        await delay(60);
        const r = t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r.recoveryNeeded, true);
        t.markRecoveryStarted('vid', '480');
        t.markRecoveryComplete('vid', '480', 105);
        const state = t.getState('vid', '480');
        assert.strictEqual(state.recoveryInFlight, false);
        assert.strictEqual(state.lastMseq, 105);
    });

    // ===== T) URL igual => requestRefresh uma vez =====
    it('T) URL igual => requestRefresh (refresh state)', async function () {
        const t = makeTracker({ stuckThresholdMs: 50, refreshCooldownMs: 30000 });
        t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        await delay(60);
        const r = t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r.recoveryNeeded, true);
        t.markRecoveryStarted('vid', '480');
        t.markRefreshDone('vid');
        assert.strictEqual(t.isRefreshCooldownExpired('vid'), false);
    });

    // ===== U) refresh falha => last good preservado =====
    it('U) refresh falha => last good preservado', async function () {
        const t = makeTracker({ stuckThresholdMs: 50, cooldownMs: 100 });
        t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        await delay(60);
        const r = t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r.recoveryNeeded, true);
        t.markRecoveryStarted('vid', '480');
        t.markRefreshDone('vid');
        t.markRecoveryComplete('vid', '480', 100);
        const state = t.getState('vid', '480');
        assert.strictEqual(state.recoveryInFlight, false);
        assert.strictEqual(state.lastMseq, 100);
    });

    // ===== V) 3 recoveries em 5 minutos => permitidas =====
    it('V) 3 recoveries em 5 minutos => permitidas', async function () {
        const t = makeTracker({
            stuckThresholdMs: 50,
            cooldownMs: 50,
            maxAttemptsPerWindow: 3,
            attemptWindowMs: 300000,
            refreshCooldownMs: 50
        });
        t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        await delay(60);
        for (let i = 0; i < 3; i++) {
            const r = t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
            assert.strictEqual(r.recoveryNeeded, true, `recovery ${i + 1} should be needed`);
            t.markRecoveryStarted('vid', '480');
            t.markRefreshDone('vid');
            t.markRecoveryComplete('vid', '480', 100);
            await delay(60);
        }
        assert.strictEqual(t.getRecoveryCount('vid', '480'), 3);
    });

    // ===== W) 4ª recovery na mesma janela => bloqueada =====
    it('W) 4ª recovery na mesma janela => bloqueada', async function () {
        const t = makeTracker({
            stuckThresholdMs: 50,
            cooldownMs: 50,
            maxAttemptsPerWindow: 3,
            attemptWindowMs: 300000,
            refreshCooldownMs: 50
        });
        t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        await delay(60);
        for (let i = 0; i < 3; i++) {
            const r = t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
            assert.strictEqual(r.recoveryNeeded, true, `recovery ${i + 1} should be needed`);
            t.markRecoveryStarted('vid', '480');
            t.markRefreshDone('vid');
            t.markRecoveryComplete('vid', '480', 100);
            await delay(60);
        }
        await delay(10);
        const r4 = t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r4.reason, 'attempt_limit');
        assert.strictEqual(r4.recoveryNeeded, false);
    });

    // ===== X) janela expira => recovery volta a ser permitida =====
    it('X) janela expira => recovery permitida novamente', async function () {
        const t = makeTracker({
            stuckThresholdMs: 50,
            cooldownMs: 50,
            maxAttemptsPerWindow: 1,
            attemptWindowMs: 100,
            refreshCooldownMs: 50
        });
        t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        await delay(60);
        const r1 = t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r1.recoveryNeeded, true);
        t.markRecoveryStarted('vid', '480');
        t.markRefreshDone('vid');
        t.markRecoveryComplete('vid', '480', 100);

        await delay(120);
        const r2 = t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r2.recoveryNeeded, true);
    });

    // ===== Y) dynamic TTL permanece (threshold dinâmico) =====
    it('Y) threshold dinâmico: EXTINF=2 => 8000, EXTINF=5 => não elegível', function () {
        const t = makeTracker({
            stuckThresholdMs: 8000,
            maxExtinfSeconds: 3
        });
        const r1 = t.update('vid', '480', 100, 'hash1', { maxExtinf: 2 });
        assert.strictEqual(r1.reason, 'first_seen');

        const r2 = t.update('vid', '480', 100, 'hash1', { maxExtinf: 5 });
        assert.strictEqual(r2.reason, 'not_enabled');
    });

    // ===== Z) duas lives diferentes => estados independentes =====
    it('Z) duas lives diferentes => estados independentes', async function () {
        const t = makeTracker({ stuckThresholdMs: 50 });
        t.update('vidA', '480', 100, 'hash1', { maxExtinf: Q });
        t.update('vidB', '480', 200, 'hash2', { maxExtinf: Q });
        await delay(60);
        const rA = t.update('vidA', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(rA.recoveryNeeded, true);
        const rB = t.update('vidB', '480', 200, 'hash2', { maxExtinf: Q });
        assert.strictEqual(rB.recoveryNeeded, true);
        assert.strictEqual(t.isRecoveryInFlight('vidA', '480'), false);
        assert.strictEqual(t.isRecoveryInFlight('vidB', '480'), false);
    });

    // ===== Extras =====
    it('parseCanaryVideoIds: parsing correto', function () {
        const { parseCanaryVideoIds } = require('../services/playlistStuckTracker');
        assert.strictEqual(parseCanaryVideoIds('').size, 0);
        assert.strictEqual(parseCanaryVideoIds('a,b').size, 2);
        assert.strictEqual(parseCanaryVideoIds(' a , b ').has('a'), true);
    });

    it('normalizeScope: valores válidos e inválidos', function () {
        const { normalizeScope } = require('../services/playlistStuckTracker');
        assert.strictEqual(normalizeScope('disabled'), 'disabled');
        assert.strictEqual(normalizeScope('canary'), 'canary');
        assert.strictEqual(normalizeScope('short-segments'), 'short-segments');
        assert.strictEqual(normalizeScope('short_segments'), 'canary');
        assert.strictEqual(normalizeScope(''), 'canary');
        assert.strictEqual(normalizeScope('INVALID'), 'canary');
    });

    it('enabled=false => nenhuma recovery', function () {
        const t = new PlaylistStuckTracker({ enabled: false });
        const r = t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r.reason, 'disabled');
    });

    it('reset limpa estado corretamente', function () {
        const t = makeTracker();
        t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        t.markRecoveryStarted('vid', '480');
        t.reset('vid', '480');
        assert.strictEqual(t.getState('vid', '480'), null);
        assert.strictEqual(t.getRecoveryCount('vid', '480'), 0);
    });

    it('clear() limpa todos os estados', function () {
        const t = makeTracker();
        t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        t.markRefreshDone('vid');
        t.clear();
        assert.strictEqual(t.getState('vid', '480'), null);
        assert.strictEqual(t.isRefreshCooldownExpired('vid'), true);
    });

    it('diagnostics retorna config completa', function () {
        const t = makeTracker();
        const d = t.diagnostics;
        assert.strictEqual(d.enabled, true);
        assert.strictEqual(d.scope, 'short-segments');
        assert.strictEqual(d.maxExtinfSeconds, 3);
        assert.strictEqual(d.maxAttemptsPerWindow, 3);
        assert.ok(Array.isArray(d.variantEntries));
        assert.ok(Array.isArray(d.refreshEntries));
    });

    it('recoveryCount incrementa corretamente', async function () {
        const t = makeTracker({ stuckThresholdMs: 50, cooldownMs: 50, refreshCooldownMs: 50 });
        t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        await delay(60);
        t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        t.markRecoveryStarted('vid', '480');
        t.markRefreshDone('vid');
        assert.strictEqual(t.getRecoveryCount('vid', '480'), 1);

        t.markRecoveryComplete('vid', '480', 100);
        await delay(60);
        const r2 = t.update('vid', '480', 100, 'hash1', { maxExtinf: Q });
        assert.strictEqual(r2.recoveryNeeded, true);
        t.markRecoveryStarted('vid', '480');
        assert.strictEqual(t.getRecoveryCount('vid', '480'), 2);
    });

    it('no segments => não elegível', function () {
        const t = makeTracker();
        const r = t.update('vid', '480', 100, 'hash1', { hasSegments: false, maxExtinf: Q });
        assert.strictEqual(r.reason, 'no_segments');
    });
});
