const validateUrlParam = (req, res, next) => {
    const url = req.query.url || req.body.url;
    
    if (!url) {
        return res.status(400).json({ error: 'URL da live é obrigatória' });
    }
    
    next();
};

module.exports = { validateUrlParam };