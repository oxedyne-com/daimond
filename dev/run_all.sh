#!/bin/bash
# run_all.sh -- run every functional verifier, each in the environment it needs.
#
# The verifiers do NOT all want the same world, and a flat loop over them cannot
# be right for all three groups at once:
#
#   A. Most want NO gateway on :9002. `verify_credits` fetch-stubs the gateway on
#      purpose; and with a real one up, a non-Pro test account gets a 402 from
#      sync, which raises the "Sync is part of Pro" dialog OVER the app, so every
#      later click in that test times out against it.
#   B. Some start their OWN gateway and REFUSE to run if one is already there,
#      because they pin an owner in configuration (operators, releases, logout).
#      They need :9002 free, same as A.
#   C. A few need a gateway ALREADY running, and two of those need an account
#      holding the `email` unlock and some credits (tools, compose), plus the
#      mail fixtures on :1143 and :1587 (compose).
#
# So: phase 1 runs A and B with :9002 clear; phase 2 brings a gateway up, grants
# what C needs, and runs C. Anything that cannot be provisioned SKIPS loudly -- a
# verifier that silently did not run is worse than one that failed.
#
# Needs `dev/serve.mjs` on :8777 and `dev/mockllm.mjs` on :9099 (without the mock
# every `@tool` call quietly does nothing). Start those yourself; this script does
# not, so a suite run never kills a server you were using.
#
#   LOG=/tmp/suite.log bash dev/run_all.sh          # everything
#   bash dev/run_all.sh verify_tags verify_doc      # just these
cd "$(dirname "$0")/.."
ROOT=$(pwd)

# Scratch root for logs, profiles and artefacts.  NOT /tmp: it is a tmpfs, so
# leftovers there are RAM charged to the agent fleet's cgroup, reclaimable only
# by swapping -- three OOM incidents have come out of it.  See harness.mjs.
SCRATCH=${DAIMOND_SCRATCH:-$HOME/.cache/daimond}
mkdir -p "$SCRATCH"

LOG=${LOG:-$SCRATCH/suite.log}          # override with LOG=... ; session-independent
GW_BIN=${GW_BIN:-gateway/target/release/daimond_gateway}
CTL_BIN=${CTL_BIN:-gateway/target/release/daimond_ctl}
COMPOSE_PROFILE=$SCRATCH/compose-profile
IMAP_FIXTURE=${IMAP_FIXTURE:-$HOME/usr/code/rust/fe2o3/target/debug/examples/imap_test_server}
SMTPD=${SMTPD:-dev/smtpd.mjs}

# The verifiers that need a gateway ALREADY up (group C). Pairing and the two
# passkey ones talk to gateway endpoints directly (a pairing code, the sealed
# passkey blob at pkblob:<handle>); delivery and sync read what the gateway
# holds. Without one they fail on 502s that say nothing about the product.
# One line, and matched with a space either side: a newline in this list would
# make the last name on a line never match, and that test would run in the wrong
# phase without saying so.
NEEDS_GATEWAY="verify_autoreload verify_qr verify_spend verify_sync verify_mailsync verify_tools verify_compose verify_mailfolders verify_pairing verify_passkey_adopt verify_passkey_blob"
# Of those, the two that also need an entitled account (and, for compose, mail).
NEEDS_GRANT="verify_tools verify_compose verify_mailfolders"

# The extension flows load a real unpacked extension, which Chromium will only
# do HEADED -- and a headed browser needs a display. Never the user's: an X
# forward that has gone quiet (a sleeping laptop at the other end) fails these
# with "Missing X server", and a live one throws windows in their face. Xvfb
# gives them a display of their own.
HEADED="verify_ext verify_grant"
# verify_style walks 3 themes x 3 device sizes and is simply slower than the rest.
slow_for() { [ "$1" = "verify_style" ] && echo 600 || echo 180; }

