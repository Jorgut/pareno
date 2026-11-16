// Cloudflare Pages Function: POST /api/checkout
// Creates a Paddle Billing transaction and returns its hosted checkout URL.
// Requires PADDLE_API_KEY in the Pages environment. Never expose that key to the browser.

const SANDBOX_API = 'https://sandbox-api.paddle.com';
const LIVE_API = 'https://api.paddle.com';
const DEFAULT_PRICE_ID = 'pri_01m7jk2d2exkz086jmg444j8nn';
const FALLBACK_URL = 'mailto:support@altn.vision?subject=Pareno%20Desktop%20Pro';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...CORS
    }
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ env }) {
  const apiKey = typeof env?.PADDLE_API_KEY === 'string' ? env.PADDLE_API_KEY.trim() : '';
  if (!apiKey) {
    return json(503, {
      error: 'checkout_not_configured',
      message: 'Paddle is not configured yet. Please email support@altn.vision.',
      fallback: FALLBACK_URL
    });
  }

  const priceId = typeof env?.PADDLE_PRICE_ID === 'string' && env.PADDLE_PRICE_ID.startsWith('pri_')
    ? env.PADDLE_PRICE_ID.trim()
    : DEFAULT_PRICE_ID;
  const apiBase = env?.PADDLE_ENV === 'live' ? LIVE_API : SANDBOX_API;

  try {
    const response = await fetch(`${apiBase}/transactions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Paddle-Version': '1'
      },
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        custom_data: { product: 'pareno-desktop', source: 'pareno-checkout' }
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return json(502, {
        error: 'paddle_checkout_failed',
        status: response.status,
        detail: data?.error?.detail || 'Paddle rejected the checkout request.',
        fallback: FALLBACK_URL
      });
    }

    const url = data?.data?.checkout?.url;
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      return json(502, {
        error: 'checkout_url_missing',
        detail: 'Paddle did not return a checkout URL. Check the default payment link and website approval.',
        fallback: FALLBACK_URL
      });
    }

    return json(200, { url });
  } catch (error) {
    return json(502, {
      error: 'paddle_unreachable',
      detail: error instanceof Error ? error.message : 'Could not reach Paddle.',
      fallback: FALLBACK_URL
    });
  }
}
