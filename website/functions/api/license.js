// Cloudflare Pages Function: GET /api/license?txn=txn_...
// Verifies a completed Paddle transaction server-side, then signs a Pareno license.
// Secrets: PADDLE_API_KEY, PADDLE_LICENSE_PRIVATE_KEY (raw Ed25519 key, base64).
import * as ed from '@noble/ed25519';

const SANDBOX_API = 'https://sandbox-api.paddle.com';
const LIVE_API = 'https://api.paddle.com';
const DEFAULT_PRICE_ID = 'pri_01m7jk2d2exkz086jmg444j8nn';

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

function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const apiKey = typeof env?.PADDLE_API_KEY === 'string' ? env.PADDLE_API_KEY.trim() : '';
  const privateKeyText = typeof env?.PADDLE_LICENSE_PRIVATE_KEY === 'string'
    ? env.PADDLE_LICENSE_PRIVATE_KEY.trim()
    : '';
  if (!apiKey || !privateKeyText) {
    return json(503, { error: 'license_not_configured', message: 'License service is not configured yet.' });
  }

  const transactionId = new URL(request.url).searchParams.get('txn') || '';
  if (!/^txn_[a-z0-9]{20,40}$/.test(transactionId)) {
    return json(400, { error: 'invalid_transaction', message: 'Missing or invalid transaction id.' });
  }

  const apiBase = env?.PADDLE_ENV === 'live' ? LIVE_API : SANDBOX_API;
  const priceId = typeof env?.PADDLE_PRICE_ID === 'string' && env.PADDLE_PRICE_ID.startsWith('pri_')
    ? env.PADDLE_PRICE_ID.trim()
    : DEFAULT_PRICE_ID;

  try {
    const txnResponse = await fetch(`${apiBase}/transactions/${encodeURIComponent(transactionId)}`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Paddle-Version': '1' }
    });
    const txnBody = await txnResponse.json().catch(() => ({}));
    if (!txnResponse.ok) {
      return json(404, { error: 'transaction_not_found', message: 'Could not find this Paddle transaction.' });
    }

    const transaction = txnBody?.data;
    if (!transaction || transaction.status !== 'completed') {
      return json(409, { error: 'not_completed', message: 'This transaction has not completed yet.' });
    }

    const items = Array.isArray(transaction.items) ? transaction.items : [];
    const hasPrice = items.some(item =>
      item?.price_id === priceId ||
      item?.price?.id === priceId ||
      item?.price?.price_id === priceId
    );
    if (!hasPrice) {
      return json(403, { error: 'wrong_product', message: 'This transaction is not for Pareno Desktop Pro.' });
    }

    let email = transaction?.billing_details?.email || transaction?.customer?.email || '';
    if (!email && transaction.customer_id) {
      const customerResponse = await fetch(`${apiBase}/customers/${encodeURIComponent(transaction.customer_id)}`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Paddle-Version': '1' }
      });
      const customerBody = await customerResponse.json().catch(() => ({}));
      email = customerBody?.data?.email || '';
    }
    if (!email) {
      return json(422, { error: 'customer_email_missing', message: 'Paddle did not return a customer email.' });
    }

    let privateKey;
    try {
      privateKey = Uint8Array.from(atob(privateKeyText), c => c.charCodeAt(0));
    } catch {
      return json(503, { error: 'license_key_invalid', message: 'License signing key is invalid.' });
    }
    if (privateKey.length !== 32) {
      return json(503, { error: 'license_key_invalid', message: 'License signing key must be 32 bytes.' });
    }

    const payload = new TextEncoder().encode(JSON.stringify({
      email,
      product: 'pareno-desktop',
      issued: Date.now() / 1000
    }));
    const signature = await ed.signAsync(payload, privateKey);
    return json(200, {
      license: `${b64url(payload)}.${b64url(signature)}`,
      email
    });
  } catch (error) {
    return json(502, {
      error: 'paddle_unreachable',
      message: error instanceof Error ? error.message : 'Could not verify the transaction.'
    });
  }
}
