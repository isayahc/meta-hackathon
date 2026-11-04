#!/bin/sh
set -eu
# Optional Compose secret. Existing env takes precedence; never print credentials.
if [ -n "${META_API_KEY_FILE:-}" ] && [ -z "${META_API_KEY:-}" ]; then
    META_API_KEY="$(cat "$META_API_KEY_FILE")"
    export META_API_KEY
fi
exec "$@"
