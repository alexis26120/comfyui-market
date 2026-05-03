const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { productId } = JSON.parse(event.body);

        if (!productId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing productId' }) };
        }

        // SIMULATION: In a real app, we would create a Stripe Session here.
        // For now, we will just mark the item as "paid" directly to simulate the webhook callback.

        const { data, error } = await supabase
            .from('products')
            .update({ is_paid: true }) // Simulating instant payment
            .eq('id', productId)
            .select();

        if (error) {
            console.error('Supabase Update Error:', error);
            throw new Error('Failed to update payment status');
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: 'Payment simulated successfully'
            })
        };

    } catch (error) {
        console.error('Checkout Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal Server Error' })
        };
    }
};
