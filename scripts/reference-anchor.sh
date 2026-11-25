#!/usr/bin/env bash
# Stand up the SDF Anchor Platform SEP-31 reference server locally, so corridor
# #0 has a conformant counterparty to run against. No agreements, no
# credentials, no real money — this is the lane anyone can run today.
#
#   scripts/reference-anchor.sh up             start the stack, wait for SEP-1 to serve
#   scripts/reference-anchor.sh down           tear it down
#   scripts/reference-anchor.sh logs           tail the platform logs
#   scripts/reference-anchor.sh status         show what is running
#   scripts/reference-anchor.sh doctor         check the stack is fit to run a corridor
#   scripts/reference-anchor.sh logs-dump DIR  write every container's logs to DIR
#   scripts/reference-anchor.sh payout-watch   play the anchor's payout operator (runs until killed)
#   scripts/reference-anchor.sh faults SPEC    misbehave once, on the next payment (see below)
#
# `logs-dump` is the non-interactive counterpart of `logs`: it never follows, so
# it terminates, which is what makes it usable from CI (see
# .github/workflows/reference-corridor.yml). An anchor-side stall is
# undebuggable from a bare exit code, and `logs -f` in a job would simply hang.
#
# Uses podman (rootless, no daemon).
#
# The arrangement is not obvious, so: the platform's own `--test-profile-runner`
# does NOT start the SEP server, despite the name. It starts the observer, event
# processor and wallet server, and expects everything else to already exist —
# two Postgres instances and Kafka as infrastructure, and the SEP/platform
# servers and Kotlin reference server as separate containers, wired together by
# the hostnames its bundled compose file hardcodes (`db`, `reference-db`,
# `kafka`, `platform`, `reference-server`). So this script runs:
#
#   db, reference-db, kafka   infrastructure
#   ap-sep                    --sep-server --platform-server   (serves :8080)
#   ap-ref                    --kotlin-reference-server        (business logic)
#   ap-obs                    --stellar-observer --event-processor
#
# The Stellar observer's starting cursor is NOT a config value. Anchor Platform
# 2.x keeps it in the platform DB (table `stellar_payment_observer_page_token`,
# a single row keyed `SINGLETON_ID`) and only falls back to Horizon's latest
# cursor when that row is absent. A row left behind by an earlier run is
# therefore how a stale cursor leaks into a fresh `up`: the observer resumes
# from a ledger the settle leg has already passed, never matches the incoming
# payment, and the transaction sits at `pending_sender` until the engine gives
# up. So `up` clears that row and reseeds it from Horizon's current ledger,
# minus a small safety margin, on every start.
#
#   START_LEDGER=<n>            start the observer at exactly ledger <n>
#   CURSOR_MARGIN_LEDGERS=<n>   ledgers of slack below Horizon's tip (default 10)
#   HORIZON_URL=<url>           Horizon to read the current ledger from
#
# `doctor` is the counterpart to that seeding: it reports how far the observer's
# cursor has drifted behind Horizon *before* a run, rather than letting the run
# discover it by ending in RECONCILE_STALLED after 10 identical consecutive polls
# (~20 s with the default stallThreshold=10 and reconcilePollMs=2000).
# SETTLEMENT_TIMEOUT only fires when the anchor's status keeps changing but never
# reaches a terminal state within recovery.timeout_seconds. `doctor` exits
# non-zero on any failed check, so it can gate CI or a verify:corridor run.
#
#   CURSOR_LAG_FAIL_LEDGERS=<n>  lag at which the cursor check fails (default 180)
#
# Config is extracted from the image itself rather than vendored, so it stays in
# step with whatever AP_IMAGE points at. Credentials come from the platform's own
# bundled docker-compose (POSTGRES_PASSWORD=password) — nothing invented here,
# nothing secret, testnet only.

set -euo pipefail

