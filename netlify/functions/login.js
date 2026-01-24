const cookie = require('cookie');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { password } = JSON.parse(event.body);
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (password === adminPassword) {
    // secure: true should be used in production with HTTPS
    const authCookie = cookie.serialize('auth_token', 'true', {
      httpOnly: true,
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 1 week
    });

    return {
      statusCode: 200,
      headers: {
        'Set-Cookie': authCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ success: true })
    };
  } else {
    return {
      statusCode: 401,
      body: JSON.stringify({ success: false, message: 'Invalid password' })
    };
  }
};
