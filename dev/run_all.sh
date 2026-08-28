#!/bin/bash
# run_all.sh -- run every functional verifier, each in the environment it needs.
#
# The verifiers do NOT all want the same world, and a flat loop over them cannot
# be right for all three groups at once:
#
#   A. Most want NO gateway at all. `verify_credits` fetch-stubs the gateway on
#      purpose; and with a real one up, a non-Pro test account gets a 402 from
#      sync, which raises the "Sync is part of Pro" dialog OVER the app, so every
#      later click in that test times out against it.
#   B. Some start their OWN gateway and REFUSE to run if one is already there,
#      because they pin an owner in configuration (operators, releases, logout).
#      They need the port free, same as A.
#   C. A few need a gateway ALREADY running, and two of those need an account
#      holding the `email` unlock and some credits (tools, compose), plus the
#      mail fixtures (compose).
#
# So: phase 1 runs A and B with the gateway port clear; phase 2 brings a gateway
# up, grants what C needs, and runs C. Anything that cannot be provisioned SKIPS
# loudly -- a verifier that silently did not run is worse than one that failed.
#
# ALL THREE PORTS ARE THIS RUN'S OWN. They were :9002, :1143 and :1587, one
# instance of each on the machine, and that is what made "one gate at a time" a
# rule rather than a preference. `dev/world.sh` gives each world its own
# (9700 + N, 1143 + N, 1587 + N) and exports them; nothing here derives a port,
# it reads one.
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
# THE GATEWAY'S PORT IS THIS RUN'S, NOT THE FLEET'S.
#
# It was the literal 9002 in five places, and `dev/world.sh` says why that is not
# good enough any more: every world-numbered port is a lane's own, but the gateway,
# the IMAP and SMTP fixtures and the forge are "fixed and shared by every world".
# In a fleet of one that is a rule; in a fleet of six it is a queue, and a lane that
# wants the two mail verifiers cannot have them for as long as anybody else holds
# the port.
#
# `serve.mjs` has always read `DAIMOND_GW_PORT` (default 9002) to decide where to
# proxy `/api`, so the app side needed nothing. What was missing was the other two
# halves: the gateway's own `listen_port`, which `dev/devgw.sh` now rewrites, and
# this script's health checks, which asked :9002 whatever the run was told.
GW_PORT=${DAIMOND_GW_PORT:-9002}
export DAIMOND_GW_PORT=$GW_PORT
# The mail fixtures, on the same reasoning and for the same reason: one IMAP
# server and one submission stand-in on the machine meant one lane could run
# verify_compose at a time, and the other lanes' runs of it SKIPPED with
# "mail fixtures absent" -- which reads as a missing build, not as a queue.
IMAP_PORT=${DAIMOND_IMAP_PORT:-1143}
SMTP_PORT=${SMTPD_PORT:-1587}
export DAIMOND_IMAP_PORT=$IMAP_PORT
export SMTPD_PORT=$SMTP_PORT
# An entitled identity's browser profile is $SCRATCH/<identity>-profile; see ident_for.
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
				# The port token, in either spelling. `:9002` is what every header
				# in the tree says today; `daimond_gw_port` is what a header
				# written since the gateway became per-world should say, and
				# accepting it now means the first file to be reworded does not
				# silently change phase.
				if (t !~ /:9002|daimond_gw_port|dev_insecure/)  continue
				if (t ~ /no gateway|not need|free :9002|starts its own|start its own|spawns/) continue
				exit 0
			}
			exit 1
		}
	' "$f"
}
# Of those, the ones that also need an entitled account (and, for compose, mail).
# Still a list: an entitlement is not something a header declares, and these are
# named again by the provisioning block below in any case.
#
# `verify_sync` JOINED THIS LIST ON 2026-08-24, and what it cost to be missing is
# the argument for reading the next paragraph rather than skipping it. It drives
# an identity of its OWN -- `sync` -- and this block provisioned exactly one,
# `compose`. So its account never held Pro, sync is Pro-gated, and the file came
# out of every gate at 37 failed / 68 passed with `pro=false` on its second line
# and all thirty-five others downstream of it. Nothing was wrong with the engine:
# provisioned by hand it answers 177/177. That is the same defect this file's own
# header records against `verify_look` and `verify_wakerearm` -- a hand-kept list
# that nobody remembered to edit -- reappearing one field along.
NEEDS_GRANT="verify_compose verify_mailfolders verify_sync verify_pausesync verify_sessionrenew"