AP_IMAGE="${AP_IMAGE:-docker.io/stellar/anchor-platform:2.10.1}"
PG_IMAGE="${PG_IMAGE:-docker.io/library/postgres:16}"
KAFKA_IMAGE="${KAFKA_IMAGE:-docker.io/confluentinc/cp-kafka:7.4.3}"
NET="${NET:-apnet}"
SEP_URL="http://localhost:8080"
READY_TIMEOUT_SECS="${READY_TIMEOUT_SECS:-300}"
CONFIG_DIR="${CONFIG_DIR:-${TMPDIR:-/tmp}/corridor-anchor-config}"
HORIZON_URL="${HORIZON_URL:-https://horizon-testnet.stellar.org}"
CURSOR_MARGIN_LEDGERS="${CURSOR_MARGIN_LEDGERS:-10}"
START_LEDGER="${START_LEDGER:-}"
# ~180 ledgers is the default recovery.timeout_seconds (900s) at testnet's ~5s
# close time: beyond that an observer starting this far back cannot catch up to
# a fresh payment before the engine gives up on it.
CURSOR_LAG_FAIL_LEDGERS="${CURSOR_LAG_FAIL_LEDGERS:-180}"
# The image's own distribution account and its seed. Both ship in the image as
# test material, so anyone running the test profile can drain or merge that
# account (someone merged it on 2026-11-16). Set DISTRIBUTION_ACCOUNT, and
# DISTRIBUTION_SECRET for the reference server's own key, to an account only you
# hold; `pnpm prepare:distribution` creates it and adds the USDC trustline.
IMAGE_DISTRIBUTION_ACCOUNT="GBN4NNCDGJO4XW4KQU3CBIESUJWFVBUZPOKUZHT7W7WRB7CWOA7BXVQF"
DISTRIBUTION_ACCOUNT="${DISTRIBUTION_ACCOUNT:-}"
DISTRIBUTION_SECRET="${DISTRIBUTION_SECRET:-}"
BRIDGE_ASSET_ISSUER="${BRIDGE_ASSET_ISSUER:-GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5}"
# The Kotlin reference server (business logic, :8091) and how often
# `payout-watch` looks for transactions waiting on it.
REF_URL="${REF_URL:-http://localhost:8091}"
PAYOUT_POLL_SECS="${PAYOUT_POLL_SECS:-2}"
# Platform API (business-server JSON-RPC) for the fault commands. The SEP and
# platform servers both live in ap-sep; 8085 is its published API port.
PLATFORM_API_URL="${PLATFORM_API_URL:-http://localhost:8085}"
# How long a `faults` run waits for the payment it is meant to break.
FAULT_TIMEOUT_SECS="${FAULT_TIMEOUT_SECS:-900}"
FAULT_POLL_SECS="${FAULT_POLL_SECS:-1}"
# Which payment to break. Empty: the next one opened after the fault is armed.
# FAULT_TX_ID pins one SEP-31 transaction; FAULT_AMOUNT picks by amount_in.
FAULT_TX_ID="${FAULT_TX_ID:-}"
FAULT_AMOUNT="${FAULT_AMOUNT:-}"

