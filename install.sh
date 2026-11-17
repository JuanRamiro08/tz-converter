#!/usr/bin/env bash
# Dev install: symlink this working tree into the extensions directory, so
# editing here edits what GNOME loads. Same arrangement as ai-usagebar.
set -euo pipefail

UUID="tz-converter@juanramiro08.github.io"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

glib-compile-schemas --strict "$SRC/schemas"

if [[ -e "$DEST" && ! -L "$DEST" ]]; then
    echo "refusing to replace $DEST: it is a real directory, not a symlink" >&2
    exit 1
fi

ln -sfn "$SRC" "$DEST"
echo "linked $DEST -> $SRC"

gnome-extensions enable "$UUID" 2>/dev/null || \
    echo "enable it after the next login: gnome-extensions enable $UUID"

cat <<'MSG'

Extension JS is cached per session on Wayland, so a running Shell will not pick
up changes: log out and back in. To check that new code at least parses and
enables without logging out, run a throwaway headless Shell:

  dbus-run-session -- bash -c '
    gnome-shell --wayland --headless --virtual-monitor 1280x800 >/tmp/shell.log 2>&1 &
    sleep 24; gnome-extensions info tz-converter@juanramiro08.github.io; kill %1'

State: ACTIVE (not ERROR) means it loaded.
MSG