# WHICH IDENTITY EACH OF THEM DRIVES, because they do not all drive one.
#
# An account belongs to an identity, and an identity is a name plus the harness's
# fixed passphrase; two verifiers signing in under different names are two
# accounts, however much profile they share. `provision.mjs <profile> <name>` is
# what turns one into an account id.
ident_for() {
	case "$1" in
		verify_compose|verify_mailfolders)	echo "compose" ;;
		verify_sync)						echo "sync" ;;
		# Two more that drive identities of their own, found the same way verify_sync was:
		# `pro=false` and a 401 on their second line, and every check below downstream of it.
		#
		# THESE TWO STILL SKIP, and the skip is the honest answer rather than the fix.
		# `provision.mjs` mints an account for an identity that already has a browser profile;
		# for a NAME THAT HAS NEVER RUN it answers "the gateway did not name an account" even
		# with the gateway up, so `pausesync` and `sessrenew` are named here, are provisioned
		# for, fail to be, and SKIP loudly saying so. That is better than the three reds they
		# gave before -- a verifier that did not run should never read as a verifier that
		# failed -- and it is not the same thing as working. Whoever takes it: the first run
		# of a new identity has to create the profile before `/api/account` is asked.
		verify_pausesync)					echo "pausesync" ;;
		verify_sessionrenew)				echo "sessrenew" ;;
		*)									echo "" ;;
	esac
}

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
		# The free half: the journeys, no model, no key, no spend. A suite cannot
		# carry the paid run, and the wire is the half that can be unwired silently.
		refluxduo)          echo "--wire --journey tools" ;;
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
		# The ONE verifier in this tree that spends real money at a real provider.
		# It reaches `dev/reflux.mjs` for a daimon (see its header, and BLOCKERS
		# B13), and reflux drives a real model through a real browser. Its own
		# checks are free and it exits 2 by itself where there is no key -- but
		# once the owner puts a key in place, an unguarded suite would spend from
		# it on every gate, several times a day, and nobody would notice until the
		# key was empty. So the SUITE refuses it and a daimon asking for it by name
		# through `verify` still gets the run.
		verify_reflux)
			[ -n "${DAIMOND_REFLUX_PAID:-}" ] || echo "spends real money at a real provider; set DAIMOND_REFLUX_PAID=1 to let a suite run it (it exits 2 rather than pass)" ;;
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
#
# FOUR MORE JOINED THE LIST ON 2026-08-25 and the accident is the one the paragraph
# above describes, happening a second time: `verify_consolenav`,
# `verify_interfacediagram`, `verify_search_console` and `verify_vocabulary` each
# call `chromium.launch({ headless: false })` in their own source and none was
# named here. Without `xvfb-run` a headed launch has two outcomes and both are bad:
# "Missing X server" on a box with no display, which reads on a summary as the app
# being broken; or, on this box, a real window thrown onto the owner's desktop --
# `dev/display.mjs` strips `WAYLAND_DISPLAY` so `DISPLAY` is honoured, and if that
# is the seat's own it is the seat's own screen.
HEADED="verify_ext verify_grant verify_hand verify_ext_i18n verify_handrun verify_handreal \
verify_scope verify_kitfence verify_pty verify_ptyedge verify_sweep_mobile \
verify_consolenav verify_interfacediagram verify_search_console verify_vocabulary"

# AND THE LIST IS ASKED OF THE FILES, at the one thing a file can be asked.
#
# This is a hand-kept list twice caught stale, and the rest of this script long ago
# stopped keeping those -- `wants_gateway` and `needs_live_gateway` each ask the
# verifier instead. This one cannot be fully derived: eleven of the fifteen launch
# through `dev/extdev.mjs` or the harness rather than saying `headless: false`
# themselves, so a grep is a floor and not a ceiling. It is exact in the direction
# that matters, which is the direction the list has failed in both times: a file
# that says `headless: false` in its own source and is NOT named above stops the
# suite here, before two hours of browsers, rather than after.
#
# ONE FILE STARTS ITS OWN DISPLAY AND MUST NOT BE GIVEN ONE. `verify_reflux`
# reaches `dev/reflux.mjs` for a daimon, and the guard it was built around
# refuses any display it did not start itself -- an inherited one and `:0`
# alike, because the hand is started by the browser and so carries the seat of
# whoever is sitting at the machine. Wrapping it in the suite's `xvfb-run` hands
# it exactly the inherited display that guard exists to refuse, so it would fail
# on its own protection. It is named here rather than added to HEADED because
# the two lists mean opposite things: HEADED is "needs a display from us", this
# is "brings its own". The suite refuses to run it at all for money reasons; the
# list above must still not stop the whole suite on its account.
OWN_DISPLAY="verify_reflux"