log() { printf '• %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

require_podman() {
  command -v podman >/dev/null 2>&1 || die "podman is not installed"
}

psql_platform() { podman exec db psql -qtAX -U postgres -d postgres "$@"; }

# Horizon's paging token for a ledger is a TOID: the ledger sequence in the high
# 32 bits, transaction and operation order zero. Starting the observer at the
# first operation of ledger N is therefore N * 2^32.
ledger_to_cursor() { printf '%s' "$(( $1 * 4294967296 ))"; }

horizon_latest_ledger() {
  curl -fsS --max-time 10 "$HORIZON_URL/ledgers?order=desc&limit=1" 2>/dev/null \
    | tr ',' '\n' \
    | sed -n 's/.*"sequence":[[:space:]]*\([0-9]\{1,\}\).*/\1/p' \
    | head -1
}

# Clear any cursor left over from a previous run and pin a fresh one, so the
# observer cannot resume from a ledger the settle leg has already passed. See
# the header for why this is a DB row and not a config value.
seed_observer_cursor() {
  local cursor tip
  if [ -n "$START_LEDGER" ]; then
    SEEDED_LEDGER="$START_LEDGER"
    log "START_LEDGER=$SEEDED_LEDGER (override)"
  else
    tip="$(horizon_latest_ledger)"
    [ -n "$tip" ] || die "could not read the current ledger from $HORIZON_URL (set START_LEDGER to bypass)"
    SEEDED_LEDGER=$(( tip > CURSOR_MARGIN_LEDGERS ? tip - CURSOR_MARGIN_LEDGERS : 1 ))
    log "Horizon is at ledger $tip; starting the observer at $SEEDED_LEDGER (margin ${CURSOR_MARGIN_LEDGERS})"
  fi
  cursor="$(ledger_to_cursor "$SEEDED_LEDGER")"
  psql_platform -c "DELETE FROM stellar_payment_observer_page_token;" >/dev/null
  psql_platform -c "INSERT INTO stellar_payment_observer_page_token (id, cursor) VALUES ('SINGLETON_ID', '$cursor');" >/dev/null
  log "observer cursor seeded at ledger $SEEDED_LEDGER (cursor $cursor)"
}

# Point the anchor's config at DISTRIBUTION_ACCOUNT instead of the image's
# shared one. Runs on every `up`, because the extracted config is cached. A cached
# config already rewritten to a DIFFERENT account no longer contains the image's
# address, so the rewrite would silently do nothing; that case dies instead.
apply_distribution_override() {
  [ -n "$DISTRIBUTION_ACCOUNT" ] || return 0
  local f
  for f in $(grep -rlF "$IMAGE_DISTRIBUTION_ACCOUNT" "$CONFIG_DIR" 2>/dev/null || true); do
    sed -i "s/$IMAGE_DISTRIBUTION_ACCOUNT/$DISTRIBUTION_ACCOUNT/g" "$f"
  done
  # The reference server's own seed for that wallet is the first `secret:` after
  # `distributionWallet:` in reference-config.yaml. Matched by position rather
  # than by value, so the image's seed never has to appear in this repo.
  if [ -n "$DISTRIBUTION_SECRET" ] && [ -f "$CONFIG_DIR/reference-config.yaml" ]; then
    sed -i -E "/distributionWallet:/,/^[[:space:]]*secret:/ s|^([[:space:]]*secret:[[:space:]]*).*|\1$DISTRIBUTION_SECRET|" \
      "$CONFIG_DIR/reference-config.yaml"
  fi
  grep -rqF "$DISTRIBUTION_ACCOUNT" "$CONFIG_DIR" \
    || die "config in $CONFIG_DIR names neither the image's distribution account nor $DISTRIBUTION_ACCOUNT; delete $CONFIG_DIR and re-run"
  log "anchor receives on $DISTRIBUTION_ACCOUNT (overrides the image's shared account)"
}

# The account the running config receives payments on: the first
# distribution_account in the extracted assets config.
configured_distribution_account() {
  grep -rhoE 'distribution_account:[[:space:]]*G[A-Z2-7]{55}' "$CONFIG_DIR" 2>/dev/null \
    | head -1 | grep -oE 'G[A-Z2-7]{55}'
}

up() {
  require_podman
  podman network exists "$NET" 2>/dev/null || podman network create "$NET" >/dev/null
  log "network $NET ready"

  # Platform metadata DB. Hostname `db` is hardcoded in the test profile.
  if ! podman container exists db 2>/dev/null; then
    podman run -d --name db --network "$NET" --network-alias db \
      -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=password \
      "$PG_IMAGE" >/dev/null
  fi

  # The Kotlin reference server's own DB, on 5433 per the bundled compose.
  if ! podman container exists reference-db 2>/dev/null; then
    podman run -d --name reference-db --network "$NET" --network-alias reference-db \
      -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=password -e PGPORT=5433 \
      "$PG_IMAGE" >/dev/null
  fi

  # Event bus. KRaft mode (no ZooKeeper); values mirror the bundled compose.
  if ! podman container exists kafka 2>/dev/null; then
    podman run -d --name kafka --network "$NET" --network-alias kafka \
      -e KAFKA_NODE_ID=1 \
      -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER \
      -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP='CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT' \
      -e KAFKA_LISTENERS='INTERNAL://kafka:29092,CONTROLLER://kafka:29093' \
      -e KAFKA_ADVERTISED_LISTENERS='INTERNAL://kafka:29092' \
      -e KAFKA_INTER_BROKER_LISTENER_NAME=INTERNAL \
      -e KAFKA_CONTROLLER_QUORUM_VOTERS='1@kafka:29093' \
      -e KAFKA_PROCESS_ROLES='broker,controller' \
      -e KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0 \
      -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 \
      -e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 \
      -e CLUSTER_ID='ciWo7IWazngRchmPES6q5A==' \
      -e KAFKA_LOG_DIRS='/tmp/kraft-combined-logs' \
      "$KAFKA_IMAGE" >/dev/null
  fi

  log "waiting for infrastructure…"
  wait_for 'podman exec db pg_isready -U postgres' "platform db"
  wait_for 'podman exec reference-db pg_isready -U postgres -p 5433' "reference db"

  # Pull the platform's own config out of the image rather than vendoring a copy
  # that would drift. `--test-profile-runner` extracts it to a temp dir on boot.
  if [ ! -f "$CONFIG_DIR/config.env" ]; then
    log "extracting config from ${AP_IMAGE}…"
    mkdir -p "$CONFIG_DIR"
    podman rm -f ap-extract >/dev/null 2>&1 || true
    podman run -d --name ap-extract --network "$NET" "$AP_IMAGE" --test-profile-runner >/dev/null
    local res=""
    for _ in $(seq 1 30); do
      # `set -e` + `pipefail`: this exec fails for the first second or two while
      # the container boots, and an unguarded assignment would abort `up` there.
      res="$(podman exec ap-extract sh -c 'ls -d /tmp/resource-temp-dir* 2>/dev/null' 2>/dev/null | tr -d '\r' | head -1)" || true
      [ -n "$res" ] && break
      sleep 2
    done
    [ -n "$res" ] || die "could not extract config from the image"
    podman cp "ap-extract:$res/config/." "$CONFIG_DIR/"
    podman cp "ap-extract:$res/profiles/default/config.env" "$CONFIG_DIR/config.env"
    podman rm -f ap-extract >/dev/null 2>&1 || true
    log "config extracted to $CONFIG_DIR"
  fi
  apply_distribution_override

  # SEP + platform servers. This is what actually serves :8080.
  if ! podman container exists ap-sep 2>/dev/null; then
    podman run -d --name ap-sep --network "$NET" --network-alias platform \
      -p 8080:8080 -p 8085:8085 \
      -v "$CONFIG_DIR:/config:ro,z" --env-file "$CONFIG_DIR/config.env" \
      "$AP_IMAGE" --sep-server --platform-server >/dev/null
  fi

  # Anchor business logic. The SEP server proxies SEP-12/SEP-31 callbacks here;
  # without it every customer call comes back 502 "service not available".
  if ! podman container exists ap-ref 2>/dev/null; then
    podman run -d --name ap-ref --network "$NET" --network-alias reference-server \
      -p 8091:8091 -v "$CONFIG_DIR:/config:ro,z" \
      -e KT_REFERENCE_SERVER_CONFIG=/config/reference-config.yaml \
      "$AP_IMAGE" --kotlin-reference-server >/dev/null
  fi

  log "waiting for the SEP server (this takes a minute on first boot)…"
  local waited=0
  until curl -fsS --max-time 3 "$SEP_URL/.well-known/stellar.toml" >/dev/null 2>&1; do
    waited=$((waited + 5))
    if [ "$waited" -ge "$READY_TIMEOUT_SECS" ]; then
      printf '\n'
      # The platform runs as ap-sep/ap-ref/ap-obs; there has never been a
      # container called `ap`, so this printed nothing at exactly the moment it
      # was needed.
      for c in ap-sep ap-ref ap-obs; do
        podman container exists "$c" 2>/dev/null || continue
        printf -- '--- %s (last 40 lines) ---\n' "$c" >&2
        podman logs --tail 40 "$c" >&2 2>&1 || true
      done
      die "SEP server did not come up within ${READY_TIMEOUT_SECS}s"
    fi
    sleep 5
  done

  # The observer's tables are created by the platform server's Flyway migration,
  # so the cursor can only be seeded once that server has booted — which serving
  # SEP-1 above establishes.
  wait_for 'psql_platform -c "SELECT 1 FROM stellar_payment_observer_page_token LIMIT 1"' \
    "observer cursor table"

  # Stop the observer BEFORE seeding. A running observer writes its own paging
  # token back to this row as it streams, so seeding underneath a live one is
  # overwritten within milliseconds and the new cursor never takes effect.
  podman rm -f ap-obs >/dev/null 2>&1 || true
  seed_observer_cursor

  # Watches Stellar for the incoming settlement and drives the transaction to
  # completed. Without it a payment settles on-chain but never reconciles.
  # Recreated on every `up` so it reads the cursor just seeded rather than
  # resuming from wherever the previous run left off.
  podman run -d --name ap-obs --network "$NET" \
    -v "$CONFIG_DIR:/config:ro,z" --env-file "$CONFIG_DIR/config.env" \
    "$AP_IMAGE" --stellar-observer --event-processor >/dev/null
  log "observer started"

  printf '\n✓ reference anchor is serving\n\n'
  printf '  SEP-1  %s/.well-known/stellar.toml\n' "$SEP_URL"
  printf '  SEP-10 %s/auth\n' "$SEP_URL"
  printf '  SEP-12 %s/sep12\n' "$SEP_URL"
  printf '  SEP-31 %s/sep31\n' "$SEP_URL"
  printf '  SEP-38 %s/sep38\n' "$SEP_URL"
  printf '\n  observer starting at ledger %s\n' "$SEEDED_LEDGER"
  printf '\nNext: pnpm testnet   (see docs/operations.md §1)\n'
}

wait_for() {
  local cmd="$1" name="$2" waited=0
  until eval "$cmd" >/dev/null 2>&1; do
    waited=$((waited + 3))
    [ "$waited" -ge 120 ] && die "$name did not become ready"
    sleep 3
  done
  log "$name ready"
}

# Write each container's logs to DIR, one file apiece. Non-following and
# non-interactive: it always terminates, and it never fails the caller — this
# runs on the failure path, where the logs are the only evidence left.
logs_dump() {
  require_podman
  local dir="${1:-anchor-logs}"
  mkdir -p "$dir"
  for c in ap-sep ap-ref ap-obs kafka db reference-db; do
    if podman container exists "$c" 2>/dev/null; then
      podman logs "$c" >"$dir/$c.log" 2>&1 || true
      log "wrote $dir/$c.log"
    else
      printf 'container %s was never created\n' "$c" >"$dir/$c.log"
    fi
  done
  podman ps -a --filter network="$NET" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' >"$dir/containers.txt" 2>&1 || true
}

DOCTOR_FAILURES=0
pass_() { printf '  ✓ %-16s %s\n' "$1" "$2"; }
fail_() { printf '  ✗ %-16s %s\n' "$1" "$2"; DOCTOR_FAILURES=$((DOCTOR_FAILURES + 1)); }

container_running() {
  [ "$(podman inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]
}

# Asset codes one level inside SEP-31 /info's `receive` object. A depth-aware
# scan rather than a regex: the nested sep12 blocks put quoted braces and commas
# in the way of anything simpler.
sep31_receive_codes() {
  awk '
    { s = s $0 }
    END {
      i = index(s, "\"receive\"")
      if (i == 0) exit
      s = substr(s, i)
      i = index(s, "{")
      if (i == 0) exit
      depth = 0; inq = 0; esc = 0; key = ""; capturing = 0; expect = 0
      for (n = i; n <= length(s); n++) {
        c = substr(s, n, 1)
        if (inq) {
          if (esc) { esc = 0; if (capturing) key = key c; continue }
          if (c == "\\") { esc = 1; continue }
          if (c == "\"") { inq = 0; if (capturing) { print key; capturing = 0; key = "" }; continue }
          if (capturing) key = key c
          continue
        }
        if (c == "\"") { inq = 1; if (depth == 1 && expect) { capturing = 1; key = ""; expect = 0 }; continue }
        if (c == "{") { depth++; if (depth == 1) expect = 1; continue }
        if (c == "}") { depth--; if (depth == 0) break; continue }
        if (c == ",") { if (depth == 1) expect = 1; continue }
      }
    }'
}

doctor() {
  require_podman
  printf 'reference anchor doctor\n\n'

  local missing="" c
  for c in db reference-db kafka ap-sep ap-ref ap-obs; do
    container_running "$c" || missing="$missing $c"
  done
  if [ -n "$missing" ]; then
    fail_ containers "not running:$missing"
  else
    pass_ containers "db reference-db kafka ap-sep ap-ref ap-obs"
  fi

  if curl -fsS --max-time 5 "$SEP_URL/.well-known/stellar.toml" >/dev/null 2>&1; then
    pass_ sep1 "$SEP_URL/.well-known/stellar.toml"
  else
    fail_ sep1 "$SEP_URL/.well-known/stellar.toml does not serve"
  fi

  local info codes count
  info="$(curl -fsS --max-time 5 "$SEP_URL/sep31/info" 2>/dev/null)" || info=""
  if [ -z "$info" ]; then
    fail_ sep31-info "$SEP_URL/sep31/info did not respond"
  else
    codes="$(printf '%s' "$info" | sep31_receive_codes | tr '\n' ' ' | sed 's/ *$//')"
    count="$(printf '%s' "$info" | sep31_receive_codes | grep -c . || true)"
    if [ "$count" -gt 0 ]; then
      pass_ sep31-info "receive: $codes"
    else
      fail_ sep31-info "receive list is empty - no asset can be received today"
    fi
  fi

  # The anchor hands out this address as the deposit address. If it does not
  # exist on chain, or cannot hold the bridge asset, every settle fails with
  # op_no_destination / op_no_trust after the payment has already been opened.
  local dist acct
  dist="$(configured_distribution_account)" || dist=""
  if [ -z "$dist" ]; then
    fail_ distribution "no distribution_account found in $CONFIG_DIR"
  else
    acct="$(curl -fsS --max-time 10 "$HORIZON_URL/accounts/$dist" 2>/dev/null)" || acct=""
    if [ -z "$acct" ]; then
      fail_ distribution "$dist does not exist on $HORIZON_URL - settle would fail op_no_destination"
    elif ! printf '%s' "$acct" | grep -qF "$BRIDGE_ASSET_ISSUER"; then
      fail_ distribution "$dist has no trustline to $BRIDGE_ASSET_ISSUER - settle would fail op_no_trust"
    else
      pass_ distribution "$dist exists and trusts the bridge asset"
    fi
  fi

  # The check this command exists for. Report the gap as ledgers, so a
  # borderline stack is legible rather than a bare pass/fail.
  local cursor tip lag
  cursor="$(psql_platform -c 'SELECT cursor FROM stellar_payment_observer_page_token;' 2>/dev/null | head -1 | tr -d '[:space:]')" || cursor=""
  tip="$(horizon_latest_ledger)"
  case "$cursor" in
    ''|*[!0-9]*) cursor="" ;;
  esac
  if [ -z "$cursor" ]; then
    fail_ cursor-lag "no observer cursor stored - run \`up\` to seed one"
  elif [ -z "$tip" ]; then
    fail_ cursor-lag "could not read the current ledger from $HORIZON_URL"
  else
    lag=$(( tip - cursor / 4294967296 ))
    if [ "$lag" -gt "$CURSOR_LAG_FAIL_LEDGERS" ]; then
      fail_ cursor-lag "$lag ledgers behind Horizon (limit $CURSOR_LAG_FAIL_LEDGERS) - a fresh payment will not be seen in time"
    else
      pass_ cursor-lag "$lag ledgers behind Horizon (limit $CURSOR_LAG_FAIL_LEDGERS)"
    fi
  fi

  printf '\n'
  if [ "$DOCTOR_FAILURES" -eq 0 ]; then
    printf '✓ stack is fit to run a corridor\n'
    return 0
  fi
  printf '✗ %s check(s) failed\n' "$DOCTOR_FAILURES"
  return 1
}

# The reference server never pays a SEP-31 transaction out by itself: its event
# processor handles SEP-6 only, and SEP-31 events go to a no-op. Payout is
# triggered by its test-only POST /sep31/transactions/{id}/process (registered
# when `enableTest` is on, which the bundled reference-config.yaml sets), which
# calls notify_offchain_funds_sent and moves the transaction to `completed`.
# Without something calling it, every run sits at `pending_receiver` until the
# engine's timeout and ends `held`.
#
# `payout-watch` is that something: the anchor operator who sends the fiat leg.
# It triggers /process once per SEP-31 transaction that reaches
# `pending_receiver` (i.e. after the anchor has seen the payment on chain), and
# never touches the sending side. Run it in the background for a corridor run.
payout_watch() {
  require_podman
  local seen=" " id
  log "payout-watch: paying out pending_receiver SEP-31 transactions via $REF_URL (every ${PAYOUT_POLL_SECS}s)"
  while :; do
    for id in $(psql_platform -c "SELECT id FROM sep31_transaction WHERE status = 'pending_receiver';" 2>/dev/null || true); do
      case "$seen" in *" $id "*) continue ;; esac
      if curl -fsS --max-time 10 -X POST "$REF_URL/sep31/transactions/$id/process" >/dev/null 2>&1; then
        seen="$seen$id "
        log "payout-watch: payout triggered for $id"
      else
        log "payout-watch: $REF_URL refused payout for $id; retrying"
      fi
    done
    sleep "$PAYOUT_POLL_SECS"
  done
}

