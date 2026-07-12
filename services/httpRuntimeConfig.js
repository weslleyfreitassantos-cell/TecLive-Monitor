const net = require('net');

function resolveBindHost(env = process.env) {
    const configured = (env.BIND_HOST || env.HOST || '').trim();
    return configured || '127.0.0.1';
}

function isValidCidr(value) {
    const [address, maskText] = String(value || '').split('/');
    if (!address || maskText === undefined) return false;
    const ipVersion = net.isIP(address);
    if (!ipVersion) return false;
    if (!/^\d+$/.test(maskText)) return false;
    const mask = Number(maskText);
    const maxMask = ipVersion === 4 ? 32 : 128;
    return mask >= 0 && mask <= maxMask;
}

function isValidTrustProxyEntry(value) {
    return net.isIP(value) !== 0 || isValidCidr(value);
}

function parseTrustProxyConfig(rawValue) {
    const raw = String(rawValue ?? 'false').trim();
    if (!raw || raw.toLowerCase() === 'false') {
        return { value: false, label: 'false' };
    }

    if (raw.toLowerCase() === 'true') {
        throw new Error('TRUST_PROXY=true nao e permitido; use false, loopback, numero de hops ou lista de IPs/CIDRs.');
    }

    if (raw.toLowerCase() === 'loopback') {
        return { value: 'loopback', label: 'loopback' };
    }

    if (/^\d+$/.test(raw)) {
        const hops = Number(raw);
        if (!Number.isSafeInteger(hops) || hops < 1 || hops > 16) {
            throw new Error(`TRUST_PROXY invalido: ${raw}`);
        }
        return { value: hops, label: raw };
    }

    const entries = raw.split(',').map(item => item.trim()).filter(Boolean);
    if (entries.length > 0 && entries.every(isValidTrustProxyEntry)) {
        return { value: entries, label: entries.join(',') };
    }

    throw new Error(`TRUST_PROXY invalido: ${raw}`);
}

module.exports = {
    resolveBindHost,
    parseTrustProxyConfig,
    isValidCidr,
    isValidTrustProxyEntry
};
