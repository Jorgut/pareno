# Paddle setup

## Sandbox IDs

- Product: `pro_01m7jjzcsmrk1pnymjg4mt9kek`
- Price: `pri_01m7jk2d2exkz086jmg444j8nn`
- Checkout: `https://pareno.altn.vision/api/checkout`
- License: `https://pareno.altn.vision/api/license?txn=txn_...`
- Thanks page: `https://pareno.altn.vision/thanks/`

## Required GitHub Actions secrets

- `PADDLE_API_KEY` — sandbox API key (`pdl_sdbx_...`)
- `PADDLE_LICENSE_PRIVATE_KEY` — raw Ed25519 private key, base64, not the PEM file
- `PADDLE_CLIENT_TOKEN` — sandbox client-side token (`test_...`), public by design

Create the private key secret locally without printing it:

```bash
openssl pkey -in ~/.pareno-license-private.pem -outform DER \
  | tail -c 32 | base64 | tr -d '\n' \
  | gh secret set PADDLE_LICENSE_PRIVATE_KEY
```

Do not commit the PEM or the raw key. The public key is embedded in
`desktop/Sources/ParenoDesktop/License.swift`.

## Paddle dashboard

- Catalog → Products → Pareno Desktop → Prices → `$19.99` one-time
- Set the default payment link to `https://pareno.altn.vision/checkout/`
- Approve `pareno.altn.vision` under website approval
- Add a webhook later at `https://pareno.altn.vision/api/paddle-webhook`

## Flow

1. Buyer clicks Buy Pro.
2. `/api/checkout` creates a Paddle transaction and returns `checkout.url`.
3. `/checkout/?_ptxn=txn_...` opens Paddle.js Checkout.
4. Buyer pays on Paddle and returns to `/thanks/?_ptxn=txn_...`.
5. `/api/license` verifies the transaction with Paddle and signs the license.
6. Buyer pastes the license into Pareno → Settings → Pareno Pro.
