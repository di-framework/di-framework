#!/usr/bin/env bash
# Assemble a GitHub Pages tree:
#   /           current Writerside build (stable topic URLs)
#   /latest/    same snapshot
#   /vX.Y/      frozen minor snapshots from GitHub Release assets (docs-vX.Y.zip)
#   versions.json  Writerside version switcher manifest
set -euo pipefail

BUILD_DIR="${1:?usage: assemble-docs-site.sh <writerside-output-dir> <site-out-dir>}"
SITE_DIR="${2:?usage: assemble-docs-site.sh <writerside-output-dir> <site-out-dir>}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
REF_TYPE="${GITHUB_REF_TYPE:-}"
REF_NAME="${GITHUB_REF_NAME:-}"
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"

if [[ ! -d "$BUILD_DIR" ]]; then
  echo "Build dir not found: $BUILD_DIR" >&2
  exit 1
fi

rm -rf "$SITE_DIR"
mkdir -p "$SITE_DIR"

copy_build() {
  mkdir -p "$1"
  cp -R "$BUILD_DIR"/. "$1/"
}

if [[ -n "$TOKEN" ]]; then
  echo "Fetching docs-v*.zip assets from GitHub Releases…"
  tmp="$(mktemp -d)"
  python3 - "$REPO" "$TOKEN" "$tmp" <<'PY'
import json, os, sys, urllib.request

repo, token, dest = sys.argv[1], sys.argv[2], sys.argv[3]
headers = {
    "Authorization": f"Bearer {token}",
    "Accept": "application/vnd.github+json",
    "User-Agent": "di-framework-docs-assemble",
    "X-GitHub-Api-Version": "2022-11-28",
}
page = 1
seen: set[str] = set()
while True:
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/releases?per_page=100&page={page}",
        headers=headers,
    )
    with urllib.request.urlopen(req) as resp:
        releases = json.load(resp)
    if not releases:
        break
    for rel in releases:
        for asset in rel.get("assets") or []:
            name = asset.get("name") or ""
            if not (name.startswith("docs-v") and name.endswith(".zip")) or name in seen:
                continue
            seen.add(name)
            print(f"  downloading {name} from {rel.get('tag_name')}")
            dl = urllib.request.Request(
                asset["url"],
                headers={
                    **headers,
                    "Accept": "application/octet-stream",
                },
            )
            out = os.path.join(dest, name)
            with urllib.request.urlopen(dl) as resp, open(out, "wb") as f:
                f.write(resp.read())
    if len(releases) < 100:
        break
    page += 1
if not seen:
    print("  no docs-v*.zip assets found")
PY
  shopt -s nullglob
  for zip in "$tmp"/docs-v*.zip; do
    ver="$(basename "$zip" .zip)"
    ver="${ver#docs-}"
    echo "  extracting $zip → ${SITE_DIR}/${ver}"
    mkdir -p "${SITE_DIR}/${ver}"
    unzip -O UTF-8 -qq "$zip" -d "${SITE_DIR}/${ver}"
  done
  shopt -u nullglob
  rm -rf "$tmp"
else
  echo "No GITHUB_TOKEN; skipping historical snapshot download"
fi

echo "Copying current build to / and /latest/"
copy_build "$SITE_DIR"
copy_build "$SITE_DIR/latest"

if [[ "$REF_TYPE" == "tag" && "$REF_NAME" =~ ^v([0-9]+)\.([0-9]+) ]]; then
  MINOR="v${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
  echo "Tag $REF_NAME → snapshot $MINOR"
  copy_build "$SITE_DIR/$MINOR"
  SNAPSHOT_ZIP="${WORKSPACE}/docs-${MINOR}.zip"
  rm -f "$SNAPSHOT_ZIP"
  (cd "$BUILD_DIR" && zip -qr "$SNAPSHOT_ZIP" .)
  echo "Wrote $SNAPSHOT_ZIP"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "snapshot_zip=$SNAPSHOT_ZIP" >> "$GITHUB_OUTPUT"
    echo "snapshot_version=$MINOR" >> "$GITHUB_OUTPUT"
  fi
fi

# Writerside only renders the version dropdown when versions.json has 2+
# entries. Until docs-v*.zip release assets exist, seed the current package
# minor so the picker appears. Prefer a frozen zip when one was restored.
PKG_JSON="${WORKSPACE}/package.json"
if [[ -f "$PKG_JSON" ]]; then
  CURRENT_MINOR="$(
    python3 - "$PKG_JSON" <<'PY'
import json, sys
v = json.load(open(sys.argv[1])).get("version", "")
parts = v.split(".")
if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
    print(f"v{parts[0]}.{parts[1]}")
PY
  )"
  if [[ -n "$CURRENT_MINOR" && ! -d "${SITE_DIR}/${CURRENT_MINOR}" ]]; then
    echo "Seeding current minor snapshot ${CURRENT_MINOR} (no release asset yet)"
    copy_build "${SITE_DIR}/${CURRENT_MINOR}"
  fi
fi

SEARCH_ENDPOINT="${SEARCH_ENDPOINT:-https://di-framework-docs-search.seemueller.workers.dev/api/docs/search}"
SEARCH_ENDPOINT="${SEARCH_ENDPOINT%/}"

# Writerside frontend skips fetching versionsService unless productId is set.
PRODUCT_ID="${PRODUCT_ID:-d}"

python3 - "$SITE_DIR" "$SEARCH_ENDPOINT" "$PRODUCT_ID" <<'PY'
import json, sys
from pathlib import Path

site = Path(sys.argv[1])
endpoint = sys.argv[2].rstrip("/")
product_id = sys.argv[3]
entries = [{"version": "latest", "url": "/", "isCurrent": True}]

def sort_key(v: str):
    parts = v.lstrip("v").split(".")
    return tuple(int(x) if x.isdigit() else 0 for x in parts)

minors = sorted(
    (
        p.name
        for p in site.iterdir()
        if p.is_dir() and p.name.startswith("v") and p.name[1:2].isdigit()
    ),
    key=sort_key,
    reverse=True,
)
for ver in minors:
    entries.append({"version": ver, "url": f"/{ver}/", "isCurrent": False})
(site / "versions.json").write_text(json.dumps(entries, indent=2) + "\n")
print("versions.json:", json.dumps(entries, indent=2))

def patch_config(config_path: Path, version: str) -> None:
    if not config_path.is_file():
        return
    cfg = json.loads(config_path.read_text())
    cfg["productId"] = product_id
    cfg["searchService"] = "custom"
    cfg["searchServiceUrl"] = f"{endpoint}/preview-search/Writerside/d/{version}"
    config_path.write_text(json.dumps(cfg, separators=(",", ":")))
    print(f"config {config_path}: productId={product_id} version={version}")

patch_config(site / "config.json", "latest")
patch_config(site / "latest" / "config.json", "latest")
for ver in minors:
    patch_config(site / ver / "config.json", ver)
PY
