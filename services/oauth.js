const { google } = require('googleapis');
const db = require('../database/schema');

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

function getAuthUrl() {
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/youtube.readonly',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile'
        ],
        prompt: 'consent'
    });
}

async function getTokens(code) {
    const { tokens } = await oauth2Client.getToken(code);
    return tokens;
}

async function saveUserTokens(email, refreshToken) {
    return new Promise((resolve, reject) => {
        const sql = 'INSERT OR REPLACE INTO users (email, refresh_token) VALUES (?, ?)';
        db.run(sql, [email, refreshToken], (err) => {
            if (err) reject(err);
            resolve(true);
        });
    });
}

async function getUserRefreshToken(email) {
    return new Promise((resolve, reject) => {
        const sql = 'SELECT refresh_token FROM users WHERE email = ?';
        db.get(sql, [email], (err, row) => {
            if (err) reject(err);
            resolve(row ? row.refresh_token : null);
        });
    });
}

async function getAllUsers() {
    return new Promise((resolve, reject) => {
        const sql = 'SELECT id, email FROM users';
        db.all(sql, [], (err, rows) => {
            if (err) reject(err);
            resolve(rows);
        });
    });
}

module.exports = {
    oauth2Client,
    getAuthUrl,
    getTokens,
    saveUserTokens,
    getUserRefreshToken,
    getAllUsers
};