#!/usr/bin/env python3
"""Create a Pareno Desktop license key from the local private key."""
import argparse, base64, json, time
from pathlib import Path
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

p = argparse.ArgumentParser()
p.add_argument("--email", required=True)
p.add_argument("--private-key", default=str(Path.home() / ".pareno-license-private.pem"))
p.add_argument("--product", default="pareno-desktop")
a = p.parse_args()
key = serialization.load_pem_private_key(Path(a.private_key).read_bytes(), password=None)
payload = json.dumps({"email": a.email, "product": a.product, "issued": time.time()}, separators=(",", ":")).encode()
sig = key.sign(payload)
enc = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
print(f"{enc(payload)}.{enc(sig)}")
