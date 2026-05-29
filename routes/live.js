const express = require('express');

const router = express.Router();

const NodeCache = require('node-cache');

const cache = new NodeCache({
    stdTTL: 1800
});

const { getM3U8 } = require('../services/youtube');

router.get('/', async (req, res) => {

    try {

        const youtubeUrl = req.query.url;

        if (!youtubeUrl) {

            return res.status(400).json({
                error: 'Envie a URL'
            });

        }

        const cached = cache.get(youtubeUrl);

        if (cached) {

            return res.json({
                status: 'cache',
                m3u8: cached
            });

        }

        const m3u8 = await getM3U8(youtubeUrl);

        cache.set(youtubeUrl, m3u8);

        res.json({
            status: 'updated',
            m3u8
        });

    } catch (err) {

        res.status(500).json({
            error: err.message
        });

    }

});

module.exports = router;