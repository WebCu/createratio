#!/bin/sh
set -eu

source_dir=${BROWSER_CHECK_SOURCE:-/src}
work_dir=${BROWSER_CHECK_WORK:-/work}
deps_dir=${BROWSER_CHECK_DEPS:-/opt/createratio/deps}
output_dir=${BROWSER_CHECK_OUTPUT:-/out}

if [ "$#" -eq 0 ]; then
  echo "Usage: docker compose run --rm browser-tests <command> [arguments...]" >&2
  exit 2
fi

if ! cmp -s "$source_dir/pnpm-lock.yaml" "$deps_dir/pnpm-lock.yaml"; then
  echo "pnpm-lock.yaml differs from the image. Rebuild it: docker compose build browser-tests" >&2
  exit 3
fi

mkdir -p "$HOME" "$work_dir"
(cd "$source_dir" && tar \
  --exclude=./.git --exclude=./node_modules --exclude=./extension/node_modules \
  --exclude=./site/node_modules --exclude=./dist --exclude=./.env --exclude='./.env.*' \
  -cf - .) | (cd "$work_dir" && tar -xf -)

for modules in node_modules extension/node_modules site/node_modules; do
  if [ -d "$deps_dir/$modules" ]; then
    ln -s "$deps_dir/$modules" "$work_dir/$modules"
  fi
done

cd "$work_dir"
status=0
"$@" || status=$?
if [ -d dist/browser-artifacts ]; then
  mkdir -p "$output_dir"
  cp -R dist/browser-artifacts "$output_dir/"
fi
exit "$status"
