module.exports = {
  apps: [{
    name: 'youtube-monitor-v3',
    script: 'app.js',
    watch: false,
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3002,
      BIND_HOST: '127.0.0.1',
      TRUST_PROXY: 'loopback',
      PLAYBACK_DYNAMIC_LIVE_PLAYLIST_TTL: 'true',
      PLAYBACK_LIVE_TTL_FACTOR: '0.5',
      PLAYBACK_LIVE_TTL_MIN_MS: '500',
      PLAYBACK_LIVE_TTL_MAX_MS: '3000',
      PLAYBACK_STUCK_SESSION_FIX: 'false'
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/combined.log',
    time: true,
    max_memory_restart: '500M',
    restart_delay: 3000,
    kill_timeout: 5000
  }]
};
