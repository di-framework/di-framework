#!/bin/sh
set -eu
file=${1:-}
if [ -z "$file" ]; then
  echo "usage: count-lines.sh <file>" >&2
  exit 2
fi
wc -l < "$file"
