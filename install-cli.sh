#!/bin/sh
# Installs the serve CLI.
#   curl -fsSL https://raw.githubusercontent.com/serve-bd/serve/main/install-cli.sh | sh
#
# The CLI has its own releases, tagged cli-v1.2.3, apart from Serve's own (v1.2.3). Serve's
# releases do not carry the CLI any more; older ones (up to v0.3.x) keep the archives they had.
# Once installed, `serve upgrade` updates it.
#
# Environment overrides:
#   SERVE_CLI_VERSION   version to install: v1.2.3, 1.2.3 or cli-v1.2.3 (default: the newest)
#   SERVE_CLI_DIR       folder to install into (default: /usr/local/bin when writable, else ~/.local/bin)
#   SERVE_CLI_BASE      where releases are downloaded from (default: the GitHub releases of serve-bd/serve)
#   SERVE_CLI_API       the GitHub API list of releases, to find the newest CLI
set -eu

REPO="${SERVE_REPO:-serve-bd/serve}"
RELEASES="${SERVE_CLI_BASE:-https://github.com/$REPO/releases}"
API="${SERVE_CLI_API:-https://api.github.com/repos/$REPO/releases?per_page=100}"

info() { printf '  \033[34m→\033[0m %s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || fail "curl is required."
command -v tar >/dev/null || fail "tar is required."

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN*) fail "On Windows, download serve_<version>_windows_amd64.zip from the newest \"Serve CLI\" release at $RELEASES and put serve.exe in your PATH." ;;
  *) fail "There is no serve CLI build for $(uname -s)." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "There is no serve CLI build for $(uname -m) processors." ;;
esac

# newest_cli prints the tag of the newest CLI release: the first cli-v* tag in GitHub's list
# (newest first) that is not a draft or a pre-release. No jq needed: the JSON is split at commas
# and read field by field (tag_name comes before draft and prerelease in each release).
newest_cli() {
  curl -fsSL -H 'Accept: application/vnd.github+json' "$API" | tr ',' '\n' | awk '
    /"tag_name": *"/ { tag = $0; sub(/.*"tag_name": *"/, "", tag); sub(/".*/, "", tag); draft = 0 }
    /"draft": *true/ { draft = 1 }
    /"prerelease": *false/ {
      if (!draft && tag ~ /^cli-v[0-9]+[.][0-9]+[.][0-9]+$/) { print tag; exit }
    }'
}

version="${SERVE_CLI_VERSION:-}"
if [ -z "$version" ]; then
  tag="$(newest_cli)" || fail "Could not read the list of releases at $API. Set SERVE_CLI_VERSION=v1.2.3 to skip this."
  [ -n "$tag" ] || fail "Found no serve CLI release (tags cli-v*) at $RELEASES."
  version="$tag"
fi
version="${version#cli-}"
version="v${version#v}"
case "$version" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "SERVE_CLI_VERSION should look like v1.2.3 (got ${SERVE_CLI_VERSION:-$version})." ;;
esac

name="serve_${version#v}_${os}_${arch}"
base="$RELEASES/download/cli-$version"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

info "Downloading serve $version for $os/$arch"
if ! curl -fsSL "$base/$name.tar.gz" -o "$tmp/$name.tar.gz" 2>/dev/null; then
  # Versions up to v0.3.x were attached to Serve's release of the same tag.
  old="$RELEASES/download/$version"
  curl -fsSL "$old/$name.tar.gz" -o "$tmp/$name.tar.gz" 2>/dev/null || fail "Could not download $base/$name.tar.gz. Is there a serve CLI $version?"
  base="$old"
fi
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
