#!/bin/bash

# Create a temporary directory for the Zig repository
TEMP_DIR=$(mktemp -d)
ZIG_REPO="https://github.com/ziglang/zig.git"

echo "Cloning Zig repository..."
git clone --depth 1 $ZIG_REPO $TEMP_DIR

# Extract version from build.zig
VERSION_FILE="$TEMP_DIR/build.zig"
if [ -f "$VERSION_FILE" ]; then
    # Extract version using grep and sed
    ZIG_VERSION=$(grep -o 'const zig_version: std.SemanticVersion = .{ .major = [0-9]*, .minor = [0-9]*, .patch = [0-9]* }' "$VERSION_FILE" | sed -E 's/.*major = ([0-9]*), .minor = ([0-9]*), .patch = ([0-9]*).*/\1.\2.\3/')
    echo "Found Zig version: $ZIG_VERSION"
    
    # Create/update .dev.vars file
    echo "ZIG_VERSION=$ZIG_VERSION" > .dev.vars
    echo "Updated .dev.vars with ZIG_VERSION=$ZIG_VERSION"
else
    echo "Error: Could not find build.zig file"
    exit 1
fi

# Generate STD docs and langref
cd $TEMP_DIR
zig build std-docs langref
cd -

# Extract docs as json
ZIG_DOCS_DIR="$TEMP_DIR/zig-out/doc" node --experimental-transform-types ./extract-docs.ts
cp $TEMP_DIR/zig-out/doc/std/main.wasm ./
cp $TEMP_DIR/zig-out/doc/std/sources.tar ./data

# Clean up
rm -rf $TEMP_DIR
echo "Done!"
