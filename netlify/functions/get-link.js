const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { slug } = event.queryStringParameters;

    if (!slug) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing slug' }) };
    }

    try {
        const { data, error } = await supabase
            .from('products')
            .select('id, filename, original_name, price, description, is_paid')
            .eq('slug', slug)
            .single();

        if (error || !data) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Product not found' }) };
        }

        // If paid, we might return a download link (signed URL)
        let downloadUrl = null;
        if (data.is_paid) {
            const { data: signedData, error: signedError } = await supabase
                .storage
                .from('private_uploads')
                .createSignedUrl(data.filename, 3600); // 1 hour expiry

            if (!signedError) {
                downloadUrl = signedData.signedUrl;
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                product: {
                    id: data.id,
                    name: data.original_name,
                    price: data.price,
                    description: data.description,
                    is_paid: data.is_paid,
                    download_url: downloadUrl // Only present if paid
                }
            })
        };

    } catch (error) {
        console.error('Get Link Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal Server Error' })
        };
    }
};
