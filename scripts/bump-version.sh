#!/bin/bash

set -e

NEW_VERSION="$1"

if [ -z "$NEW_VERSION" ]; then
	echo "Usage: ./bump-version.sh <version>"
	echo "Example: ./bump-version.sh 1.0.1"
	exit 1
fi

if ! echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
	echo "Error: Version must be in semver format (X.Y.Z)"
	exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# JSON files to update
JSON_FILES=(
	"package.json"
	"src/manifest.chrome.json"
	"src/manifest.firefox.json"
	"dev/manifest.json"
)

echo "Bumping version to $NEW_VERSION"
echo ""

# Update JSON files
for file in "${JSON_FILES[@]}"; do
	filepath="$ROOT_DIR/$file"
	old_version=$(grep -o '"version": "[^"]*"' "$filepath" | head -1 | sed 's/"version": "//;s/"//')
	sed -i '' "s/\"version\": \"$old_version\"/\"version\": \"$NEW_VERSION\"/" "$filepath"
	echo "Updated $file: $old_version -> $NEW_VERSION"
done

echo ""
echo "Done!"
