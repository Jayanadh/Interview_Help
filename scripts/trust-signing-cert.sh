#!/bin/bash
# Trusts the self-signed identity that make-signing-cert.sh created.
#
# make-signing-cert.sh ends with `security add-trusted-cert ... || true`, and
# that step needs an admin password it cannot ask for, so it fails silently.
# The identity then exists but reports CSSMERR_TP_NOT_TRUSTED, electron-builder
# skips signing, and the app falls back to ad-hoc — whose designated
# requirement is a raw cdhash. Every rebuild changes that hash, so macOS sees
# a brand-new app and forgets every permission you granted.
#
# Run this once, with sudo. Then `npm run build` signs properly and Screen
# Recording survives rebuilds.
set -e
NAME="Help Interview Self Signed"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if ! security find-certificate -c "$NAME" >/dev/null 2>&1; then
  echo "No certificate named \"$NAME\". Run: npm run cert" >&2
  exit 1
fi

security find-certificate -c "$NAME" -p > "$TMP/c.pem"

# -r trustRoot, NOT trustAsRoot. The certificate is its own issuer, and
# macOS rejects trustAsRoot on a self-signed cert with "parameters ... not
# valid" — which is the failure that made this step look like it worked.
#
# Try the login keychain first: it needs no sudo, and per-user trust is
# enough for codesign. Fall back to the System keychain if that is refused.
if security add-trusted-cert -r trustRoot -p codeSign \
     -k "$HOME/Library/Keychains/login.keychain-db" "$TMP/c.pem" 2>/dev/null; then
  echo "Trusted in your login keychain."
else
  echo "Login keychain refused it; trusting system-wide (needs your password)."
  sudo security add-trusted-cert -d -r trustRoot -p codeSign \
    -k /Library/Keychains/System.keychain "$TMP/c.pem"
fi

echo
if security find-identity -v -p codesigning | grep -q "$NAME"; then
  security find-identity -v -p codesigning | grep "$NAME"
  echo "→ valid. Rebuild with: npm run build"
else
  echo "Still not valid:" >&2
  security find-identity -p codesigning | grep "$NAME" >&2
  echo "Open Keychain Access, find \"$NAME\", and set" >&2
  echo "Trust → Code Signing to \"Always Trust\"." >&2
  exit 1
fi