pass=0; fail=0; skip=0; failed=""; skipped=""
: > "$LOG"
say() { echo "$1" | tee -a "$LOG"; }

run_one() {
	local name=$1 out code tail
	[ "$name" = "verify_durability" ] && rm -rf "$SCRATCH/durability-profile"
	case " $HEADED " in
		*" $name "*)
			if command -v xvfb-run >/dev/null 2>&1; then
				out=$(timeout "$(slow_for "$name")" xvfb-run -a -s "-screen 0 1400x900x24" \
					node "dev/$name.mjs" 2>&1)
				code=$?
			else
				skip_one "$name" "needs a headed browser and xvfb-run is not installed"
				return
			fi ;;
		*)
			out=$(timeout "$(slow_for "$name")" node "dev/$name.mjs" 2>&1)
			code=$? ;;
	esac
	tail=$(echo "$out" | grep -vE "Skipping host" | tail -1)
	if echo "$out" | grep -q '^SKIPPED:'; then
		skip=$((skip+1)); skipped="$skipped $name"
		say "SKIP  $name  — $(echo "$out" | grep '^SKIPPED:' | head -1)"
	elif [ $code -eq 0 ]; then
		pass=$((pass+1)); say "PASS  $name  — $tail"
	else
		fail=$((fail+1)); failed="$failed $name"
		say "FAIL  $name (exit $code)  — $tail"
	fi
}

skip_one() {                    # name, why
	skip=$((skip+1)); skipped="$skipped $1"
	say "SKIP  $1  — $2"
}

gateway_up()   { ss -ltn 2>/dev/null | grep -q ':9002 '; }
wait_gateway() {                # tries
	local i=0
	while [ $i -lt "${1:-20}" ]; do
		curl -sf -m 2 http://127.0.0.1:9002/api/health >/dev/null 2>&1 && return 0
		i=$((i+1)); sleep 1
	done
	return 1
}
# Where the gateway is run FROM decides which app.jdat it reads. `gateway/` is
# the shipped config; `dev/devgw/` is a generated copy carrying `dev_insecure`
# on the mail routes so the local IMAP/SMTP fixtures can be reached at all.
GW_CWD=gateway
start_gateway() {
	[ -x "$GW_BIN" ] || return 1
	( cd "$GW_CWD" && APP_MODE=sandbox nohup "$ROOT/$GW_BIN" >"$SCRATCH/suite-gw.log" 2>&1 & )
	wait_gateway 25
}
stop_gateway() {
	pkill -f "$(basename "$GW_BIN")" >/dev/null 2>&1
	local i=0
	while gateway_up && [ $i -lt 15 ]; do sleep 1; i=$((i+1)); done
	! gateway_up
}

# ── Which verifiers to run, and in which phase ──────────────────────────
if [ $# -gt 0 ]; then ALL="$*"; else ALL=$(cd dev && ls verify_*.mjs | sed 's/\.mjs$//'); fi
PHASE1=""; PHASE2=""
for name in $ALL; do
	case " $NEEDS_GATEWAY " in
		*" $name "*) PHASE2="$PHASE2 $name" ;;
		*)           PHASE1="$PHASE1 $name" ;;
	esac
done

# ── Phase 1: :9002 clear ────────────────────────────────────────────────
if [ -n "$PHASE1" ]; then
	if gateway_up; then
		say "Stopping the gateway on :9002 — phase 1 needs it clear."
		stop_gateway || { say "Could not free :9002; stop it by hand and re-run."; exit 2; }
	fi
	say "── Phase 1 (no gateway):$PHASE1"
	for name in $PHASE1; do run_one "$name"; done
fi

