"""Fail a deployment if the intended Cloudflare Access application is absent."""
import json
import os
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def check_access_app(environ=None, opener=urlopen):
    keys = ("CF_ACCOUNT_ID", "CF_API_TOKEN", "ACCESS_APP_ID", "ACCESS_AUD", "ACCESS_TEAM_DOMAIN", "KMS_HOSTNAME")
    environ = os.environ if environ is None else environ
    values = {key: environ.get(key, "").strip() for key in keys}
    if any(not values[key] for key in keys):
        raise ValueError("Cloudflare account, Access app, hostname, or API token is missing")
    if not re.fullmatch(r"[0-9a-f]{32}", values["CF_ACCOUNT_ID"], re.I):
        raise ValueError("CF_ACCOUNT_ID must be a 32-character ID")
    if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32}", values["ACCESS_APP_ID"], re.I):
        raise ValueError("ACCESS_APP_ID must be a UUID")
    hostname = values["KMS_HOSTNAME"].lower()
    if not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", hostname) or hostname.endswith(".workers.dev"):
        raise ValueError("KMS_HOSTNAME must be a dedicated custom domain")
    if not re.fullmatch(r"https://[a-z0-9-]+\.cloudflareaccess\.com/?", values["ACCESS_TEAM_DOMAIN"], re.I):
        raise ValueError("ACCESS_TEAM_DOMAIN is invalid")
    url = ("https://api.cloudflare.com/client/v4/accounts/" + values["CF_ACCOUNT_ID"] +
           "/access/apps/" + values["ACCESS_APP_ID"])
    request = Request(url, headers={"Authorization": "Bearer " + values["CF_API_TOKEN"]})
    try:
        with opener(request, timeout=20) as response:
            envelope = json.load(response)
    except (HTTPError, URLError, TimeoutError):
        raise RuntimeError("Cloudflare Access application could not be verified") from None
    app = envelope.get("result") if isinstance(envelope, dict) and envelope.get("success") else None
    if not isinstance(app, dict) or app.get("type") != "self_hosted":
        raise ValueError("Cloudflare Access self-hosted application is missing")
    if app.get("aud") != values["ACCESS_AUD"] or app.get("domain", "").lower().rstrip("/") != hostname:
        raise ValueError("Cloudflare Access application hostname or audience does not match")
    return hostname


def main():
    print("Cloudflare Access application verified for " + check_access_app())


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError) as error:
        print("Access preflight failed: " + str(error), file=sys.stderr)
        sys.exit(1)
