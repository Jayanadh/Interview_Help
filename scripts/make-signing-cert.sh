#!/bin/bash
# Creates a stable self-signed code-signing identity.
#
# Without this, electron-builder ad-hoc signs, and the app's designated
# requirement is a raw cdhash of the binary. Every rebuild changes that hash,
# so macOS treats each build as a brand-new app and every permission you
# granted is forgotten. With a certificate, identity is tied to the cert
# instead, and permissions persist across rebuilds.
set -e
NAME="Help Interview Self Signed"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$NAME"; then
  echo "Identity already exists: $NAME"
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/cert.conf" <<CONF
[req]
distinguished_name = dn
x509_extensions    = v3
prompt             = no
[dn]
CN = $NAME
[v3]
basicConstraints     = critical,CA:false
keyUsage             = critical,digitalSignature
extendedKeyUsage     = critical,codeSigning
CONF

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$TMP/k.pem" -out "$TMP/c.pem" -config "$TMP/cert.conf" 2>/dev/null

# OpenSSL 3 defaults (AES-256-CBC + SHA-256 MAC) cannot be read by Apple's
# Security framework. Force the legacy PKCS12 algorithms it understands, and
# use a real password — an empty one also trips the importer.
P12PASS="helpinterview"
openssl pkcs12 -export -out "$TMP/i.p12" \
  -inkey "$TMP/k.pem" -in "$TMP/c.pem" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -passout "pass:$P12PASS" 2>/dev/null

security import "$TMP/i.p12" -k "$KEYCHAIN" -P "$P12PASS" \
  -T /usr/bin/codesign -T /usr/bin/security -A >/dev/null

# Mark the cert as trusted for code signing.
#
# -r trustRoot, NOT trustAsRoot: this certificate is its own issuer, and
# macOS rejects trustAsRoot on a self-signed cert with the unhelpful
# "SecTrustSettingsSetTrustSettings: One or more parameters ... not valid".
#
# This needs an admin password, which a postinstall hook cannot ask for, so
# it is allowed to fail — run `npm run cert:trust` to finish the job.
security add-trusted-cert -r trustRoot -p codeSign \
  -k "$KEYCHAIN" "$TMP/c.pem" 2>/dev/null \
  || echo "Could not set trust automatically — run: npm run cert:trust" 

echo "Created identity: $NAME"
security find-identity -v -p codesigning | grep "$NAME" || true
