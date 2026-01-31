const https = require('https');

const cache = new Map();
const cacheTime = (60 * 1000) * 10;

module.exports = function (steamID_64) {
    if (!steamID_64) {
        return Promise.resolve(null);
    }

    if (cache.has(steamID_64)) {
        const cached = cache.get(steamID_64);
        if (cached.time + cacheTime > Date.now()) {
            return Promise.resolve(cached.extract);
        } else {
            cache.delete(steamID_64);
        }
    }

    return new Promise((resolve) => {
        https.get('https://steamcommunity.com/profiles/' + steamID_64 + '/?xml=1', (res) => {
            let data = '';
        
            res.on('data', chunk => {
                data += chunk;
            });
        
            res.on('end', () => {
                const extract = (tag) => {
                    const start = data.indexOf(`<${tag}>`);
                    const end = data.indexOf(`</${tag}>`);
                    if (start === -1 || end === -1) return null;
                    return data.substring(start + tag.length + 2, end).replace("<![CDATA[", "").replace("]]>", "").trim();
                }

                cache.set(steamID_64, {extract, time: Date.now()});
                resolve(extract);
            });
        }).on('error', (err) => {
            console.error('Error:', err);
            resolve(null);
        });
    })
}