#!/bin/bash
#
# Creates the self-signed code-signing identity the Agent is signed with.
#
# Why this exists: an ad-hoc signature (`codesign --sign -`) carries no
# certificate, so the only thing macOS can pin a TCC grant or a Keychain
# ACL to is the code directory hash:
#
#   designated => cdhash H"4ab780cb1f0e4f9311f0113ae7eebd90ecdba6de"
#
# That hash changes on every single build, which silently revokes
# Microphone, Speech Recognition, Accessibility and Reminders and locks
# the Agent out of its own pairing credential — a full re-grant and
# re-pair after every rebuild, with nothing in any log to explain it
# except a line in tccd's:
#
#   Failed to match existing code requirement for subject com.jarvis.agent
#
# Signing with a certificate instead makes the requirement "this bundle
# id, signed by this certificate":
#
#   designated => identifier "com.jarvis.agent" and certificate leaf = H"495b..."
#
# which every later build satisfies, so the grants stick.
#
# The certificate is self-signed and lives only in this user's login
# keychain. It is not distributable and not a substitute for a Developer
# ID signature if the Agent is ever shipped to another Mac.
#
# Idempotent — re-running it when the identity already exists is a no-op.

set -euo pipefail

IDENTITY_NAME="JARVIS Agent Code Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
VALID_DAYS=3650

# -v is deliberately omitted: it filters to identities whose trust chain
# validates, and a self-signed certificate's never will (see the note on
# trust settings at the bottom). The identity is perfectly usable anyway.
if security find-identity -p codesigning | grep -qF "$IDENTITY_NAME"; then
  echo "Signing identity \"$IDENTITY_NAME\" already exists — nothing to do."
  security find-identity -p codesigning | grep -F "$IDENTITY_NAME"
  exit 0
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# The codeSigning EKU is not optional: without it the certificate imports
# fine but `security find-identity -p codesigning` never lists it and
# codesign refuses to use it.
cat > "$workdir/openssl.cnf" <<'CONF'
[ req ]
distinguished_name = dn
prompt             = no
x509_extensions    = ext

[ dn ]
CN = JARVIS Agent Code Signing

[ ext ]
basicConstraints     = critical, CA:false
keyUsage             = critical, digitalSignature
extendedKeyUsage     = critical, codeSigning
subjectKeyIdentifier = hash
CONF

echo "Generating a ${VALID_DAYS}-day self-signed code-signing certificate..."
openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
  -days "$VALID_DAYS" \
  -config "$workdir/openssl.cnf" \
  -keyout "$workdir/key.pem" \
  -out "$workdir/cert.pem" 2>/dev/null

# OpenSSL 3's PKCS#12 defaults (AES/PBKDF2, SHA-256 MAC) are newer than
# what macOS's Security framework will open, and an empty password makes
# the failure actively misleading: `security import` reports "MAC
# verification failed during PKCS12 import (wrong password?)", which is
# not a password problem at all. Hence the explicit legacy algorithms and
# a throwaway password that never leaves this script.
p12_password="$(openssl rand -hex 16)"
openssl pkcs12 -export -legacy \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -inkey "$workdir/key.pem" \
  -in "$workdir/cert.pem" \
  -name "$IDENTITY_NAME" \
  -out "$workdir/identity.p12" \
  -passout "pass:$p12_password"

# -A lets any program on this Mac sign with this key without a keychain
# prompt. A prompt on every build would be the same friction as a
# re-grant on every build, just quieter.
echo "Importing into the login keychain..."
security import "$workdir/identity.p12" -k "$KEYCHAIN" -P "$p12_password" -A >/dev/null

echo
echo "Done. The private key now lives only in the login keychain."
security find-identity -p codesigning | grep -F "$IDENTITY_NAME"

cat <<'NOTE'

`security find-identity` will tag this one CSSMERR_TP_NOT_TRUSTED. That is
expected and harmless here: it means no trust chain leads to a root macOS
trusts, which is true of every self-signed certificate. codesign signs
with it regardless, and a designated requirement of the
`certificate leaf = H"..."` form is a hash comparison — it never walks a
chain, so TCC and the Keychain accept it. Marking it trusted
(`security add-trusted-cert -r trustRoot -p codeSign`) only changes what
Gatekeeper says about the binary, which does not apply to a locally built,
unquarantined executable, and it costs an admin password prompt.

To start over, delete both halves and re-run this script:

  security delete-identity -c "JARVIS Agent Code Signing"

Doing that invalidates the signature, so every permission has to be
granted once more — which is the cost this script exists to pay only once.
NOTE
