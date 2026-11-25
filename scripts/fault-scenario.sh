#!/usr/bin/env bash
# Run ONE live corridor against the reference anchor with a fault injected.
#
#   scripts/fault-scenario.sh [FAULT_SPEC] [EXPECTED_STATE]
#
#   scripts/fault-scenario.sh                    # refund the next payment -> `refunded`
#   scripts/fault-scenario.sh quote-expiry=0 refunded
#
# The fault is armed first — it waits for the NEXT payment — and then
# `pnpm verify:corridor` runs with EXPECT_STATE set, so reaching the faulted
# terminal state is the assertion instead of `completed`. This is the scenario
# .github/workflows/reference-corridor.yml runs on its schedule, and the
# worked example in docs/operations.md ("Failing the reference anchor on
# purpose").
#
# Only `refund` implies its expected state (`refunded`). `delay`, `reject`,
# `ask-info` and `quote-expiry` end wherever the manifest's recovery settings
# take the run (see docs/operations.md), so they need the state spelled out.
#
# Requires the stack already up (`scripts/reference-anchor.sh up`), a funded
# testnet signer in CORRIDOR_SIGNER_SECRET, and no payout-watch running: both
# play the anchor's operator. Fault logs land in anchor-logs/fault-scenario.log
# (override with FAULT_LOG_DIR), which CI uploads when the job fails.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

spec="${1:-refund}"
expected="${2:-}"
[ -n "$expected" ] || [ "$spec" != "refund" ] || expected=refunded
if [ -z "$expected" ]; then
  echo "usage: $0 <fault-spec> <expected-terminal-state>" >&2
  echo "       (only \`refund\` implies its state, \`refunded\`)" >&2
  exit 2
fi

log_dir="${FAULT_LOG_DIR:-anchor-logs}"
mkdir -p "$log_dir" || exit 1
fault_log="$log_dir/fault-scenario.log"
: >"$fault_log" || exit 1

scripts/reference-anchor.sh faults "$spec" >"$fault_log" 2>&1 &
fault_pid=$!
trap 'kill "$fault_pid" 2>/dev/null || true' EXIT

echo "fault-scenario: armed \`$spec\`; the corridor must end \`$expected\`"
verdict=0
EXPECT_STATE="$expected" pnpm verify:corridor
verdict=$?

# The fault only counts if it actually applied: a run that happens to reach the
# expected state for some other reason is not evidence the injection worked.
fault_status=0
wait "$fault_pid" || fault_status=$?
if [ "$fault_status" -ne 0 ]; then
  echo "fault-scenario: \`$spec\` never applied — its log:" >&2
  sed 's/^/  /' "$fault_log" >&2
  exit 1
fi

if [ "$verdict" -ne 0 ]; then
  echo "fault-scenario: \`$spec\` applied, but the corridor did not end \`$expected\`" >&2
  exit "$verdict"
fi

echo "fault-scenario: corridor reached \`$expected\` under \`$spec\`"
