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
# Needs `dev/serve.mjs` (`DAIMOND_PORT`, default 8777) and `dev/mockllm.mjs`
# (`DAIMOND_MOCK_PORT`, default 9099) -- without the mock every `@tool` call quietly
# does nothing. Start those yourself; this script does not, so a suite run never
# kills a server you were using.  `bash dev/world.sh N --env` prints a matching set,
# and $DAIMOND_SCRATCH below then keeps this run's logs and profiles to itself.
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

# Which verifiers need a gateway ALREADY up (group C) -- ASKED OF THE FILES.
#
# This was a hand-kept list of thirteen names, and a hand-kept list is the thing
# that goes stale: `verify_look` and `verify_wakerearm` each STATE the
# requirement in their own header ("Needs dev/serve.mjs (DAIMOND_PORT) AND the
# gateway on :9002") and neither was ever added to it. Both landed on 2026-08-12
# and both have failed identically in every gate since -- `webhook 0, pro=false`,
# which is a fetch that never connected -- while every browser-only check in
# verify_look passed. Two days of red that said nothing about the app. The same
# accident had already cost verify_gwretry and verify_sessionrenew, which exit 0
# with a SKIP line when :9002 is clear and so were reported as PASSING for every
# run in which they refused to do anything at all.
#
# So it is derived, on the same reasoning `wants_gateway` already applies below:
# ask the verifier, not a list somebody has to remember to edit. What is asked is
# the header comment, because that is where every one of these declares itself,
# and the answer is checked in two directions:
#
#   IT MUST ASK FOR ONE. A sentence in the header naming the gateway together
#   with the thing that has to be there -- :9002, or the `dev_insecure` mail
#   config phase 2 generates. A mention is not a requirement: "No gateway on
#   :9002" and "It does NOT need ... the gateway on :9002" are NINE other files
#   saying the opposite, and are excluded by the words that make them opposite.
#
#   AND IT MUST NOT BRING ITS OWN. Group B spawns a gateway and REFUSES to run
#   with one already up, so it belongs in phase 1. `procLog` is gwbin's "I am
#   about to spawn a server and need somewhere to log it" helper, and importing
#   it is what tells the two groups apart -- verify_passkey_blob talks to a live
#   gateway and imports SUITE_GW_LOG instead, saying in its own comment that it
#   "starts no gateway of its own".
#
# Checked against the list it replaces (2026-08-14): it reproduces all thirteen
# names exactly, and adds exactly verify_look and verify_wakerearm. The phase
# lines this script prints are the audit -- every run says which verifiers it put
# in which phase, which is what a list in a file never did.
needs_live_gateway() {          # name -> 0 if it needs a gateway ALREADY up
	local f="dev/$1.mjs"
	[ -f "$f" ] || return 1
	grep -q 'procLog(' "$f" && return 1           # it starts one of its own
	awk '
		/^[[:space:]]*\/\// { sub(/^[[:space:]]*\/\/[[:space:]]?/, ""); h = h " " $0; next }
		/^[[:space:]]*$/    { next }
		{ exit }                                  # the header ends at the first code
		END {
			n = split(h, s, /\. /)
			for (i = 1; i <= n; i++) {
				t = tolower(s[i])
				if (t !~ /gateway/)             continue
				if (t !~ /:9002|dev_insecure/)  continue
				if (t ~ /no gateway|not need|free :9002|starts its own|start its own|spawns/) continue
				exit 0
			}
			exit 1
		}
	' "$f"
}
# Of those, the two that also need an entitled account (and, for compose, mail).
# Still a list: an entitlement is not something a header declares, and these two
# are named again by the provisioning block below in any case.
NEEDS_GRANT="verify_compose verify_mailfolders"

