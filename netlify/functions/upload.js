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

    // Helper to generate a random slug
    const generateSlug = () => {
        return Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 6);
    };

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
                // Use a cleaner path structure: uploads/{slug}/{filename}
                const slug = generateSlug();
                const fileExt = fileName.split('.').pop();
                // Sanitize filename
                const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
                const uniquePath = `${slug}/${safeFileName}`;

                const { data: uploadData, error: uploadError } = await supabase
                    .storage
                    .from('private_uploads')
                    .upload(uniquePath, fileBuffer, {
                        contentType: fileType,
                        upsert: false
                    });

                if (uploadError) {
                    console.error('Supabase Storage Error:', uploadError);
                    throw new Error('Storage upload failed: ' + uploadError.message);
                }

                if (!uploadData || !uploadData.path) {
                    console.error('Supabase Storage Error: Missing path in response', uploadData);
                    throw new Error('Storage upload succeeded but returned no path.');
                }

                const storagePath = uploadData.path;

                // 2. Insert into Supabase DB
                const publicPrice = parseFloat(fields.price || 0);

                const { data: dbData, error: dbError } = await supabase
                    .from('products')
                    .insert([
                        {
                            filename: storagePath, // Storing the path in storage
                            file_path: storagePath, // Required by DB schema
                            original_name: fileName,
                            price: publicPrice,
                            slug: slug,
                            description: 'Uploaded via Netlify',
                            is_paid: false
                        }
                    ])
                    .select()
                    .single();

                if (dbError) {
                    console.error('Supabase DB Error:', dbError);
                    throw new Error('Database insert failed: ' + dbError.message);
                }

                // 3. Generate the new simplified link
                // host header might include port in dev, which is fine.
                const protocol = event.headers['x-forwarded-proto'] || 'https';
                const host = event.headers.host;
                const shareLink = `${protocol}://${host}/l/${slug}`;

                resolve({
                    statusCode: 200,
                    body: JSON.stringify({
                        success: true,
                        link: shareLink,
                        slug: slug,
                        product: dbData
                    })
                });

            } catch (error) {
                console.error('Upload Handler Error:', error);
                resolve({
                    statusCode: 500,
                    body: JSON.stringify({ success: false, message: error.message || 'Internal Server Error' })
                });
            }
        });

        busboy.on('error', (error) => {
            console.error('Busboy Error:', error);
            resolve({ statusCode: 500, body: JSON.stringify({ success: false, message: 'Upload parsing failed' }) });
        });

        // Handle body parsing based on encoding
        if (event.isBase64Encoded) {
            busboy.write(Buffer.from(event.body, 'base64'));
        } else {
            busboy.write(event.body);
        }
        busboy.end();
    });
};