# ---- failure injection ------------------------------------------------------
#
# The reference server is a conformant anchor that always behaves: it pays out
# when told, never rejects, never asks for more information and never refunds.
# The scenarios in docs/operations.md need it to misbehave on demand, and the
# way to get that without forking the platform is to play its business server:
#
#   scripts/reference-anchor.sh faults delay=30
#   scripts/reference-anchor.sh faults reject
#   scripts/reference-anchor.sh faults ask-info
#   scripts/reference-anchor.sh faults refund
#   scripts/reference-anchor.sh faults quote-expiry=1
#
# scripts/fault-scenario.sh runs a whole corridor under one of these, and is
# what .github/workflows/reference-corridor.yml exercises live.
#
# Each invocation watches the platform for the NEXT payment (a transaction
# opened after the fault was armed), applies the fault once, then exits. Pin one
# exactly with FAULT_TX_ID=<sep31 transaction id>, or pick by its on-chain
# amount with FAULT_AMOUNT=<amount_in>.
#
#   delay=N        hold the payout for N seconds (the anchor's fiat leg is slow)
#   reject         move the transaction to `error` (the anchor refuses to pay)
#   ask-info       move it to `pending_customer_info_update` (it wants updated
#                  customer information before paying out)
#   refund         report a full refund (`refunded`) — the only refund SEP-31
#                  allows; the engine observes it and never asks for it
#   quote-expiry=N make every quote issued from now on expire N seconds after
#                  issuance
#
# `faults` plays the anchor operator like `payout-watch` does, so a faulted run
# uses one or the other, never both: `faults` only moves a transaction whose
# funds the anchor has already received (status `pending_receiver`).
#
# How each is applied, and why none of it is a fork:
#   reject/refund  the platform server's JSON-RPC business-server API
#                  (POST :8085/transactions — notify_transaction_error and
#                  notify_refund_sent), the same interface the Kotlin reference
#                  server itself calls to progress a transaction.
#   delay          the reference server's test-only process endpoint, exactly as
#                  payout-watch calls it, just later.
#   ask-info       the platform has no RPC for it in 2.x, so this writes the
#                  status the platform reads back on GET /transactions/:id.
#   quote-expiry   the reference server computes a quote's expiry itself
#                  (tomorrow noon UTC) and no config shortens it, so a trigger
#                  on the platform's quote table rewrites it at insert time.
#
# Platform API auth is read from the extracted config: PLATFORM_API_AUTH_TYPE and
# SECRET_PLATFORM_API_AUTH_SECRET in config.env, falling back to the reference
# server's own `auth:` block. api_key is sent as X-Api-Key; jwt is signed here
# with openssl. All of it is test-profile material, never a production control.

