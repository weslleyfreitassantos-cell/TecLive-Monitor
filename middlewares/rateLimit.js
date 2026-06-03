const rateLimit = require('express-rate-limit');

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Muitas requisições. Tente novamente mais tarde.' }
});

const strictLimiter = rateLimit({
    windowMs: 60000,
    max: 10,
    message: { error: 'Limite de requisições excedido.' }
});

module.exports = { globalLimiter, strictLimiter };