const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const FANVUE_API = 'https://api.fanvue.com';
const FANVUE_HEADERS = { 'X-Fanvue-API-Version': '2025-06-26', 'Content-Type': 'application/json' };

async function getToken(key) {
    const { data } = await supabase.from('app_settings').select('value').eq('key', key).single();
    return data?.value || null;
}

async function saveToken(key, value) {
    await supabase.from('app_settings').upsert({ key, value }, { onConflict: 'key' });
}

async function fanvueGet(path, token) {
    return fetch(`${FANVUE_API}${path}`, {
        headers: { ...FANVUE_HEADERS, 'Authorization': `Bearer ${token}` }
    });
}

async function refreshToken() {
    const refreshToken = await getToken('fanvue_refresh_token');
    if (!refreshToken) return null;

    const authHeader = Buffer.from(`${process.env.FANVUE_CLIENT_ID}:${process.env.FANVUE_CLIENT_SECRET}`).toString('base64');
    const res = await fetch('https://auth.fanvue.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${authHeader}` },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
    });

    if (!res.ok) return null;
    const tokens = await res.json();
    await saveToken('fanvue_access_token', tokens.access_token);
    if (tokens.refresh_token) await saveToken('fanvue_refresh_token', tokens.refresh_token);
    return tokens.access_token;
}

// Paginate through all earnings records (max 500 to stay safe)
async function fetchAllEarnings(token) {
    const all = [];
    let cursor = null;
    do {
        const url = `/insights/earnings?limit=50${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await fanvueGet(url, token);
        if (!res.ok) break;
        const data = await res.json();
        const records = data.data || data.earnings || [];
        all.push(...records);
        cursor = data.pagination?.nextCursor || data.meta?.nextCursor || null;
    } while (cursor && all.length < 500);
    return all;
}

// Map Fanvue earning type to dashboard label
function mapType(type) {
    const map = {
        subscription: 'Acces workflow',
        subscription_renewal: 'Renouvellement',
        renewal: 'Renouvellement',
        rebill: 'Renouvellement',
        purchase: 'Achat fichier',
        tip: 'Pourboire',
        message_tip: 'Pourboire',
        post_tip: 'Pourboire',
    };
    return map[(type || '').toLowerCase()] || type || 'Autre';
}

// Extract fan username from various possible shapes
function fanName(earning) {
    return earning.fan?.username
        || earning.fan?.displayName
        || earning.fan?.name
        || earning.fanUsername
        || earning.username
        || 'anonymous_user';
}

// Extract net amount in dollars from various possible shapes (Fanvue uses cents)
function netAmount(earning) {
    const raw = earning.netAmount ?? earning.net_amount ?? earning.amount ?? 0;
    return Math.round((raw / 100) * 100) / 100;
}

// Extract ISO date string (YYYY-MM-DD)
function earningDate(earning) {
    const iso = earning.createdAt || earning.created_at || earning.date || '';
    return iso.split('T')[0];
}

exports.handler = async (event, context) => {
    try {
        let token = await getToken('fanvue_access_token');
        if (!token) {
            return { statusCode: 200, body: JSON.stringify({ connected: false }) };
        }

        // Probe with a simple request; refresh on 401
        let probe = await fanvueGet('/insights/earnings?limit=1', token);
        if (probe.status === 401) {
            token = await refreshToken();
            if (!token) return { statusCode: 200, body: JSON.stringify({ connected: false, reason: 'token_expired' }) };
            probe = await fanvueGet('/insights/earnings?limit=1', token);
        }

        if (!probe.ok) {
            const body = await probe.text();
            console.error('Fanvue /insights/earnings error:', probe.status, body);
            return { statusCode: 200, body: JSON.stringify({ connected: true, error: `api_${probe.status}`, raw: body }) };
        }

        // Fetch all earnings
        const earnings = await fetchAllEarnings(token);

        // Fetch top spenders (best-effort, non-blocking)
        let topSpendersRaw = [];
        try {
            const tsRes = await fanvueGet('/insights/fans/top-spenders?limit=10', token);
            if (tsRes.ok) {
                const tsData = await tsRes.json();
                topSpendersRaw = tsData.data || tsData.fans || [];
            }
        } catch (_) {}

        // Build transaction list
        const now = new Date();
        let totalRevenue = 0;
        let monthlyRevenue = 0;

        const transactions = earnings.map(e => {
            const amount = netAmount(e);
            const date = earningDate(e);
            totalRevenue += amount;
            if (date) {
                const d = new Date(date);
                if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
                    monthlyRevenue += amount;
                }
            }
            return { buyer: fanName(e), type: mapType(e.type || e.earningType), amount, date };
        }).sort((a, b) => b.date.localeCompare(a.date));

        // Recent transactions (5 most recent)
        const recentTx = transactions.slice(0, 5).map(t => {
            const daysAgo = Math.floor((now - new Date(t.date)) / 86400000);
            return { buyer: t.buyer, amount: t.amount, daysAgo: Math.max(0, daysAgo) };
        });

        // Top buyers — from API or computed from transactions
        let topBuyers;
        if (topSpendersRaw.length > 0) {
            topBuyers = topSpendersRaw.slice(0, 5).map(s => ({
                name: s.fan?.username || s.fan?.displayName || s.username || 'anonymous_user',
                total: Math.round(((s.totalSpend ?? s.grossAmount ?? s.amount ?? 0) / 100) * 100) / 100
            }));
        } else {
            const buyerMap = {};
            transactions.forEach(t => { buyerMap[t.buyer] = (buyerMap[t.buyer] || 0) + t.amount; });
            topBuyers = Object.entries(buyerMap)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([name, total]) => ({ name, total: Math.round(total * 100) / 100 }));
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                connected: true,
                transactions,
                recentTx,
                topBuyers,
                totalSales: transactions.length,
                totalRevenue: Math.round(totalRevenue * 100) / 100,
                monthlyRevenue: Math.round(monthlyRevenue * 100) / 100
            })
        };

    } catch (err) {
        console.error('get-fanvue-data fatal:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'internal' }) };
    }
};