PLATFORM_AUTH=()

config_env_value() {
  [ -f "$CONFIG_DIR/config.env" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$CONFIG_DIR/config.env" \
    | tail -1 | sed -e 's/^"//' -e 's/"$//'
}

# A value one level inside the reference server's `auth:` block.
reference_auth_value() {
  [ -f "$CONFIG_DIR/reference-config.yaml" ] || return 0
  awk -v key="$1" '
    /^auth:/ { inauth = 1; next }
    inauth && /^[^[:space:]]/ { inauth = 0 }
    inauth && $1 == key ":" { $1 = ""; sub(/^[[:space:]]+/, ""); print; exit }
  ' "$CONFIG_DIR/reference-config.yaml" \
    | sed -e 's/[[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# Fill PLATFORM_AUTH with the header the platform API demands, if any.
platform_auth_args() {
  local type secret now exp header payload sig
  type="$(config_env_value PLATFORM_API_AUTH_TYPE)"
  secret="$(config_env_value SECRET_PLATFORM_API_AUTH_SECRET)"
  [ -n "$type" ] || type="$(reference_auth_value type)"
  [ -n "$secret" ] || secret="$(reference_auth_value anchorToPlatformSecret)"
  case "$(printf '%s' "$type" | tr '[:upper:]' '[:lower:]')" in
    api_key|apikey)
      [ -n "$secret" ] || die "platform API needs a key but config has no SECRET_PLATFORM_API_AUTH_SECRET"
      PLATFORM_AUTH=(-H "X-Api-Key: $secret")
      ;;
    jwt)
      [ -n "$secret" ] || die "platform API needs a JWT secret but config has none"
      now="$(date +%s)"
      exp=$((now + 300))
      header="$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)"
      payload="$(printf '{"iat":%s,"exp":%s,"sub":"corridor-faults"}' "$now" "$exp" | b64url)"
      sig="$(printf '%s' "$header.$payload" | openssl dgst -sha256 -hmac "$secret" -binary | b64url)"
      PLATFORM_AUTH=(-H "Authorization: Bearer $header.$payload.$sig")
      ;;
  esac
}

# One JSON-RPC call to the platform API. Prints the platform's refusal on
# failure so a fault that did not apply cannot look like one that did.
platform_rpc() {
  local body res
  body="[{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"$1\",\"params\":$2}]"
  res="$(curl -fsS --max-time 15 -X POST "$PLATFORM_API_URL/transactions" \
    -H 'content-type: application/json' ${PLATFORM_AUTH[@]+"${PLATFORM_AUTH[@]}"} \
    -d "$body" 2>&1)" || { printf '%s' "$res" >&2; return 1; }
  case "$res" in
    *'"error"'*) printf '%s' "$res" >&2; return 1 ;;
  esac
  return 0
}

require_uint() {
  case "${2:-}" in
    ''|*[!0-9]*) die "$1 needs a whole number, got \"${2:-}\"" ;;
  esac
}

