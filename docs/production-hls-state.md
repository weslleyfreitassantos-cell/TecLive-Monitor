# Production HLS state

This document records the reproducible HLS defaults consolidated from the
production process on 2026-08-01. It contains no credentials, tokens, cookies,
or signed media URLs.

## Entrypoint

- Application: `app.js`
- Process manager: PM2, fork mode, one instance
- Bind: `127.0.0.1:3002`

## Required flags

The non-secret defaults are declared in `ecosystem.config.js`:

```text
PLAYBACK_DYNAMIC_LIVE_PLAYLIST_TTL=true
PLAYBACK_LIVE_TTL_FACTOR=0.5
PLAYBACK_LIVE_TTL_MIN_MS=500
PLAYBACK_LIVE_TTL_MAX_MS=3000
PLAYBACK_STUCK_SESSION_FIX=false
```

Dynamic TTL applies only to live media playlists. Master playlists, VOD, and
playlists containing `EXT-X-ENDLIST` retain the configured normal TTL.

## Active behavior

- Live media playlist cache is bounded by `TARGETDURATION * 0.5`, clamped to
  500-3000 ms and never above the configured cache TTL.
- Cache entries behind the monitor sequence are rejected.
- Cache is isolated by video, selected quality, and upstream identity in the
  variant path.
- Android/ExoMedia and VLC receive direct Googlevideo segment URLs by default.
- Session pins, continuity checks, stable playlist history, and player-specific
  live-edge margins remain enabled.
- Expired or missing playback sessions can be recovered without exposing a new
  session identifier in logs.

## Installed but disabled

`PLAYBACK_STUCK_SESSION_FIX` remains disabled. Its probe and repin code is kept
behind the feature flag for controlled testing only. Segment cache, prefetch,
and transient segment retry are also disabled by default.

## Validation matrix

`tests/live-playlist-cache-ttl.test.js` covers live target durations 1, 2, 5,
and 6 seconds, master playlists, `ENDLIST`, disabled behavior, and isolated
480p/720p cache entries. `tests/session-playlist-stuck-guard.test.js` verifies
that the anti-stuck guard is inert while disabled and only accepts a newer,
continuous playlist when enabled.

No implementation can guarantee every YouTube live stream. Deployments must
still validate representative short-window and normal-window streams on both
ExoMedia and VLC before promotion.