# Verifiers that need something this suite cannot invent, and that say so by
# exiting 2 rather than pretending. `verify_droots_real` proves the Diamond
# migration against a backup exported from a REAL install: without one it prints
# "SKIPPED -- and this is NOT a pass" and exits 2, deliberately, so that nobody
# can read a suite line as a claim about a corpus that was never opened. Point
# DAIMOND_BACKUP at such a file and it runs; leave it unset and it is skipped
# here, loudly, and never counted as a pass.
#
#   DAIMOND_BACKUP=~/Downloads/daimond-backup-2026-08-01.json bash dev/run_all.sh
args_for() {
	case "$1" in
		verify_droots_real) echo "--backup $DAIMOND_BACKUP" ;;
		*)                  echo "" ;;
	esac
}
needs_input() {                 # name -> prints why it cannot run, or nothing
	case "$1" in
		verify_droots_real)
			[ -n "${DAIMOND_BACKUP:-}" ] || {
				echo "needs a backup from a real install: DAIMOND_BACKUP=<file.json> (it exits 2 rather than pass)"
				return
			}
			[ -f "$DAIMOND_BACKUP" ] || echo "DAIMOND_BACKUP=$DAIMOND_BACKUP is not a file" ;;
		# ASKED OF THE VERIFIER, not answered here. `verify_conformance` measures a
		# LIVE Oregami forge, and where that forge is meant to be is resolved from
		# ORE_FORGE or gateway/app.jdat by the same lines that will do the asking.
		# Deriving the address a second time in this file is the staleness this
		# script's header spends four paragraphs arguing against, so `--why-not`
		# answers instead: silence if it can run, one sentence if it cannot.
		#
		# It was a FAIL on the 2026-08-17 gate -- one line among fifty-six reds,
		# indistinguishable from a forge that had answered wrongly, when no forge was
		# running at all. Pointing it at `dev/mock_forge.mjs` was the other way out
		# and is wrong: the mock was written FROM the contract, so a conformance run
		# against it proves the contract agrees with itself. That file's own header
		# names this -- "31 passed" was a true sentence about the wrong repository --
		# and a suite that answered it with a second wrong repository would have
		# learned nothing from the day that produced the file.
		verify_conformance)
			node dev/verify_conformance.mjs --why-not 2>/dev/null ;;
	esac
}

