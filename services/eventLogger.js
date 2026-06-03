// services/eventLogger.js
const db = require('../database/schema');

async function logEvent(liveSourceId, eventType, message, metadata = null) {
    return new Promise((resolve) => {
        db.run(
            'INSERT INTO live_events (live_source_id, event_type, message, metadata) VALUES (?, ?, ?, ?)',
            [liveSourceId, eventType, message, metadata ? JSON.stringify(metadata) : null],
            (err) => {
                if (err) console.error('❌ Erro ao logar evento:', err.message);
                else console.log(`📝 Evento: ${eventType} - ${message}`);
                resolve();
            }
        );
    });
}

const EVENT_TYPES = {
    LIVE_CREATED: 'LIVE_CREATED',
    LIVE_REMOVED: 'LIVE_REMOVED',
    M3U8_CHANGED: 'M3U8_CHANGED',
    COOKIE_FAILED: 'COOKIE_FAILED',
    COOKIE_RECOVERED: 'COOKIE_RECOVERED',
    COOKIE_UPDATED: 'COOKIE_UPDATED',
    CLIENT_ADDED: 'CLIENT_ADDED',
    CLIENT_REMOVED: 'CLIENT_REMOVED'
};

module.exports = { logEvent, EVENT_TYPES };