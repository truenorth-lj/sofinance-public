#!/usr/bin/env bash
# Vercel "Ignored Build Step". Exit 0 = skip this build, exit 1 = build.
# Keeps Build CPU Minutes down:
#  - Preview builds never run (test locally instead).
#  - Any build is skipped when the change only touches docs, tests or artifacts.
set -u
msg="${VERCEL_GIT_COMMIT_MESSAGE:-}"
ref="${VERCEL_GIT_COMMIT_REF:-}"
env="${VERCEL_ENV:-}"

if [ "$env" != "production" ]; then
  echo "Preview builds are disabled; test locally."; exit 0
fi

prev="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$prev" ] || ! git cat-file -e "$prev^{commit}" 2>/dev/null; then
  echo "No previous deployed commit available; building."; exit 1
fi
changed=$(git diff --name-only "$prev" HEAD 2>/dev/null) || { echo "diff failed; building."; exit 1; }
[ -z "$changed" ] && { echo "No file changes; building."; exit 1; }
code=$(printf '%s\n' "$changed" | grep -Ev '(\.md$|^docs/|^specs/|^artifacts/|^screenshots/|^sample/|^e2e/|\.test\.tsx?$|\.spec\.tsx?$|^LICENSE$)')
if [ -z "$code" ]; then echo "Only docs/tests changed; skipping build."; exit 0; fi
echo "Code changed; building."; exit 1