# The extension flows load a real unpacked extension, which Chromium will only
# do HEADED -- and a headed browser needs a display. Never the user's: an X
# forward that has gone quiet (a sleeping laptop at the other end) fails these
# with "Missing X server", and a live one throws windows in their face. Xvfb
# gives them a display of their own.
# verify_handreal is here too, and is the only one that also builds a Rust binary
# and runs a real `cargo test` through the browser -- see its own header.
#
# verify_scope, verify_kitfence, verify_pty, verify_ptyedge and verify_sweep_mobile
# were MISSING from this list and each asks for a real window -- the first four
# load an unpacked extension, the last drives device emulation. Run without a
# display they fail on "Missing X server", which reads on the summary as the
# fence being broken rather than the suite being wrong about how to start them;
# run WITH the user's display they throw windows into whatever they were doing.
HEADED="verify_ext verify_grant verify_hand verify_ext_i18n verify_handrun verify_handreal \
verify_scope verify_kitfence verify_pty verify_ptyedge verify_sweep_mobile"
# verify_style walks 3 themes x 3 device sizes and is simply slower than the rest.
# verify_handreal builds the hand from source before it can drive it, and a cold
# release build of the hand is minutes rather than seconds. verify_ptyedge builds
# a whole wasm package per property it proves against broken code.
#
# verify_reversible and verify_sweep_desktop were never listed here, so both drew
# the 180s default and both were killed by it -- reported as exit 124 and carried
# for days as unexplained reds. Neither is broken: reversible passes in 209s
# (measured 2026-08-07) because it opens every control on every surface in its own
# isolated session, and sweep_desktop walks every skin against both spacings, the
# same shape of matrix verify_sweep_mobile already gets 900s for. A budget is a
# claim about how long a thing takes; an unlisted verifier makes that claim by
# accident.
slow_for() {
	case "$1" in
		verify_style)                     echo 600 ;;
		verify_scope|verify_kitfence)     echo 600 ;;
		verify_reversible)                echo 420 ;;
		verify_sweep_mobile)              echo 900 ;;
		verify_sweep_desktop)             echo 900 ;;
		verify_handreal)                  echo 900 ;;
		verify_ptyedge)                   echo 2400 ;;
		# Two devices, a gateway and a full parcel round trip each way. It has
		# been over the default for a while and nobody noticed, because a killed
		# verifier does not say it was killed: `timeout` cuts the browser out
		# from under it and Playwright reports "Target page, context or browser
		# has been closed" as six ordinary-looking sync failures. The 2026-08-10
		# gate spent its whole red budget on those six, all of which were this.
		verify_sync)                      echo 1200 ;;
		# Sixteen dialogs at four skin/theme/width cells, and it was killed by the
		# 180s default on the 2026-08-11 gate -- the same accident as the two above,
		# read as an unexplained exit 124. MEASURED at 250s on a quiet box
		# (2026-08-12): 11s to seed the rail, then 41s, 59s, 58s and 82s for the
		# four cells. Most of that is not work but PROOF OF ABSENCE: 19 of the 64
		# dialog attempts do not open at their width -- Fold with no active chat,
		# the tile cogs on a phone -- and each costs a 10s selector timeout to
		# establish, the phone cell alone spending 8 of them. So 480: not quite
		# twice the measurement, on the same reasoning as verify_reversible, and
		# those 10s waits are exactly what stretches when the box is busy.
		verify_raildialogs)               echo 480 ;;
		# Eleven palettes, each opened, focused through and measured for ink. Killed
		# by the 180s default and reported as exit 124 -- it dies part way through
		# the fifth palette, which reads on a summary as the app's focus ring being
		# broken. MEASURED three times to completion in a world: 326s and ~330s
		# (2026-08-13, the second ALL PASS) and 379s (2026-08-14, world 18, which
		# found one real ink shortfall in the dark palettes). So 600, near twice the
		# measurement, on the same reasoning as verify_reversible and
		# verify_raildialogs -- and the spread across those three is why not 400.
		verify_focus_and_ink)             echo 600 ;;
		# Two devices, an account look pushed each way, and a THIRD sign-in on the
		# second device to prove the migration case. It has no measurement to be
		# sized by -- it has never once been run to completion, because it was left
		# out of the gateway group above and so has spent every gate failing on
		# fetches that never connected, then being killed at 180s. Sized by its own
		# declared waits instead, which are what it spends when the answer does not
		# come: four 25s pushes, a 30s and two 20s settles, four 20s readiness waits
		# and two browser launches -- a little over 300s if every one of them runs
		# long. 600 is twice that, and the first run under a real gateway is the
		# measurement this should be replaced by.
		verify_look)                      echo 600 ;;
		# Parks a request at the gateway for three quarters of a minute, twice, and
		# the whole point is that the second park is HELD OPEN. Its own waits come to
		# about 170s before two browser launches, so the 180s default would kill it
		# the first time it ever reaches a gateway (see verify_look above: it has
		# never run either). Unmeasured, for the same reason.
		verify_wakerearm)                 echo 420 ;;
		*)                                echo 180 ;;
	esac
}

