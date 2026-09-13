#!/usr/bin/env bash

## This script is largely useless, because there's not much we can do about AppImage size

ARCH=$(uname -m)

# build tauri apps
# NO_STRIP=true pnpm tauri build -- --verbose

# unpack appimage
APPIMAGE=$(ls ./src-tauri/target/release/bundle/appimage/*.AppImage)
"$APPIMAGE" --appimage-extract

# strip binary
APPIMAGE_UNPACK="./squashfs-root"
find "$APPIMAGE_UNPACK" -type f -exec strip -s {} \;

APPIMAGETOOL="obsolete-appimagetool-$ARCH.AppImage"
curl -fsSL --proto '=https' --tlsv1.2 --max-redirs 5 -o "$APPIMAGETOOL" "https://github.com/AppImage/AppImageKit/releases/download/13/$APPIMAGETOOL"
chmod +x "$APPIMAGETOOL"

APPIMAGE_OUTPUT=$(./"$APPIMAGETOOL" "$APPIMAGE_UNPACK" | grep ".AppImage" | grep squashfs-root | awk '{ print $6 }')

mv "$APPIMAGE_OUTPUT" "$APPIMAGE"