# ── Phase 2: a gateway, and what the entitled tests need ────────────────
if [ -n "$PHASE2" ]; then
	say ""
	# compose and mailfolders talk to loopback mail fixtures, which the shipped config refuses.
	# Run the gateway from the generated dev CWD for the whole of phase 2: it is
	# the same binary over the same store, one flag different.
	case " $PHASE2 " in *" verify_compose "*|*" verify_mailfolders "*)
		if bash dev/devgw.sh >/dev/null 2>&1; then GW_CWD=dev/devgw; fi ;;
	esac
	if ! start_gateway; then
		for name in $PHASE2; do
			skip_one "$name" "no gateway on :9002 (build it: cd gateway && cargo build --release)"
		done
	else
		say "── Phase 2 (gateway up on :9002):$PHASE2"

		# The two entitled tests share one fixed profile, so one grant serves both.
		WANT_GRANT=no; GRANTED=no
		for name in $PHASE2; do
			case " $NEEDS_GRANT " in *" $name "*) WANT_GRANT=yes ;; esac
		done
		if [ "$WANT_GRANT" = yes ] && [ -x "$CTL_BIN" ]; then
			ACCT=$(node dev/provision.mjs "$COMPOSE_PROFILE" compose 2>/dev/null | tail -1)
			if [ -n "$ACCT" ]; then
				# daimond_ctl takes the store's exclusive lock, so the gateway
				# stands down for the grant and comes back after it.
				stop_gateway
				( cd "$GW_CWD" && "$ROOT/$CTL_BIN" grant "$ACCT" email  >/dev/null 2>&1 )
				( cd "$GW_CWD" && "$ROOT/$CTL_BIN" topup "$ACCT" 5000   >/dev/null 2>&1 )
				if start_gateway; then
					# Pro as well: Email, sync and cloud storage are all behind it
					# since 2026-07-24, so without it the app raises the "Sync is
					# part of Pro" dialog OVER the page mid-run and the clicks that
					# follow land on the dialog. It is bought the way a user buys
					# it -- a signed checkout event the gateway verifies.
					PROST=$(node dev/pro.mjs "$ACCT" "$ROOT/gateway" 2>/dev/null | tail -1)
					GRANTED=yes
				fi
				say "   provisioned $ACCT (email unlock + 5000 credits + Pro webhook ${PROST:-?}): $GRANTED"
			else
				say "   could not read the compose profile's account id — the entitled tests will skip"
			fi
		fi

		# compose and mailfolders need the mail fixtures: an IMAP server to read,
		# and a submission stand-in to catch what is sent.
		MAIL=no
		case " $PHASE2 " in *" verify_compose "*|*" verify_mailfolders "*)
			if [ -x "$IMAP_FIXTURE" ]; then
				nohup "$IMAP_FIXTURE" >"$SCRATCH/suite-imap.log" 2>&1 &
				nohup node "$SMTPD"   >"$SCRATCH/suite-smtpd.log" 2>&1 &
				sleep 2
				ss -ltn 2>/dev/null | grep -q ':1143 ' \
					&& ss -ltn 2>/dev/null | grep -q ':1587 ' && MAIL=yes
			fi
			say "   mail fixtures on :1143/:1587: $MAIL"
		;; esac

		for name in $PHASE2; do
			case " $NEEDS_GRANT " in
				*" $name "*) [ "$GRANTED" = yes ] || { skip_one "$name" "no entitled account (see above)"; continue; } ;;
			esac
			if { [ "$name" = verify_compose ] || [ "$name" = verify_mailfolders ]; } && [ "$MAIL" != yes ]; then
				skip_one "$name" "mail fixtures absent (build fe2o3's imap_test_server example)"
				continue
			fi
			run_one "$name"
		done

		pkill -f "$(basename "$IMAP_FIXTURE")" >/dev/null 2>&1
		pkill -f "$(basename "$SMTPD")"        >/dev/null 2>&1
		stop_gateway
	fi
fi

say ""
say "SUITE: $pass passed, $fail failed, $skip skipped."
[ -n "$failed" ]  && say "  failed: $failed"
[ -n "$skipped" ] && say "  skipped:$skipped"
[ $fail -eq 0 ]
