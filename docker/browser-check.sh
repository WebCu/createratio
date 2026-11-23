#!/bin/sh
set -eu

work_dir=${BROWSER_CHECK_WORK:-/work}
deps_dir=${BROWSER_CHECK_DEPS:-/opt/createratio/deps}
pins_file=${BROWSER_CHECK_PINS:-/opt/createratio/bin/browser-pins.json}
output_dir=${BROWSER_CHECK_OUTPUT:-/out}
rebuild="Rebuild it: docker compose build browser-tests"

if [ "$#" -eq 0 ] || [ -t 0 ]; then
  echo "Usage: pnpm browser:container <command> [arguments...]" >&2
  echo "The checkout arrives as a tar stream on standard input." >&2
  exit 2
fi

if [ -d "$output_dir" ] && [ ! -w "$output_dir" ]; then
  echo "$output_dir is not writable, so browser evidence cannot be exported." >&2
  exit 4
fi

mkdir -p "$HOME" "$work_dir"
tar -xf - -C "$work_dir"

if ! cmp -s "$work_dir/pnpm-lock.yaml" "$deps_dir/pnpm-lock.yaml"; then
  echo "pnpm-lock.yaml differs from the image. $rebuild" >&2
  exit 3
fi
if ! cmp -s "$work_dir/bin/browser-pins.json" "$pins_file"; then
  echo "bin/browser-pins.json differs from the image. $rebuild" >&2
  exit 3
fi

for modules in node_modules extension/node_modules site/node_modules; do
  if [ -d "$deps_dir/$modules" ]; then
    ln -s "$deps_dir/$modules" "$work_dir/$modules"
  fi
done

cd "$work_dir"
status=0
"$@" || status=$?
if [ -d dist/browser-artifacts ]; then
  if ! { mkdir -p "$output_dir" && cp -R dist/browser-artifacts "$output_dir/"; }; then
    echo "Could not export dist/browser-artifacts to $output_dir." >&2
    if [ "$status" -eq 0 ]; then status=5; fi
  fi
fi
exit "$status"
