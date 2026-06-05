module.exports = {
    apps: [{
        name: 'youtube-live-monitor',
        script: 'app.js',
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '500M',
        env_production: {
            NODE_ENV: 'production',
            PORT: 3002
        },
        env_development: {
            NODE_ENV: 'development',
            PORT: 3002
        },
        error_file: 'logs/pm2-error.log',
        out_file: 'logs/pm2-out.log',
        log_file: 'logs/pm2-combined.log',
        time: true,
        ignore_watch: ['node_modules', 'logs', 'backups', 'database/users.db']
    }]
};