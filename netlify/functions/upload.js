const { createClient } = require('@supabase/supabase-js');
const Busboy = require('busboy');

// Initialize Supabase (outside handler for cold start efficiency)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    return new Promise((resolve, reject) => {
        const busboy = Busboy({ headers: event.headers });
        const fields = {};
        let fileBuffer = null;
        let fileName = '';
        let fileType = '';

        busboy.on('field', (fieldname, val) => {
            fields[fieldname] = val;
        });

        busboy.on('file', (fieldname, file, { filename, mimeType }) => {
            fileName = filename;
            fileType = mimeType;

            const chunks = [];
            file.on('data', (data) => {
                chunks.push(data);
            });
            file.on('end', () => {
                fileBuffer = Buffer.concat(chunks);
            });
        });

        busboy.on('finish', async () => {
            try {
                if (!fileBuffer) {
                    resolve({ statusCode: 400, body: JSON.stringify({ success: false, message: 'No file uploaded' }) });
                    return;
                }

                // 1. Upload to Supabase Storage
                const fileExt = fileName.split('.').pop();
                const uniquePath = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}.${fileExt}`;

                const { data: uploadData, error: uploadError } = await supabase
                    .storage
                    .from('private_uploads')
                    .upload(uniquePath, fileBuffer, {
                        contentType: fileType,
                        upsert: false
                    });

                if (uploadError) throw uploadError;

                // 2. Insert into Supabase DB
                const { data: dbData, error: dbError } = await supabase
                    .from('products')
                    .insert([
                        {
                            filename: uniquePath,
                            original_name: fileName,
                            price: parseFloat(fields.price || 0),
                            file_path: uploadData.path,
                            description: 'Uploaded via Netlify'
                        }
                    ])
                    .select();

                if (dbError) throw dbError;

                // 3. Generate Link (Simulated Payment Link for now)
                const paymentLink = `https://${event.headers.host}/pay?id=${dbData[0].id}`;

                resolve({
                    statusCode: 200,
                    body: JSON.stringify({
                        success: true,
                        link: paymentLink,
                        product: dbData[0]
                    })
                });

            } catch (error) {
                console.error('Upload Error:', error);
                resolve({
                    statusCode: 500,
                    body: JSON.stringify({ success: false, message: error.message })
                });
            }
        });

        busboy.write(Buffer.from(event.body, 'base64'));
        busboy.end();
    });
};
