#!/usr/bin/env bash
# Install the FoundationDB client library (libfdb_c) that dfs-api links against on macOS.
# Client-only install from the official installer, as described in
# https://apple.github.io/foundationdb/getting-started-mac.html (the database itself runs in Docker).
#
# Usage: tools/install-fdb-client.sh [--check]
set -euo pipefail

FDB_VERSION=7.4.8
LIBRARY=/usr/local/lib/libfdb_c.dylib

# Linux installs the client from its own package (the dev container image does), so there is
# nothing to check or install here.
if [ "$(uname -s)" != "Darwin" ]; then
  [ "${1:-}" = "--check" ] && exit 0
  echo "This script only supports macOS. Install the FoundationDB clients package for your system:"
  echo "https://apple.github.io/foundationdb/downloads.html"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required to verify the FoundationDB client library version." >&2
  exit 1
fi

client_is_current() {
  [ -e "$LIBRARY" ] || return 1
  python3 - "$LIBRARY" "$FDB_VERSION" <<'PYTHON'
import ctypes
import sys

try:
    library = ctypes.CDLL(sys.argv[1])
except OSError:
    sys.exit(1)
library.fdb_get_client_version.restype = ctypes.c_char_p
version = library.fdb_get_client_version().decode().split(",")[0]
sys.exit(0 if version == sys.argv[2] else 1)
PYTHON
}

if client_is_current; then
  [ "${1:-}" = "--check" ] || echo "FoundationDB $FDB_VERSION client library already installed: $LIBRARY"
  exit 0
fi

if [ "${1:-}" = "--check" ]; then
  exit 1
fi

# Checksums are the ones GitHub publishes for the release assets.
case "$(uname -m)" in
  arm64)
    ARCH=arm64
    SHA256=22fd356d47ad8991b4688150809407a024dcc349cb5d6690e9f02cd98664a2eb
    ;;
  x86_64)
    ARCH=x86_64
    SHA256=392bb36930a4aa66c3329a3bceaff7a242575f532308a509babb2abec548d49a
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)"
    exit 1
    ;;
esac

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
PACKAGE="$WORK_DIR/FoundationDB-${FDB_VERSION}_${ARCH}.pkg"

echo "Downloading FoundationDB ${FDB_VERSION} (${ARCH})..."
curl -fsSL -o "$PACKAGE" \
  "https://github.com/apple/foundationdb/releases/download/${FDB_VERSION}/FoundationDB-${FDB_VERSION}_${ARCH}.pkg"

echo "${SHA256}  ${PACKAGE}" | shasum -a 256 -c - >/dev/null || {
  echo "Checksum mismatch for the downloaded package."
  exit 1
}

# The installer bundles the server and the clients; extract the clients component as its own package.
pkgutil --expand "$PACKAGE" "$WORK_DIR/expanded"
pkgutil --flatten "$WORK_DIR/expanded/FoundationDB-clients.pkg" "$WORK_DIR/clients.pkg"
echo "Installing the client library into /usr/local (asks for your password)..."
sudo installer -pkg "$WORK_DIR/clients.pkg" -target /

if ! client_is_current; then
  echo "Installation finished but $LIBRARY is not a usable FoundationDB $FDB_VERSION client."
  exit 1
fi
echo "Installed $LIBRARY"