# Can this verifier report a failure AT ALL?
#
# The gate decided PASS on the exit code and nothing else, and six verifiers had no
# way of setting one: verify_backup, verify_writeguard, verify_viewer,
# verify_localpage, verify_normalwrite and verify_toolmemory each printed
# `SOMETHING: false` and exited 0. The summary quotes the LAST line of output, and
# for three of them that line was `errors: [...]`, so the printed red never even
# reached the summary. A PRINTED RED WAS A GATE GREEN, for months, over the
# stale-write guard and over whether a backup restores a user's files.
#
# Asked of the SOURCE, because it is the only question with a certain answer: a file
# containing no `process.exit`, no `throw` and no assertion cannot fail whatever it
# prints, and no amount of reading its output will tell you that. It is a floor and
# not a ceiling -- a file that counts reds and then exits 0 anyway still gets past
# this -- but it is exact in the direction that matters: nothing healthy is ever
# flagged, because a healthy verifier has to be able to say no somehow.
#
# The verifier is still RUN and its output still kept: the reason for the red is that
# it asserts nothing, and that reason is worth reading beside whatever it printed.
can_fail() {                    # name -> 0 if it can express a failure
	grep -qE 'process\.exit|process\.exitCode|throw new |\bassert[.(]' "dev/$1.mjs" 2>/dev/null
}

pass=0; fail=0; skip=0; flight=0; failed=""; skipped=""; inflight=""

# ── Verifiers whose failures are KNOWN, ASSIGNED and IN FLIGHT ──────────
#
# One entry per line: the verifier, HOW MANY of its checks are expected to fail,
# and who owns the fixes. Nothing else may be in here, and nothing goes in without
# a name attached to the work.
#
# THE COUNT IS WHAT RETIRES THE ENTRY, and it is the only reason this list is
# allowed to exist at all. This file's own header argues against hand-kept lists
# because they go stale silently -- and every mechanism above it therefore asks the
# verifier instead. This one cannot: whether a red is known work in flight or a
# regression is a fact about a decision somebody made this week, not a property a
# verifier can declare about itself, and a marker living inside the verifier would
# be one an author could quietly widen to keep their own suite green.
#
# So the staleness is closed from the other end. A declared verifier whose failing
# count does not EXACTLY match is a hard FAIL, in both directions:
#
#   MORE failing than declared -> a new defect has landed behind the known ones,
#                                 and the entry must not absorb it;
#   FEWER failing than declared -> fixes have landed, so the entry is now hiding
#                                 nothing and must shrink or go.
#
# That makes an entry self-retiring: the gate goes red the moment the work it
# describes is done, which is the correct pressure and the opposite of the usual
# failure mode. An entry can only stay quiet while it is telling the exact truth.
#
# It is NOT a pass. It is counted apart, printed apart, and named in the summary,
# because a suite in which a known red and a green look the same has given up the
# only thing it was for.
IN_FLIGHT="
"

# How many failures are declared in flight for a verifier, or '' if none are.
declared_flight() {             # name -> prints the count, or nothing
	echo "$IN_FLIGHT" | awk -v n="$1" '$1 == n { print $2; exit }'
}

# The failing count a verifier reported about ITSELF, from its own summary line.
#
# Read from the verifier's output rather than from its exit code, because an exit
# code is one bit and the whole point here is the number. A verifier that prints no
# such line cannot be declared in flight, and `run_one` fails it rather than
# guessing -- an unparseable declaration is an unchecked one.
reported_failures() {           # log file -> prints the count, or nothing
	grep -oE '[0-9]+ failed' "$1" | tail -1 | grep -oE '^[0-9]+'
}
: > "$LOG"
# Truncated ONCE here, appended to thereafter: phase 2 stops and restarts the
# gateway to take the store lock for a grant, and what the first process said on
# its way out is exactly the part a `>` on each start would erase.  Named
# SUITE_GW_LOG in dev/gwbin.mjs, which is where the verifier that starts no
# gateway of its own goes looking for it.
: > "$SCRATCH/suite-gw.log"
say() { echo "$1" | tee -a "$LOG"; }

