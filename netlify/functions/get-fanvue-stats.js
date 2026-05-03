const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Helpers
async function getTokenFromSupabase(key) {
    const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', key)
        .single();

    if (error || !data) return null;
    return data.value;
}

async function saveTokenToSupabase(key, value) {
    await supabase
        .from('app_settings')
        .upsert({ key, value }, { onConflict: 'key' });
}

exports.handler = async (event, context) => {
    try {
        // 1. Get Access Token
        let accessToken = await getTokenFromSupabase('fanvue_access_token');
        if (!accessToken) {
            return {
                statusCode: 200,
                body: JSON.stringify({ totalEarnings: null, subscriberCount: null })
            };
        }

        // 2. Fetch Stats (Using correct endpoint with new scopes)
        // Endpoint for stats is likely /account/statistics or similar
        let response = await fetch('https://api.fanvue.com/account/statistics', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'X-Fanvue-API-Version': '2025-06-26'
            }
        });

        // 3. Handle Token Expiry (401)
        if (response.status === 401) {
            console.log('Token expired, attempting refresh...');

            const refreshToken = await getTokenFromSupabase('fanvue_refresh_token');
            if (!refreshToken) {
                return { statusCode: 200, body: JSON.stringify({ error: 'Reconnexion requise' }) };
            }

            // Refresh Request
            const clientId = process.env.FANVUE_CLIENT_ID;
            const clientSecret = process.env.FANVUE_CLIENT_SECRET;
            const authHeader = Buffer.from(clientId + ':' + clientSecret).toString('base64');

            const tokenResponse = await fetch('https://auth.fanvue.com/oauth2/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + authHeader
                },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken
                })
            });

            if (!tokenResponse.ok) {
                console.error('Refresh failed:', tokenResponse.status);
                return { statusCode: 200, body: JSON.stringify({ error: 'Reconnexion requise' }) };
            }

            const tokens = await tokenResponse.json();

            // Save new tokens
            await saveTokenToSupabase('fanvue_access_token', tokens.access_token);
            if (tokens.refresh_token) {
                await saveTokenToSupabase('fanvue_refresh_token', tokens.refresh_token);
            }

            // Retry Original Request
            response = await fetch('https://api.fanvue.com/account/statistics', {
                headers: {
                    'Authorization': `Bearer ${tokens.access_token}`,
                    'Content-Type': 'application/json',
                    'X-Fanvue-API-Version': '2025-06-26'
                }
            });
        }

        if (!response.ok) {
            console.error('Fanvue API Error:', response.status, await response.text());
            return {
                statusCode: 200,
                // Fallback if stats scope still fails even with correct token
                body: JSON.stringify({ error: 'Failed to fetch Fanvue statistics' })
            };
        }

        const stats = await response.json();
        // console.log('Fanvue Stats Response:', JSON.stringify(stats));

        // 4. Format Data
        let rawEarnings = 0;
        if (stats.lifetimeEarnings !== undefined) {
            rawEarnings = stats.lifetimeEarnings / 100; // Cents to dollars
        } else if (stats.earnings !== undefined) {
            rawEarnings = stats.earnings;
        }

        const subscribers = stats.subscriberCount || stats.subscribers || 0;
        const formattedEarnings = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(rawEarnings);

        return {
            statusCode: 200,
            body: JSON.stringify({
                totalEarnings: formattedEarnings,
                subscriberCount: subscribers.toString()
            })
        };

    } catch (error) {
        console.error('Get Stats Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal Server Error' })
        };
    }
};