# `amount_in - amount_fee`, with the trailing zeros SEP-38/SEP-31 do not want.
net_refund_amount() {
  awk -v a="$1" -v f="${2:-0}" 'BEGIN { printf "%.7f", a - f }' \
    | sed -e 's/0*$//' -e 's/\.$//'
}

# The SQL predicate selecting the payment this fault is aimed at.
fault_predicate() {
  local parts=("extract(epoch from started_at) >= $ARMED_EPOCH")
  if [ -n "$FAULT_TX_ID" ]; then
    parts+=("id = '$FAULT_TX_ID'")
  else
    parts+=("status = 'pending_receiver'")
  fi
  [ -z "$FAULT_AMOUNT" ] || parts+=("amount_in = '$FAULT_AMOUNT'")
  local IFS=' AND '
  printf '%s' "${parts[*]}"
}

# Both waiters put their row in FAULT_ROW and run in THIS shell: inside
# `$(...)` a `die` would only end the subshell, and the fault would go on with
# an empty transaction id.
FAULT_ROW=""

wait_for_payment() {
  FAULT_ROW=""
  while :; do
    FAULT_ROW="$(psql_platform -t -A -F'|' -c \
      "SELECT id, status, amount_in, amount_in_asset, amount_fee, amount_fee_asset
         FROM sep31_transaction WHERE $(fault_predicate)
        ORDER BY started_at DESC LIMIT 1;" 2>/dev/null)" || FAULT_ROW=""
    if [ -n "$FAULT_ROW" ]; then return 0; fi
    if [ "$SECONDS" -ge "$ARMED_DEADLINE" ]; then
      die "no payment matched the fault within ${FAULT_TIMEOUT_SECS}s (is the stack up, and payout-watch not already running?)"
    fi
    sleep "$FAULT_POLL_SECS"
  done
}

