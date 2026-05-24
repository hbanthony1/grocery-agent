import time
import base64
import os
import requests
from Crypto.Signature import pkcs1_15
from Crypto.Hash import SHA256
from Crypto.PublicKey import RSA
from dotenv import load_dotenv

load_dotenv()

SEARCH_URL = "https://developer.api.walmart.com/api-proxy/service/affil/product/v2/search"


def _auth_headers() -> dict:
    consumer_id = os.getenv("WALMART_CONSUMER_ID")
    key_path = os.getenv("WALMART_PRIVATE_KEY_PATH")
    key_version = os.getenv("WALMART_PRIVATE_KEY_VERSION", "1")
    timestamp = str(int(time.time() * 1000))
    message = f"{consumer_id}\n{timestamp}\n{key_version}\n"
    key = RSA.import_key(open(key_path).read())
    signature = base64.b64encode(
        pkcs1_15.new(key).sign(SHA256.new(message.encode()))
    ).decode()
    return {
        "WM_CONSUMER.ID": consumer_id,
        "WM_CONSUMER.INTIMESTAMP": timestamp,
        "WM_SEC.KEY_VERSION": key_version,
        "WM_SEC.AUTH_SIGNATURE": signature,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def search_product(query: str) -> dict | None:
    """Search Walmart for a product, return best match or None."""
    resp = requests.get(
        SEARCH_URL,
        params={"query": query, "numItems": 5},
        headers=_auth_headers(),
    )
    resp.raise_for_status()
    items = resp.json().get("items", [])
    # Prefer items that have a sale price (i.e. are actually available)
    for item in items:
        if item.get("salePrice") or item.get("msrp"):
            return item
    return items[0] if items else None


def build_cart_url(cart_items: list[dict], staple_items: list[str]) -> str:
    """
    cart_items: [{"itemId": "123", "quantity": 1}, ...]
    staple_items: ["itemId|qty", ...]
    """
    publisher_id = os.getenv("WALMART_PUBLISHER_ID", "")
    parts = [f"{item['itemId']}|{item['quantity']}" for item in cart_items]
    parts.extend(staple_items)
    params = []
    if parts:
        params.append("items=" + ",".join(parts))
    if publisher_id:
        params.append("affiliateId=" + publisher_id)
    return "https://affil.walmart.com/cart/addToCart?" + "&".join(params)