missing_headed=""
for f in dev/verify_*.mjs; do
	grep -q 'headless: *false' "$f" || continue
	n=$(basename "$f" .mjs)
	case " $OWN_DISPLAY " in *" $n "*) continue ;; esac
	case " $HEADED " in *" $n "*) ;; *) missing_headed="$missing_headed $n" ;; esac
done
if [ -n "$missing_headed" ]; then
	echo "FATAL these verifiers launch \`headless: false\` and are not in HEADED:$missing_headed"
	echo "      Run without xvfb-run they either die on \"Missing X server\", which reads as a"
	echo "      product failure, or open a window on whoever's screen DISPLAY names. Add them to"
	echo "      HEADED in dev/run_all.sh. Nothing has been run."
	exit 2
fi
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
		# A real model, a real browser and a hand built from source before either
		# of them -- verify_handreal's 900 plus a turn's worth of a provider.
		verify_reflux)                    echo 1800 ;;
		# Two devices, a gateway and a full parcel round trip each way. It has
		# been over the default for a while and nobody noticed, because a killed
		# verifier does not say it was killed: `timeout` cuts the browser out
		# from under it and Playwright reports "Target page, context or browser
		# has been closed" as six ordinary-looking sync failures. The 2026-08-10
		# gate spent its whole red budget on those six, all of which were this.
		verify_sync)                      echo 1200 ;;
		# Two real browser profiles, a gateway, and two waits measured in the
		# engine's own constants: the catch-up (20s) and the focus throttle. It
		# spends most of its time NOT touching the second device, which is the
		# whole point of it -- a check that hurried would be testing something
		# else. MEASURED at 220s on a quiet box (2026-08-28); 480 on the same
		# reasoning as verify_raildialogs, since those waits stretch when the
		# box is busy and a killed verifier does not say it was killed.
		verify_syncviews)                 echo 480 ;;
		# Eight reloads, each waited out past the push debounce so that a push
		# which is coming has come -- and a check that hurried one of them would
		# report a push as absent when it was merely late, which is the exact
		# false pass this file is written to avoid. Two of those reloads carry a
		# second real device. MEASURED at 470s on a quiet box (2026-08-28), so
		# 900 on the same reasoning as the row above it.
		verify_reloadpush)                echo 900 ;;
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
		# Twelve turns of a mock provider, three chats, two fan-outs and a reload,
		# then the same audit again. MEASURED at 41s on a quiet box (2026-08-28),
		# which the 180s default covers comfortably -- and the default is not what
		# it would be killed by. Every turn carries a 40s timeout, so a mock that
		# has gone slow turns 41s into eight minutes without anything being wrong
		# with the app, and `timeout` cuts the browser out from under it and reports
		# the result as six ordinary-looking failures (see verify_sync above). 480
		# is the sum of those timeouts, which is what the file can honestly cost.
		verify_sweep_used)                echo 480 ;;
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