# Wait until the trigger planted by the quote-expiry fault has rewritten a quote.
wait_for_short_quote() {
  local secs="$1"
  FAULT_ROW=""
  while :; do
    FAULT_ROW="$(psql_platform -t -A -F'|' -c \
      "SELECT id, expires_at FROM exchange_quote
        WHERE extract(epoch from created_at) >= $ARMED_EPOCH
          AND extract(epoch from expires_at) - extract(epoch from created_at) <= $((secs + 2))
        ORDER BY created_at DESC LIMIT 1;" 2>/dev/null)" || FAULT_ROW=""
    if [ -n "$FAULT_ROW" ]; then return 0; fi
    if [ "$SECONDS" -ge "$ARMED_DEADLINE" ]; then
      die "no quote was issued within ${FAULT_TIMEOUT_SECS}s; the trigger is still armed (drop it with: podman exec db psql -U postgres -d postgres -c 'DROP TRIGGER IF EXISTS corridor_fault_quote_expiry ON exchange_quote;')"
    fi
    sleep 0.2
  done
}

faults() {
  local spec kind value row id status amount asset fee fee_asset
  spec="${1:-${ANCHOR_FAULTS:-}}"
  [ -n "$spec" ] || die "usage: $0 faults <delay=SECONDS|reject|ask-info|refund|quote-expiry=SECONDS>"
  kind="${spec%%=*}"
  value=""
  case "$spec" in *=*) value="${spec#*=}" ;; esac
  case "$kind" in
    delay|quote-expiry) require_uint "$kind" "$value" ;;
    reject|ask-info|refund) [ -z "$value" ] || die "$kind takes no value (got \"$value\")" ;;
    *) die "unknown fault \"$spec\" (delay=SECONDS|reject|ask-info|refund|quote-expiry=SECONDS)" ;;
  esac
  case "$FAULT_TX_ID" in *[!A-Za-z0-9_-]*) die "FAULT_TX_ID must be letters, digits, '_' or '-'" ;; esac
  case "$FAULT_AMOUNT" in *[!0-9.]*) die "FAULT_AMOUNT must be a decimal amount" ;; esac
  require_podman

  ARMED_EPOCH="$(psql_platform -c 'SELECT extract(epoch from now())::bigint;' | tr -d '[:space:]')" || ARMED_EPOCH=""
  case "$ARMED_EPOCH" in ''|*[!0-9]*) die "could not read the platform clock; is the stack up?" ;; esac
  ARMED_DEADLINE=$((SECONDS + FAULT_TIMEOUT_SECS))

  if [ "$kind" = "quote-expiry" ]; then
    log "quote-expiry: quotes issued from now expire in ${value}s"
    psql_platform -c "CREATE OR REPLACE FUNCTION corridor_fault_quote_expiry()
      RETURNS trigger AS \$f\$ BEGIN
        NEW.expires_at := now() + ($value * interval '1 second');
        RETURN NEW;
      END \$f\$ LANGUAGE plpgsql;" >/dev/null
    psql_platform -c "DROP TRIGGER IF EXISTS corridor_fault_quote_expiry ON exchange_quote;" >/dev/null
    psql_platform -c "CREATE TRIGGER corridor_fault_quote_expiry BEFORE INSERT ON exchange_quote
      FOR EACH ROW EXECUTE FUNCTION corridor_fault_quote_expiry();" >/dev/null
    wait_for_short_quote "$value"
    psql_platform -c "DROP TRIGGER IF EXISTS corridor_fault_quote_expiry ON exchange_quote;" >/dev/null
    IFS='|' read -r id _ <<<"$FAULT_ROW"
    log "quote-expiry: quote $id issued with a ${value}s expiry"
    exit 0
  fi

  log "faults: $spec - waiting for the next payment (up to ${FAULT_TIMEOUT_SECS}s)"
  wait_for_payment
  IFS='|' read -r id status amount asset fee fee_asset <<<"$FAULT_ROW"
  log "faults: payment $id (status=$status amount_in=$amount)"

  case "$kind" in
    delay)
      log "delay: holding $id's payout for ${value}s"
      sleep "$value"
      curl -fsS --max-time 10 -X POST "$REF_URL/sep31/transactions/$id/process" >/dev/null \
        || die "the reference server refused the payout for $id"
      log "delay: payout released for $id after ${value}s"
      ;;
    reject)
      platform_auth_args
      platform_rpc notify_transaction_error \
        "{\"transaction_id\":\"$id\",\"message\":\"corridor fault: transaction rejected\"}" \
        || die "the platform refused to move $id to error (see its response above)"
      log "reject: $id is now error"
      ;;
    ask-info)
      # RETURNING, not the command tag: psql_platform runs psql -q, which
      # suppresses "UPDATE 1", so matching that text could never succeed.
      row="$(psql_platform -t -A -c "UPDATE sep31_transaction
        SET status = 'pending_customer_info_update',
            message = 'corridor fault: updated customer information required',
            updated_at = now()
        WHERE id = '$id'
        RETURNING id;")" || row=""
      [ "$row" = "$id" ] \
        || die "could not move $id to pending_customer_info_update (row returned: \"$row\")"
      log "ask-info: $id is now pending_customer_info_update"
      ;;
    refund)
      amount="$(net_refund_amount "$amount" "${fee:-0}")"
      asset="${asset:-stellar:USDC:${BRIDGE_ASSET_ISSUER}}"
      fee_asset="${fee_asset:-$asset}"
      platform_auth_args
      platform_rpc notify_refund_sent \
        "{\"transaction_id\":\"$id\",\"message\":\"corridor fault: refunded\",\"refund\":{\"id\":\"refund-$id\",\"amount\":{\"amount\":\"$amount\",\"asset\":\"$asset\"},\"amount_fee\":{\"amount\":\"${fee:-0}\",\"asset\":\"$fee_asset\"}}}" \
        || die "the platform refused the refund for $id (see its response above)"
      log "refund: $id is now refunded ($amount $asset)"
      ;;
  esac
  exit 0
}

down() {
  require_podman
  # A quote-expiry fault that never caught a quote leaves its trigger behind.
  psql_platform -c "DROP TRIGGER IF EXISTS corridor_fault_quote_expiry ON exchange_quote;" \
    >/dev/null 2>&1 || true
  podman rm -f ap ap-sep ap-ref ap-obs ap-extract kafka db reference-db >/dev/null 2>&1 || true
  podman network rm -f "$NET" >/dev/null 2>&1 || true
  log "torn down"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  logs) podman logs -f "${2:-ap-sep}" ;;
  logs-dump) logs_dump "${2:-anchor-logs}" ;;
  status) podman ps --filter network="$NET" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' ;;
  doctor) doctor ;;
  payout-watch) payout_watch ;;
  faults) faults "${2:-}" ;;
  *) die "usage: $0 <up|down|logs|logs-dump [dir]|status|doctor|payout-watch|faults SPEC>" ;;
esac
