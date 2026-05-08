const crypto = require('crypto');

function base64URLEncode(str) {
    return str.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest();
}

exports.handler = async (event, context) => {
    const clientId = process.env.FANVUE_CLIENT_ID;
    const redirectUri = process.env.REDIRECT_URI || 'https://linkvault.fun/.netlify/functions/auth-callback';

    // 1. Generate PKCE Verifier & Challenge
    const verifier = base64URLEncode(crypto.randomBytes(32));
    const challenge = base64URLEncode(sha256(verifier));

    // 2. Generate Secure State
    const state = crypto.randomBytes(32).toString('hex');

    // 3. Define Scopes (valid Fanvue scopes per documentation)
    const scopes = 'openid read:self offline_access';

    // 4. Construct URL
    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('redirect_uri', redirectUri);
    params.append('response_type', 'code');
    params.append('scope', scopes);
    params.append('state', state);
    params.append('code_challenge', challenge);
    params.append('code_challenge_method', 'S256');

    const authUrl = `https://auth.fanvue.com/oauth2/auth?${params.toString()}`;

    console.log("Generated PKCE Auth URL:", authUrl);

    return {
        statusCode: 302,
        headers: {
            Location: authUrl
        },
        multiValueHeaders: {
            'Set-Cookie': [
                `fanvue_verifier=${verifier}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
                `fanvue_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`
            ]
        }
    };
};