gateway_up()   { ss -ltn 2>/dev/null | grep -q ":$GW_PORT "; }
wait_gateway() {                # tries
	local i=0
	while [ $i -lt "${1:-20}" ]; do
		curl -sf -m 2 "http://127.0.0.1:$GW_PORT/api/health" >/dev/null 2>&1 && return 0
		i=$((i+1)); sleep 1
	done
	return 1
}
# Where the gateway is run FROM decides which app.jdat it reads. `gateway/` is
# the shipped config; `dev/devgw/` is a generated copy carrying `dev_insecure`
# on the mail routes so the local IMAP/SMTP fixtures can be reached at all.
GW_CWD=gateway
# A GATEWAY ALREADY ON THE PORT IS NOT THIS RUN'S, AND `wait_gateway` CANNOT TELL.
#
# This used to spawn regardless and then ask the PORT whether a gateway was up.
# Any gateway answers that -- another lane's, or the one this run had just failed
# to stop -- so `start_gateway` reported success while the process it started was
# dying on a bind it could never win, and everything after it addressed a stranger.
#
# What that cost, on 2026-08-25 at `25d9e51`: `verify_mailfolders` and
# `verify_compose` went red on `the server is asked what folders it has -- 0:`,
# with seven folders on the fixture's own wire and `entitled accounts ready: yes`
# above them. The gateway's log named the hop -- `mail_folders` failed at
# `handlers/mail.rs:405`, the Pro check, under a chain ending
# `csum.rs:139 [Checksum] Mismatch detected`. The store had been written by two
# processes at once: the previous gateway had not gone in the fifteen seconds
# `stop_gateway` allows (a 3.3 GB store takes longer), four `daimond_ctl` calls
# then wrote entitlements underneath it, and a second gateway opened the same
# files while the first was still appending. The licence record read back with
# somebody else's bytes at the offset the index remembered, so every route that
# reads Pro -- `mail_folders`, `mail_accounts`, `mail_sync`, `sync`, `licence` --
# answered a 500, and the client showed a mailbox with no folders in it.
#
# So the port is checked BEFORE spawning, and the pid this run started is checked
# AFTER: "something is answering" was never the question.
start_gateway() {
	[ -x "$GW_BIN" ] || return 1
	if gateway_up; then
		say "      :$GW_PORT is already answering and this run did not start it."
		say "      Refusing to put a second gateway over the same store -- that is what"
		say "      corrupted one on 2026-08-25. Find it with \`ss -ltnp | grep :$GW_PORT\`,"
		say "      or give this run a port of its own with DAIMOND_GW_PORT."
		return 1
	fi
	# The pid is written down because the only safe way to stop a process is to stop
	# the one you started.  See `stop_gateway`.
	( cd "$GW_CWD" && APP_MODE=sandbox nohup "$ROOT/$GW_BIN" >>"$SCRATCH/suite-gw.log" 2>&1 &
		echo $! > "$SCRATCH/suite-gw.pid" )
	wait_gateway 25 || return 1
	# AND THE PID THAT SERVES IS NOT THE PID THAT WAS SPAWNED, which is the whole
	# fault and took a day to see because everything about it reads right.
	#
	# `$!` is what bash forked. Measured on 2026-08-25 with this exact construct:
	# recorded pid 740408, port held by 740409. `kill 740408` returned in 258 ms
	# and the gateway was STILL BOUND AND STILL SERVING SIXTY SECONDS LATER --
	# `stop_gateway` allows fifteen, so it reported failure while the process it
	# meant to stop went on writing the store. Then `daimond_ctl` wrote
	# entitlements underneath it and a second gateway opened the same files, and
	# the licence record came back with the wrong bytes at the offset the index
	# held: `csum.rs:139 [Checksum] Mismatch detected`, nineteen times in one
	# gate, and `verify_mailfolders` red on seven folders it could not see.
	#
	# So the port is asked who is on it. That is only safe because the guard above
	# has already refused a port that was not free: whoever holds it now can only
	# be this run's. Both pids are kept, newest first, and `stop_gateway` stops
	# every one it finds alive -- a wrapper that is already gone costs nothing.
	local held; held=$(ss -ltnp 2>/dev/null | grep ":$GW_PORT " \
		| grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
	local spawned; spawned=$(cat "$SCRATCH/suite-gw.pid" 2>/dev/null | head -1)
	{ [ -n "$held" ] && echo "$held"; [ -n "$spawned" ] && [ "$held" != "$spawned" ] \
		&& echo "$spawned"; } > "$SCRATCH/suite-gw.pid.new"
	mv "$SCRATCH/suite-gw.pid.new" "$SCRATCH/suite-gw.pid"
	[ -s "$SCRATCH/suite-gw.pid" ]
}
# WHAT THIS USED TO BE, AND WHY IT WAS THE WORST LINE IN THE SUITE.  It was
# `pkill -f "$(basename "$GW_BIN")"`, which signals every process on the machine
# whose command line contains the string `daimond_gateway`.  That is not the
# suite's gateway.  It is also, at any moment on a machine running more than one
# lane:
#
#   * every other worktree's `cargo test --bin daimond_gateway`,
#   * every other worktree's libtest harness, `…/deps/daimond_gateway-<hash>`,
#   * the `rustc --crate-name daimond_gateway …` of a build in flight,
#   * every other worktree's release gateway,
#   * and the SHELL of anybody whose command line happens to mention the name.
#
# Measured on 2026-08-24 with three lanes at work: one `pkill -f` would have
# signalled nine processes, of which exactly one was this suite's.  Two builds in
# this lane died on `(signal: 15, SIGTERM)` from it while it ran elsewhere.
# `dev/world.sh` and `dev/attribute.sh` both already say, in as many words, "do NOT
# pkill by command line: it is not scoped to a world."  The lesson had been learnt
# for `serve.mjs` and never carried across to the gateway.
#
# So: the pid this suite started, or nothing.  A gateway somebody else started is
# not ours to kill, and saying so is more use than killing it.
stop_gateway() {
	# EVERY pid this run wrote down, because there is more than one: see the note in
	# `start_gateway` about the process that serves not being the process that was
	# spawned. A pid that has already gone is skipped, so an ordinary run stops one
	# process and says nothing about the wrapper that is no longer there.
	local pid stopped=""
	while read -r pid; do
		[ -n "$pid" ] || continue
		if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null; stopped="$stopped $pid"; fi
	done < <(cat "$SCRATCH/suite-gw.pid" 2>/dev/null)
	if [ -n "$stopped" ]; then
		:
	elif gateway_up; then
		say "      :$GW_PORT is held by a gateway this suite did not start. It is being left"
		say "      alone: find its pid with \`ss -ltnp | grep :$GW_PORT\` and stop that one."
		return 1
	fi
	rm -f "$SCRATCH/suite-gw.pid"
	local i=0
	while gateway_up && [ $i -lt 15 ]; do sleep 1; i=$((i+1)); done
	! gateway_up
}

# A check may want these functions and none of the run.  `dev/breakproof_stopgateway.sh`
# and `dev/breakproof_startgateway.sh` source THIS file -- not a copy of it -- to certify
# that `stop_gateway` stops the pid it started and leaves every other process on the machine
# alone, and that `start_gateway` refuses a port it did not put a gateway on.  Sourcing the
# real file is
# the whole point: a copy would drift from what actually runs, and the fault being guarded
# against is precisely one that looked harmless for months.
if [ "${RUN_ALL_FUNCTIONS_ONLY:-}" = 1 ]; then return 0; fi

# ── Which verifiers to run, and in which phase ──────────────────────────
# `refluxduo` IS IN A DEFAULT RUN, and it is not a `verify_*.mjs`, so it is named.
#
# THE RELEASE GATE FOR SOCIAL, and the only thing that defends it. `--wire --journey tools`
# drives the journey with no provider, no key and no spend, which is why it can sit in a suite
# at all. Without it the Social tools can be unwired by any later change and nothing goes red:
# the next daimon simply reports that the feature does not exist, which is exactly how this
# whole thread began. It stands up its OWN gateway and forge, so it belongs in phase 1 with
# the other verifiers that need :9002 clear.
if [ $# -gt 0 ]; then
	ALL="$*"
else
	ALL=$(cd dev && ls verify_*.mjs | sed 's/\.mjs$//')
	ALL="$ALL refluxduo"
fi
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
# `node dev/i18ncheck.mjs --write-map` is run in the main tree and the map committed. That is
# one command, it is named in the failure, and it is the price of the map being
# true rather than merely present.
# ── WHAT THIS RUN RAN UNDER, before anything it says about the app ──────
#
# Two numbers, because both have already made one commit answer two different
# things and neither output said which it was under.
#
#   THE PORTS. The gateway, the IMAP fixture and the submission stand-in were
#   fixed for the whole machine until 2026-08-25, so a suite could be reading
#   another lane's gateway and its log would look identical either way.
#
#   THE DESCRIPTOR CEILING. `systemd-run --user --unit=…` gives a service a NOFILE
#   soft limit of 1024 where an interactive shell has 524288, and the gateway
#   suite holds a descriptor per store it opens. The same commit answered
#   "634 passed, 0 failed" under a shell and "630 passed, 4 failed" under a unit,
#   and nothing in either run named the ceiling. `-p LimitNOFILE=524288` is the
#   fix at the launch; this is the line that lets a reader tell afterwards.
say "run:   gateway :$GW_PORT   mail :$IMAP_PORT/:$SMTP_PORT   app :${DAIMOND_PORT:-8777}"
say "       descriptor ceiling $(ulimit -Sn) soft / $(ulimit -Hn) hard$([ "$(ulimit -Sn)" -lt 65536 ] && echo "  — LOW: a suite that leaves databases open fails on it")"
say ""

if [ $# -eq 0 ]; then
	say "── Phase 0 (static, no browser)"
	static_one i18ncheck    node dev/i18ncheck.mjs --frozen
	static_one i18nfallback node dev/i18nfallback.mjs --quiet
	# `dev/jscheck.sh` had never run in a gate -- it is a `.sh`, and the work list two
	# blocks down is `ls verify_*.mjs`, so nothing could see it and phase 0's list is
	# hand-written and did not name it. Confirmed against forty `suite.log` files: not
	# one mentions it. It exists because `node --check` EXITS 0 on a `.js` file holding
	# a syntax error, which is proved in its own header, so until now nothing in any
	# gate parsed the browser JavaScript at all.
	#
	# UNDER TWO SECONDS FOR 93 FILES, and it was 61 until 2026-08-25: its own list was
	# `ls www/js/*.js`, which could not see the eight locale tables, the service worker,
	# the operator console, the guide, or either browser extension. The one gate against
	# false greens was giving a confident number about two thirds of the tree. It asks
	# git now, so a directory added later is in the list without anybody widening a glob.
	static_one jscheck      bash dev/jscheck.sh
	# Four assertions, no browser, no port, a fraction of a second: that a terminal
	# request composed in Rust reaches the wire whole, and that a fence root outside the
	# grant travels with the toolkit it belongs to. Written on 2026-08-24 for the day the
	# owner could not open a terminal at all, and never wired into anything -- it is not a
	# `verify_*.mjs` and phase 0's list is hand-written, which is the same accident that
	# hid jscheck. Found by `dev/verify_checkreach.mjs`, which is what that file is for.
	static_one ptyfields    node dev/prove_ptyfields.mjs
	# Five seconds, and it guards the one line in this file that could reach off the
	# machine and into another lane's work. It signals nothing but its own stand-ins.
	static_one stopgateway  bash dev/breakproof_stopgateway.sh
	# Its other half. `stop_gateway` guards what this run kills; this guards what it
	# reports as started, which is how a suite came to drive a stranger's gateway
	# over a store its own processes were writing.
	static_one startgateway bash dev/breakproof_startgateway.sh
fi

# ── Phase 0b: the Rust tests, counted ───────────────────────────────────────
#
# THIS IS THE FIRST RUST COVERAGE THE GATE HAS EVER HAD, and about ten minutes is
# the price of having any.  Read that before trimming it.
#
# The suite never ran a single Rust test.  Not one, in any release this project
# has made.  It built the gateway and stopped there, and the work list below is
# `ls verify_*.mjs`, so what a gate measured was browser verifiers exclusively --
# the "269 passed of 277" that seq 150 shipped on was browser verifiers and
# nothing else.  Every Rust number anybody has quoted came from a run somebody
# did by hand in their own worktree, and nothing checked that the run finished.
# A Rust regression could have shipped in any release ever made and nothing would
# have said a word.
#
# `dev/testcount.mjs` is what makes that checkable: it asks each harness `--list`
# for the number of tests compiled into it, runs the suite, and refuses to call it
# a pass unless the number executed matches.  A `cargo test` alone cannot do that
# -- it exits 0 on a filtered run (`cargo test -- sweeper::` is 12 of 645 and a
# cheerful "ok"), and it stops at the first failing harness, so the gateway's
# integration tests never run at all when its unit tests are red and their 3 are
# silently not in anybody's total.  `--no-fail-fast`, and then every harness is
# counted against what it was compiled with.
#
# THE COST, measured on 2026-08-24 so nobody has to take it again: about half a
# minute for the library's 737, and the rest for the gateway's 645 and its three
# integration tests.  Two things moved it and they are not the same thing --
# `Store::open_temp` now closes its database, which took the gateway harness from
# 312 s to 565 s and is what stopped the suite growing without bound; and the
# `daimond_ctl` test harness is gone, which gave back the 89 s it took before that
# change and rather more after it, for nine tests that moved into the gateway
# harness rather than being dropped.  Only on a whole run; a named subset skips
# it, since a subset is not a total anyway.
if [ $# -eq 0 ]; then
	say "── Phase 0b (Rust, counted)"
	# THE WASM ARMS FIRST, because a green test run is not evidence about them.
	# Every tool's DECISION is a pure native function so it can be tested; every
	# tool's ACTION is `#[cfg(target_arch = "wasm32")]` because it touches the
	# browser.  So the native test build never compiles the acting half, and on
	# 2026-08-25 a `Tool::runs` arm was missing entirely while 790 of 790 tests
	# ran and passed -- both numbers honest, both about a build that did not
	# contain the code.  `testcount.mjs` closes "a test was displaced"; nothing
	# closed "an arm was never written".  About a minute warm.
	static_one wasm_arms    cargo check --target wasm32-unknown-unknown --lib
	static_one rust_lib     node dev/testcount.mjs .
	static_one rust_gateway node dev/testcount.mjs gateway
	# AND THE HAND, added 2026-08-25, because this block was itself the blocker it
	# closed. `.` and `gateway` were a hand-kept list of two directories, and this
	# tree holds THREE `Cargo.toml`s: `hand/` is its own workspace, so it is not a
	# member of the root one and `testcount.mjs .` never reaches it. The fence, the
	# seccomp filter, the journal and the codec -- the most security-critical
	# component there is -- and not one of their tests had ever run in a gate. The
	# fix for "the gate has never run a single Rust test" had the same shape as the
	# fault, one directory along, and nothing said so.
	#
	# `verify_handreal` does not cover it: it builds the hand and then runs a `cargo
	# test` in a FIXTURE project through the daimon, which proves the hand can run
	# cargo and proves nothing about the hand's own tests.
	#
	# RUN FOR THE FIRST TIME 2026-08-25, and the two lines below are what that run
	# cost. It is 268 tests and not the 194 the entry above used to claim: that
	# number came from grepping `#[test]`, and `#[tokio::test]` is a different
	# spelling of the same thing. 242 in the library harness, 26 in the binary's.
	#
	# ELEVEN OF THEM FAILED, every one for a single reason and none of it about the
	# fence. The launcher tests exec the SHIPPING binary, and `cargo test` never
	# builds it -- this crate has no integration test, so cargo has no reason to --
	# so `shipping_hand` in hand/src/exec.rs refuses rather than skipping, on the
	# rule that a fence test which cannot say which code it measured must not report
	# success. `verify_handreal` does not supply it either: that builds `--release`
	# with `CARGO_TARGET_DIR` deleted from the environment on purpose, and these
	# tests look for a DEBUG binary beside themselves, in whatever target directory
	# they were compiled into. So the build belongs HERE, in this environment, where
	# it lands where the tests will look for it -- and it is a check in its own
	# right, because a hand that does not build is a finding on its own.
	#
	# With it: 268 compiled, 268 executed, 268 passed. Measured from an EMPTIED
	# target directory, on a 16-core machine with another lane building beside it:
	# 25 s for the cold build and the tests together, and 12 s warm, of which the
	# build is 4. The dearest part is fe2o3, which the hand takes four crates of.
	# 1.1 GB of artefacts, which is why `hand/` needs a target directory of its own
	# rather than sharing one with the root workspace.
	static_one handbin      cargo build --manifest-path hand/Cargo.toml
	static_one rust_hand    node dev/testcount.mjs hand
fi

# ── Phase 1: the gateway port clear ─────────────────────────────────────
if [ -n "$PHASE1" ]; then
	if gateway_up; then
		say "Stopping the gateway on :$GW_PORT — phase 1 needs it clear."
		stop_gateway || { say "Could not free :$GW_PORT; stop it by hand and re-run."; exit 2; }
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
	# A run on a port of its own needs the generated CWD too, whatever it is running:
	# `gateway/app.jdat` is the deployed config and holds :9002, and moving a port in
	# it is the temporary edit `devgw.sh`'s own header refuses to make.
	NEED_DEVGW=no
	case " $PHASE2 " in *" verify_compose "*|*" verify_mailfolders "*) NEED_DEVGW=yes ;; esac
	[ "$GW_PORT" = 9002 ] || NEED_DEVGW=yes
	case " $NEED_DEVGW " in *" yes "*)
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
			skip_one "$name" "the gateway would not start on :$GW_PORT — $SCRATCH/suite-gw.log"
		done
	else
		say "── Phase 2 (gateway up on :$GW_PORT):$PHASE2"

		# WHICH IDENTITIES THIS RUN HAS TO PROVISION -- a set, not one name.
		# `verify_compose` and `verify_mailfolders` share `compose`; `verify_sync`
		# drives `sync`. Deduplicated, so two verifiers on one identity cost one
		# grant, which is what the single hard-wired pair used to give for free.
		WANT_GRANT=no; GRANTED=no; IDENTS=""
		for name in $PHASE2; do
			case " $NEEDS_GRANT " in *" $name "*) ;; *) continue ;; esac
			WANT_GRANT=yes
			id=$(ident_for "$name")
			[ -n "$id" ] || { say "   $name is in NEEDS_GRANT and ident_for names no identity for it"; continue; }
			case " $IDENTS " in *" $id "*) ;; *) IDENTS="$IDENTS $id" ;; esac
		done
		if [ "$WANT_GRANT" = yes ] && [ -x "$CTL_BIN" ]; then
			# All of this used to go to /dev/null, exit codes included.  A grant
			# that failed silently is worse than no grant at all: GRANTED stayed
			# yes, the three entitled verifiers ran without the entitlement, and
			# went red for a reason this script already knew and had discarded.
			PROV_LOG=$SCRATCH/suite-provision.log
			: > "$PROV_LOG"
			# Every identity's account id is read FIRST, with the gateway up, because
			# `/api/account` is what turns an identity into one and it needs a gateway
			# to ask. The grants come after, together, behind a single restart.
			ACCTS=""; MISSING=""
			for id in $IDENTS; do
				a=$(node dev/provision.mjs "$SCRATCH/$id-profile" "$id" 2>>"$PROV_LOG" | tail -1)
				if [ -n "$a" ]; then ACCTS="$ACCTS $id:$a"; else MISSING="$MISSING $id"; fi
			done
			if [ -n "$MISSING" ]; then
				say "   could not read an account id for:$MISSING — the tests that drive them will skip"
				say "      what went wrong: $PROV_LOG"
			fi
			if [ -n "$ACCTS" ]; then
				# The gateway stands down for the grants, and NOT because of a
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
				# reaches the gateway. ONE restart for all of them, which is the
				# whole reason the ids are read before any grant is made.
				# AND ITS FAILURE IS FATAL TO THE GRANTS, WHICH IT WAS NOT.
				#
				# `stop_gateway` answers whether the port actually went quiet, and
				# phase 1 above has always acted on that answer (`|| exit 2`). Here
				# the answer was dropped on the floor, so a gateway that outlived the
				# fifteen-second wait was still serving -- and still WRITING -- while
				# the four `daimond_ctl` calls below opened the same store to append
				# entitlements to it. That is the second writer whose bytes the next
				# gateway's index could not verify; see `start_gateway`.
				#
				# Nothing is granted rather than granted into a store somebody else
				# holds. The verifiers that need the entitlement then skip by name,
				# which is the outcome this script already prefers to a silent one.
				if stop_gateway; then
					GRANT_OK=yes
				else
					GRANT_OK=no
					ACCTS=""
					say "   the gateway would not stand down, so NO grant is being made:"
					say "   writing entitlements underneath a live gateway is what corrupted"
					say "   the store on 2026-08-25. The entitled verifiers below will skip."
				fi
				for pair in $ACCTS; do
					id=${pair%%:*}; a=${pair#*:}
					# `email` ONLY where the identity is used to read mail. Granting an
					# entitlement a verifier does not need would hide the day it starts
					# needing one, which is the failure this whole block exists against.
					case "$id" in
						compose) ( cd "$GW_CWD" && "$ROOT/$CTL_BIN" grant "$a" email ) >>"$PROV_LOG" 2>&1 || GRANT_OK=no ;;
					esac
					( cd "$GW_CWD" && "$ROOT/$CTL_BIN" topup "$a" 5000 ) >>"$PROV_LOG" 2>&1 || GRANT_OK=no
				done
				# The gateway comes back either way -- the rest of phase 2 needs
				# it whether or not the grants landed.
				if start_gateway && [ "$GRANT_OK" = yes ]; then
					# Pro as well: Email, sync and cloud storage are all behind it
					# since 2026-07-24, so without it the app raises the "Sync is
					# part of Pro" dialog OVER the page mid-run and the clicks that
					# follow land on the dialog. It is bought the way a user buys
					# it -- a signed checkout event the gateway verifies.
					GRANTED=yes
					for pair in $ACCTS; do
						id=${pair%%:*}; a=${pair#*:}
						PROST=$(node dev/pro.mjs "$a" "$ROOT/gateway" 2>>"$PROV_LOG" | tail -1)
						say "   provisioned $id ($a): credits + Pro webhook ${PROST:-?}"
						case "$PROST" in 200) ;; *) GRANTED=no ;; esac
					done
				fi
				say "   entitled accounts ready: $GRANTED"
				[ "$GRANTED" = yes ] || say "      what went wrong: $PROV_LOG"
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
				# Pids kept, for `stop_gateway`'s reason: these are killed by NAME otherwise,
				# and another lane's IMAP fixture has the same name as this one's.
				# The fixture takes its port as its first argument and the
				# stand-in reads SMTPD_PORT; both default to the historical
				# numbers, so a hand run in no world is unchanged.
				nohup "$IMAP_FIXTURE" "$IMAP_PORT" >"$SCRATCH/suite-imap.log" 2>&1 &
				IMAP_PID=$!
				nohup node "$SMTPD"   >"$SCRATCH/suite-smtpd.log" 2>&1 &
				SMTPD_PID=$!
				sleep 2
				ss -ltn 2>/dev/null | grep -q ":$IMAP_PORT " \
					&& ss -ltn 2>/dev/null | grep -q ":$SMTP_PORT " && MAIL=yes
			fi
			say "   mail fixtures on :$IMAP_PORT/:$SMTP_PORT: $MAIL"
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

		# Only the fixtures THIS run started, for the reason written over `stop_gateway`.
		for pid in "${IMAP_PID:-}" "${SMTPD_PID:-}"; do
			[ -n "$pid" ] && kill "$pid" >/dev/null 2>&1
		done
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
