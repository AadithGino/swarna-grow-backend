#!/usr/bin/env bash
set -uo pipefail
export LOG_LEVEL="${LOG_LEVEL:-error}"
export RUN_HEAVY=1
export NODE_ENV=test
files=("$@")
if [[ ${#files[@]} -eq 0 ]]; then files=(tests/*.test.js); fi
runner=(node --import ./tests/global-test-db-serial.js --test --test-concurrency=1 --test-force-exit --test-reporter=spec)
if [[ -z "${RELEASE_LOG:-}" ]]; then exec "${runner[@]}" "${files[@]}"; fi
"${runner[@]}" "${files[@]}" 2>&1 | tee "$RELEASE_LOG"
statuses=("${PIPESTATUS[@]}")
status=${statuses[0]}
if [[ $status -eq 0 && ${statuses[1]} -ne 0 ]]; then status=${statuses[1]}; fi
if ! printf '\nGATE_EXIT_CODE: %s\n' "$status" | tee -a "$RELEASE_LOG"; then exit 1; fi
exit "$status"
