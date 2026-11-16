// Cloudflare Pages Function: GET /api/checkout-config
// Returns the public Paddle client-side token. Never return the API key here.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS }
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ env }) {
  const token = typeof env?.PADDLE_CLIENT_TOKEN === 'string' ? env.PADDLE_CLIENT_TOKEN.trim() : '';
  if (!token) {
    return json(503, { error: 'checkout_not_configured', message: 'Paddle client token is not configured.' });
  }
  return json(200, {
    clientToken: token,
    environment: env?.PADDLE_ENV === 'live' ? 'production' : 'sandbox'
  });
}