run_one() {
	local name=$1 out code tail why extra
	# A verifier that cannot be given what it needs is not run at all. It is NOT
	# run and then forgiven: `verify_droots_real` exits 2 on purpose in that
	# state, and a suite that turned an exit 2 into a pass would be the same
	# defect it exists to prevent.
	why=$(needs_input "$name")
	if [ -n "$why" ]; then skip_one "$name" "$why"; return; fi
	extra=$(args_for "$name")
	[ "$name" = "verify_durability" ] && rm -rf "$SCRATCH/durability-profile"
	case " $HEADED " in
		*" $name "*)
			if command -v xvfb-run >/dev/null 2>&1; then
				out=$(timeout "$(slow_for "$name")" xvfb-run -a -s "-screen 0 1400x900x24" \
					node "dev/$name.mjs" $extra 2>&1)
				code=$?
			else
				skip_one "$name" "needs a headed browser and xvfb-run is not installed"
				return
			fi ;;
		*)
			out=$(timeout "$(slow_for "$name")" node "dev/$name.mjs" $extra 2>&1)
			code=$? ;;
	esac
	# Keep the WHOLE output, not just the line the summary quotes.
	#
	# Only the last line survived here, so diagnosing any red meant running the
	# verifier again by hand -- and for the ones that need a gateway, a grant and
	# mail fixtures, that means reproducing the provisioning this script already
	# did. Every red chased in this session cost a second full run for want of a
	# file that had already been captured and thrown away.
	mkdir -p "$SCRATCH/out"
	printf '%s\n' "$out" > "$SCRATCH/out/$name.log"
	tail=$(echo "$out" | grep -vE "Skipping host" | tail -1)
	# Two spellings, because both are in the tree: `SKIPPED: <why>` and
	# `SKIP <name> — <why>`. Only the first was recognised, so verify_gwretry,
	# verify_sessionrenew and verify_chunkgw -- each of which printed the second
	# and then exited 0 -- were counted as PASSES for runs in which they had
	# refused to do anything at all. verify_chunkgw can no longer skip: its
	# "no binary built" branch was unreachable once gwbin.mjs began refusing
	# that case outright, and it has gone.
	if echo "$out" | grep -qE '^SKIPPED:|^SKIP '; then
		skip=$((skip+1)); skipped="$skipped $name"
		say "SKIP  $name  — $(echo "$out" | grep -E '^SKIPPED:|^SKIP ' | head -1)"
	elif [ $code -eq 0 ] && ! can_fail "$name"; then
		# Green, and worth nothing: see `can_fail`. Counted as a failure because a
		# file that cannot say no is not evidence of anything, and a suite that
		# reports it as a pass is making a claim on its behalf that it never made.
		fail=$((fail+1)); failed="$failed $name"
		say "FAIL  $name (asserts nothing)  — no process.exit, no throw, no assertion: it exits 0"
		say "      whatever it prints, so its green line means only that it ran. Last line was: $tail"
		say "      full output: $SCRATCH/out/$name.log"
	elif [ $code -eq 0 ]; then
		# A verifier declared in flight that has gone GREEN is an entry to delete,
		# and it is said here rather than at the end: the work is done and the
		# declaration is now a lie about the tree in the quiet direction.
		local want_ok; want_ok=$(declared_flight "$name")
		if [ -n "$want_ok" ]; then
			fail=$((fail+1)); failed="$failed $name"
			say "FAIL  $name  — IN_FLIGHT declares $want_ok failing and it now passes CLEAN."
			say "      The fixes have landed. Delete its line from IN_FLIGHT in dev/run_all.sh;"
			say "      until then this red is the entry, not the verifier."
		else
			pass=$((pass+1)); say "PASS  $name  — $tail"
		fi
	else
		local want; want=$(declared_flight "$name")
		local got;  got=$(reported_failures "$SCRATCH/out/$name.log")
		if [ -z "$want" ]; then
			fail=$((fail+1)); failed="$failed $name"
			say "FAIL  $name (exit $code)  — $tail"
			say "      full output: $SCRATCH/out/$name.log"
		elif [ -z "$got" ]; then
			# Declared, and the declaration cannot be checked. That is worse than an
			# undeclared red, because it is a red somebody has arranged to be quiet
			# about on the strength of a number nobody can read.
			fail=$((fail+1)); failed="$failed $name"
			say "FAIL  $name (exit $code)  — declared in flight with $want failing, but it printed"
			say "      no '<n> failed' line, so the declaration cannot be checked. A red that is"
			say "      excused by an unreadable number is not excused."
			say "      full output: $SCRATCH/out/$name.log"
		elif [ "$got" != "$want" ]; then
			fail=$((fail+1)); failed="$failed $name"
			if [ "$got" -gt "$want" ]; then
				say "FAIL  $name (exit $code)  — $got failing, but only $want are declared in flight."
				say "      $((got - want)) more than the known work. A new defect has landed behind it,"
				say "      and the IN_FLIGHT entry must not absorb it."
			else
				say "FAIL  $name (exit $code)  — $got failing, and $want are declared in flight."
				say "      $((want - got)) of them are fixed. Shrink the IN_FLIGHT entry in"
				say "      dev/run_all.sh to $got, or delete it."
			fi
			say "      full output: $SCRATCH/out/$name.log"
		else
			flight=$((flight+1)); inflight="$inflight $name"
			say "FLIGHT $name  — $got failing, exactly the $want declared in flight. NOT A PASS."
			say "      $(echo "$IN_FLIGHT" | awk -v n="$name" '$1 == n { $1=""; $2=""; sub(/^  /, ""); print }')"
			say "      full output: $SCRATCH/out/$name.log"
		fi
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
	( cd "$GW_CWD" && APP_MODE=sandbox nohup "$ROOT/$GW_BIN" >>"$SCRATCH/suite-gw.log" 2>&1 & )
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
	if needs_live_gateway "$name"; then PHASE2="$PHASE2 $name"; else PHASE1="$PHASE1 $name"; fi
