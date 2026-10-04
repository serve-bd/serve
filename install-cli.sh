#!/bin/sh
# Installs the serve CLI.
#   curl -fsSL https://raw.githubusercontent.com/serve-bd/serve/main/install-cli.sh | sh
#
# Environment overrides:
#   SERVE_CLI_VERSION   release to install, like v0.3.2 (default: the newest release)
#   SERVE_CLI_DIR       folder to install into (default: /usr/local/bin when writable, else ~/.local/bin)
#   SERVE_CLI_BASE      where releases are downloaded from (default: the GitHub releases of serve-bd/serve)
set -eu

REPO="${SERVE_REPO:-serve-bd/serve}"
RELEASES="${SERVE_CLI_BASE:-https://github.com/$REPO/releases}"

info() { printf '  \033[34m→\033[0m %s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || fail "curl is required."
command -v tar >/dev/null || fail "tar is required."

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN*) fail "On Windows, download serve_<version>_windows_amd64.zip from $RELEASES/latest and put serve.exe in your PATH." ;;
  *) fail "There is no serve CLI build for $(uname -s)." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "There is no serve CLI build for $(uname -m) processors." ;;
esac

version="${SERVE_CLI_VERSION:-}"
if [ -z "$version" ]; then
  # The latest release page redirects to its tag; this needs no API token and has no rate limit.
  latest="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$RELEASES/latest")" || fail "Could not find the newest release."
  version="${latest##*/}"
  case "$version" in v*) ;; *) fail "Could not find the newest release (got $latest)." ;; esac
fi
case "$version" in v*) ;; *) version="v$version" ;; esac

name="serve_${version#v}_${os}_${arch}"
base="$RELEASES/download/$version"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

info "Downloading serve $version for $os/$arch"
curl -fsSL "$base/$name.tar.gz" -o "$tmp/$name.tar.gz" || fail "Could not download $base/$name.tar.gz. Does release $version have CLI builds?"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt" || fail "Could not download the checksums of $version."

want="$(grep " $name.tar.gz\$" "$tmp/checksums.txt" | cut -d' ' -f1)"
[ -n "$want" ] || fail "checksums.txt has no line for $name.tar.gz."
if command -v sha256sum >/dev/null; then
  got="$(sha256sum "$tmp/$name.tar.gz" | cut -d' ' -f1)"
elif command -v shasum >/dev/null; then
  got="$(shasum -a 256 "$tmp/$name.tar.gz" | cut -d' ' -f1)"
else
  fail "sha256sum or shasum is needed to check the download."
fi
[ "$want" = "$got" ] || fail "The download does not match its checksum. Try again."
ok "Checksum verified"

tar -xzf "$tmp/$name.tar.gz" -C "$tmp"

dir="${SERVE_CLI_DIR:-}"
if [ -z "$dir" ]; then
  if [ -w /usr/local/bin ]; then
    dir=/usr/local/bin
  else
    dir="$HOME/.local/bin"
  fi
fi
mkdir -p "$dir"
# Replace through a temporary name so a running serve is never half written.
cp "$tmp/$name/serve" "$dir/.serve.new"
chmod 755 "$dir/.serve.new"
mv -f "$dir/.serve.new" "$dir/serve"
ok "Installed $("$dir/serve" version --no-check 2>&1) to $dir/serve"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) warn "$dir is not in your PATH. Add it, for example: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile" ;;
esac
printf '\n  Next: serve login https://your-serve-dashboard\n'
