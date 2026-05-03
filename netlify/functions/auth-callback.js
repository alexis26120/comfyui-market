const { createClient } = require('@supabase/supabase-js');
const cookie = require('cookie');

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Simple in-memory lock for hot lambdas to prevent immediate double-execution
const exchangeInProgress = new Set();

exports.handler = async (event, context) => {
    const { code, state, error, error_description } = event.queryStringParameters;

    if (error) {
        console.error('OAuth Error from Provider:', error, error_description);
        if (error === 'access_denied' || error === 'consent_required') {
            return {
                statusCode: 302,
                headers: { Location: '/dashboard.html?error=session_expired' }
            };
        }
        return {
            statusCode: 400,
            body: `OAuth Error: ${error} - ${error_description || 'No description provided'}`
        };
    }

    if (!code) {
        return { statusCode: 400, body: 'Missing authorization code' };
    }

    // Lock check
    if (exchangeInProgress.has(code)) {
        console.warn('Duplicate request detected for code:', code);
        return { statusCode: 429, body: 'Request already in progress' };
    }
    exchangeInProgress.add(code);

    try {
        // Retrieve PKCE Verifier
        const cookies = cookie.parse(event.headers.cookie || '');
        const codeVerifier = cookies.fanvue_verifier;

        if (!codeVerifier) {
            console.error("Missing code_verifier cookie.");
            return { statusCode: 400, body: 'Missing secure session (verifier). Please try again.' };
        }

        const clientId = process.env.FANVUE_CLIENT_ID;
        const clientSecret = process.env.FANVUE_CLIENT_SECRET;
        const redirectUri = 'https://linkvault.fun/.netlify/functions/auth-callback';

        const params = new URLSearchParams();
        params.append('grant_type', 'authorization_code');
        params.append('code', code);
        params.append('redirect_uri', redirectUri);
        params.append('code_verifier', codeVerifier);

        // Basic Auth Header (Base64 of client_id:client_secret)
        const authHeader = Buffer.from(clientId + ':' + clientSecret).toString('base64');

        const tokenResponse = await fetch('https://auth.fanvue.com/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + authHeader
            },
            body: params,
        });

        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            console.error('Token exchange failed:', tokenResponse.status, errorText);

            // Handle Code Reuse gracefully
            const { data: existingToken } = await supabase
                .from('app_settings')
                .select('value')
                .eq('key', 'fanvue_access_token')
                .single();

            if (existingToken && existingToken.value) {
                console.log('Valid token exists. Redirecting.');
                return {
                    statusCode: 302,
                    headers: { Location: '/dashboard.html' },
                    multiValueHeaders: {
                        'Set-Cookie': [
                            'fanvue_verifier=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
                            'fanvue_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
                        ]
                    }
                };
            }

            return { statusCode: 502, body: `Token exchange failed: ${errorText}` };
        }

        const tokenData = await tokenResponse.json();
        const { access_token, refresh_token } = tokenData;

        // Store in Supabase
        const updates = [
            { key: 'fanvue_access_token', value: access_token },
            { key: 'fanvue_refresh_token', value: refresh_token || '' }
        ];

        const { error: dbError } = await supabase
            .from('app_settings')
            .upsert(updates, { onConflict: 'key' });

        if (dbError) {
            console.error('Supabase DB Error Details:', JSON.stringify(dbError));
            return { statusCode: 500, body: 'Failed to securely store tokens.' };
        }

        // Redirect back to dashboard
        return {
            statusCode: 302,
            headers: {
                Location: '/dashboard.html',
            },
            multiValueHeaders: {
                'Set-Cookie': [
                    'fanvue_verifier=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
                    'fanvue_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
                ]
            }
        };

    } catch (error) {
        console.error('Callback Fatal Error:', error);
        return { statusCode: 500, body: `Internal Server Error: ${error.message}` };
    } finally {
        exchangeInProgress.delete(code);
    }
};