done

# ── The gateway binary, built once for the whole run ────────────────────
#
# `dev/gwbin.mjs` refuses to measure a gateway older than the code under test,
# and it is right to: on 2026-08-10 a three-day-old binary answered "Unknown
# admin view 'secrets'" and that read as a console defect rather than a stale
# build.  But an mtime is a coarse authority.  Another agent touching any of the
# twelve crates the gateway path-depends on under rust/fe2o3 voids the run, and
# that happened mid-gate the same day.  Cargo knows precisely whether a rebuild
# is needed -- including whether a new module is even referenced -- so ask it,
# once, and leave the mtime guard as what it should be: a cheap net for someone
# running a single verifier by hand.
#
# Before PHASE 1, not merely before phase 2.  Nine of the ten verifiers that
# spawn a gateway are in phase 1; only verify_passkey_blob is in phase 2, and
# start_gateway needs $GW_BIN there in any case.  ONCE, so that every verifier
# in the run measures the same artefact.
#
# CARGO_TARGET_DIR is unset on purpose.  Agents point it at their own slot
# directory, which is what leaves gateway/target/release/ behind in the first
# place, and that path is the one the verifiers spawn.
wants_gateway() {              # does anything in this run touch the binary?
	[ -n "$PHASE2" ] && return 0
	# Asked of the verifiers themselves rather than of a list kept here: a list
	# of names is the thing that goes stale, as HEADED and NEEDS_GATEWAY both
	# have, and each time it did the suite drew a wrong conclusion quietly.
	local n
	for n in $ALL; do
		grep -q 'gwbin\.mjs\|daimond_gateway' "dev/$n.mjs" 2>/dev/null && return 0
	done
	return 1
}
if wants_gateway; then
	say "── Building the gateway, so every verifier measures one artefact ──"
	if ( cd gateway && env -u CARGO_TARGET_DIR cargo build --release ) >>"$LOG" 2>&1; then
		[ -f "$GW_BIN" ] && say "   $GW_BIN  ($(date -r "$GW_BIN" '+%Y-%m-%d %H:%M:%S'))"
	else
		say "FATAL the gateway did not build, so nothing below could be measured against"
		say "      the current source: every verifier that spawns one would either run a"
		say "      stale binary or refuse outright.  The cargo output is at the end of $LOG"
		exit 2
	fi
fi

# ── Phase 0: the static checks, which need no browser and take a second ─────
#
# Neither of these had ever run under this suite, and on 2026-08-11 the second one
# would have caught 39 English fallbacks left behind by a catalogue rewrite -- text
# that ships in all eight locales whenever the catalogue fails to load, and that
# nothing else looks at. They cost about a second between them, so they run first:
# a red here explains reds later, and a suite that finds it after two hours of
# browsers has learnt the same thing far too late.
#
# A named subset is honoured, so `run_all.sh verify_tags` still means just that.
static_one() {                  # name, command…
	local name="$1"; shift
	local out code
	out=$("$@" 2>&1); code=$?
	mkdir -p "$SCRATCH/out"
	printf '%s\n' "$out" > "$SCRATCH/out/$name.log"
	if [ $code -eq 0 ]; then
		pass=$((pass+1)); say "PASS  $name  — $(echo "$out" | tail -1)"
	else
		fail=$((fail+1)); failed="$failed $name"
		say "FAIL  $name (exit $code)  — $(echo "$out" | tail -1)"
		say "      full output: $SCRATCH/out/$name.log"
	fi
}
# `--frozen`, because a suite ASSERTS and does not write. Without it `i18ncheck`
# rewrites `dev/results/i18n-coverage.json` as it runs, and under `dev/gate.sh`
# it would rewrite the copy in the gate's own worktree -- a file nobody reads,
# leaving the committed map exactly as stale as it was while the run went green.
# The map is what tells a runtime reporter a by-design hole from a real one, so a
# stale one retires findings. Frozen, it fails and says which half moved.
#
# THE COST, so nobody meets it as a surprise: any edit that adds or removes a
# `t()` call site moves a count in the map, and the gate then goes red until
# `node dev/i18ncheck.mjs` is run in the main tree and the map committed. That is
# one command, it is named in the failure, and it is the price of the map being
# true rather than merely present.
if [ $# -eq 0 ]; then
	say "── Phase 0 (static, no browser)"
	static_one i18ncheck    node dev/i18ncheck.mjs --frozen
	static_one i18nfallback node dev/i18nfallback.mjs --quiet
fi

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
		# Said rather than swallowed: without the generated CWD the mail routes
		# refuse loopback, and compose then fails for a reason this script chose.
		if bash dev/devgw.sh >>"$SCRATCH/suite-devgw.log" 2>&1; then
			GW_CWD=dev/devgw
		else
			say "   dev/devgw.sh failed — running from $GW_CWD, whose config refuses the"
			say "   loopback mail fixtures: $SCRATCH/suite-devgw.log"
		fi ;;
	esac
	if ! start_gateway; then
		for name in $PHASE2; do
			# Not "build it" any more: the build happened above, so a gateway that
			# will not start has a reason, and the reason is in its own log.
			skip_one "$name" "the gateway would not start on :9002 — $SCRATCH/suite-gw.log"
		done
	else
		say "── Phase 2 (gateway up on :9002):$PHASE2"

		# The two entitled tests share one fixed profile, so one grant serves both.
		WANT_GRANT=no; GRANTED=no
		for name in $PHASE2; do
			case " $NEEDS_GRANT " in *" $name "*) WANT_GRANT=yes ;; esac
		done
		if [ "$WANT_GRANT" = yes ] && [ -x "$CTL_BIN" ]; then
			# All of this used to go to /dev/null, exit codes included.  A grant
			# that failed silently is worse than no grant at all: GRANTED stayed
			# yes, the three entitled verifiers ran without the entitlement, and
			# went red for a reason this script already knew and had discarded.
			PROV_LOG=$SCRATCH/suite-provision.log
			: > "$PROV_LOG"
			ACCT=$(node dev/provision.mjs "$COMPOSE_PROFILE" compose 2>>"$PROV_LOG" | tail -1)
			if [ -n "$ACCT" ]; then
				# The gateway stands down for the grant, and NOT because of a
				# lock: there is no cross-process locking in o3db. One was added
				# to fe2o3 on 2026-08-16 and reverted three hours later, the
				# diagnosis behind it having been wrong -- data files are opened
				# for append and a live file number is now claimed with
				# `create_new`, so two processes writing one store is the design
				# rather than a hazard.
				#
				# The real reason is VISIBILITY. o3db holds its key index in
				# memory, per process, built when the store is opened, and a
				# lookup that misses it answers "not found" without going to disk
				# (`bot_cache.rs::read`). So an entitlement `daimond_ctl` appends
				# underneath a running gateway is in the files and in nobody's
				# index: every `has_entitlement` in the live process would answer
				# no, exactly as though the grant had failed, and the entitled
				# verifiers would go red for a reason that is not theirs.
				# Restarting is what rebuilds the index, so it is how the grant
				# reaches the gateway.
				stop_gateway
				GRANT_OK=yes
				( cd "$GW_CWD" && "$ROOT/$CTL_BIN" grant "$ACCT" email ) >>"$PROV_LOG" 2>&1 || GRANT_OK=no
				( cd "$GW_CWD" && "$ROOT/$CTL_BIN" topup "$ACCT" 5000  ) >>"$PROV_LOG" 2>&1 || GRANT_OK=no
				# The gateway comes back either way -- the rest of phase 2 needs
				# it whether or not the grant landed.
				if start_gateway && [ "$GRANT_OK" = yes ]; then
					# Pro as well: Email, sync and cloud storage are all behind it
					# since 2026-07-24, so without it the app raises the "Sync is
					# part of Pro" dialog OVER the page mid-run and the clicks that
					# follow land on the dialog. It is bought the way a user buys
					# it -- a signed checkout event the gateway verifies.
					PROST=$(node dev/pro.mjs "$ACCT" "$ROOT/gateway" 2>>"$PROV_LOG" | tail -1)
					GRANTED=yes
				fi
				say "   provisioned $ACCT (email unlock + 5000 credits + Pro webhook ${PROST:-?}): $GRANTED"
				[ "$GRANTED" = yes ] || say "      what went wrong: $PROV_LOG"
			else
				say "   could not read the compose profile's account id — the entitled tests will skip"
				say "      what went wrong: $PROV_LOG"
			fi
		elif [ "$WANT_GRANT" = yes ]; then
			# Said, because the skip below reads "no entitled account (see above)"
			# and nothing above said anything at all when this was the reason.
			say "   $CTL_BIN is not there or not executable, so no grant can be made"
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
# In flight is named on the SUITE line itself, not tucked underneath it. A reader
# who takes in one line has to see that some of this run was red on purpose;
# putting the figure only in a detail line below is how "42 passed" comes to stand
# for a suite that never went green.
if [ $flight -gt 0 ]; then
	say "SUITE: $pass passed, $fail failed, $skip skipped, $flight IN FLIGHT (red, known, assigned)."
else
	say "SUITE: $pass passed, $fail failed, $skip skipped."
fi
[ -n "$failed" ]   && say "  failed: $failed"
[ -n "$skipped" ]  && say "  skipped:$skipped"
[ -n "$inflight" ] && {
	say "  in flight:$inflight"
	say "  These are NOT passes. Each is red by declaration in dev/run_all.sh's IN_FLIGHT,"
	say "  with the exact count of its failures; the entry fails the suite the moment that"
	say "  count changes in either direction, so none of them can outlive its defects."
}
[ $fail -eq 0 ]
