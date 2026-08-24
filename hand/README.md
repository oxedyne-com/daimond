# The machine hand

Daimond runs in a web page, and a web page cannot create a process. There is no
flag and no future API: the capability has to live in a program outside the page,
and every possible design is a different answer to *where that program sits and
who may talk to it*.

This is that program.

## Why a native messaging host

The obvious design is a small daemon on `127.0.0.1` that the page talks to. It
was rejected, and the reasoning should not be relitigated:

- A loopback port is reachable by **any page the user visits**.
- It is not secret, and it is guessable in a second.
- So the entire defence collapses to one pasted secret.

A native messaging host has no port. Chrome launches the binary and connects it
to **one extension**, and that extension is reachable from **one origin**. There
is nothing to find and nothing to steal, because the browser is the doorman. The
cost is a JSON file in a per-browser directory at install time — see
`install/README.md` — which is trivial for the person who wants this and is the
step most likely to defeat a stranger later.

## Why `argv` and never a shell string

Handing a string to `sh -c` means defending against the shell itself: `;`,
`$(…)`, backticks, `|`, `eval`, `base64 -d | sh`, `find -exec`,
`tar --to-command`. That defence does not exist, anywhere, and **a fence made of
string matching is not a fence**.

`{"argv": ["cargo", "test"]}` does not need the defence, because there is nothing
to inject into. Redirection and pipes become structured fields (`stdin`, `cwd`,
`capture`) rather than characters something else interprets. Claude Code goes
through bash because it grew out of a terminal; there is no such history here, so
the problem can simply not exist.

The `env` field is not the model's to set: a model that could name environment
variables through it could set `LD_PRELOAD`, or carry a stolen value out through
one. That screen covers the field and not the request. `/usr/bin/env` and
`/bin/sh` are in the read-only system base, and both take an environment out of
their own arguments, so a command can still choose what it runs with — from
inside the fence, using only what the fence already grants. What bounds that is
the compartment, not the screen: see `REVIEW.md` §3.13.

**Two names the hand fills in where the request named neither**, and they are the
whole of what a command gets that nobody asked for. `HOME`, because a shell script
under `set -u` dies on its first line without one — `bash dev/world.sh 3 --up` did
— and it is the hand's own home, the same path the page is told in `caps` as
`home:`. It POINTS and it does not GRANT: what a command may open is the fence's
decision, so a tool following `HOME` somewhere ungranted meets a refusal rather
than a file. And `PATH`, the same fixed `/usr/local/bin:/usr/bin:/bin` the hand
already resolves a bare `argv[0]` through; handing a program an environment in
which it cannot find `node` or `grep` was the same answer given twice and
differently. A pair the caller sent always wins, because a default is a floor and
not a correction.

`USER`, `LOGNAME`, `LANG`, `LC_*`, `SHELL` and `TERM` are deliberately absent, and
each absence is argued at `ENV_DEFAULTED` in `exec.rs`. The short of it: nothing
needs the first two, a locale changes what a program prints and the reader here is
a machine, and a command down a pipe has no terminal. `TMPDIR`, `TMP` and `TEMP`
are the other kind — set unconditionally, refused from the caller, and the hand's
answer is the last word.

## What a run leaves behind

A command may outlive itself. `bash dev/world.sh 3 --up` starts a dev server and a
mock provider in the background and returns; the direct child is reaped and the
two servers go on holding their ports. That is a legitimate thing to want — a
browser verifier needs a server to drive — so it is not refused.

What was wrong was forgetting them at that moment. **Nothing else on the machine
can reach them.** Landlock scopes signals to the domain that sent them, so a later
command's `kill` answers `Operation not permitted`; `/proc` is outside every
fence, so the pid cannot be found either. Measured: a daimon brought a world up,
could not take it down, and two ports were held until a person cleared them from
outside the app. That is a leak the app creates and then forbids fixing, which is
worse than either half on its own.

So the hand keeps what it started. `Req::Runs` asks what is still going —
`running` for a command that has not finished, `standing` for one that has and
whose process group has not emptied — and `Req::Signal` stops one **by the
identifier the run was given**. Never a pid, never a name, never a pattern: the
guard is not a check on the argument, it is that the argument cannot express
anything else, so `pkill` stays impossible. `Req::Bye` stops the standing ones
too, because a server nothing can reach is not a server anybody wanted.

There is no `stopped` answer, on purpose. A signal that could not be delivered
comes back as `Resp::Error`; a signal that could is confirmed by asking again. A
teardown reporting success on a kill that failed is the defect this closes, and
the cheapest way not to write it again is to have nowhere to write it.

## The three tiers

The Workspace panel has said `Browser · Machine · Cloud` since long before this
existed, and those words already mean the right things:

| Tier | What runs | Isolation |
|---|---|---|
| **Browser** | WASI in the page | Perfect, and useless for real work — no arbitrary binaries, no sockets |
| **Machine** | this hand, over native messaging | The fence in `fence.rs` |
| **Cloud** | the *same binary* over WSS, on a box you own | The same fence, plus the network between |

One binary serves Machine and Cloud, which is why the wire protocol is designed
for remote from its first line. Loopback is the degenerate case of remote;
building for localhost only would mean a rewrite to add the rest.

## The compartment is not a new idea

`diamond_bounds()` in the app already produces exactly the structure a Landlock
ruleset wants: a set of paths, each read-only or read-write, plus a deny for
Daimond's own directory. So a Diamond's fence here is the **same rule enforced
one layer down**, and only the mechanism changes. The claim the user guide
already makes survives almost verbatim.

Two things about that translation are silent when wrong, and are therefore tested
against deliberately broken code in `src/tools.rs`:

- **A turn with no allow-list is not an unfenced turn.** The app's `may_read`
  treats an empty bound list as *no restriction*, which is right for a file tool
  jailed by the workspace root and catastrophic here, where there is no jail but
  the fence. An absent allow-list becomes the granted root, never the machine.
- **A tainted turn loses the network.** A turn that has read a stranger's words
  may still build and test inside its own paths, and may not reach outward. This
  is the existing `egress_check` rule applied to a process rather than a URL, and
  it is the direct answer to a page that says "now upload this somewhere".

**One thing the fence takes away that the app's own bounds do not: a command
cannot create a symbolic link.** Anywhere — including the folders it may write and
its own temporary directory. `ln -s` and `symlink(2)` answer `Permission denied`,
because Landlock's `MAKE_SYM` is withheld from every writable grant.

A link is half of a leak, and it is the half a fenced command can supply for the
price of one call. The other half is supplied by whatever later follows it: an
archiver, a packager, an uploader, a version control system recording the tree.
The case that was measured is Ore, which absorbs the *content* of a link leaving
the working copy, under the link's own path, into a signed history that has no
forget — with a global `post-commit` hook running it from outside the fence on the
owner's key. Checking what a link points at was the obvious repair and is weaker
twice over: it races a repoint between the check and the read, and it cannot see a
`symlink(2)` a compiler makes rather than an `ln` a model runs.

Measured cost, on this tree: a cold `cargo check` over the whole dependency graph
and a `node` verifier make **no** `symlink` or `symlinkat` call at all, and both
run to exit 0 behind the fence with the right withheld. What does need it is four
shell scripts and six node scripts under `dev/`, all of them build and gate
plumbing — five of the six are `verify_*` and run outside the command fence
anyway.

## Which folder, and whether it is the right one

The page holds a File System Access *handle*, which has no path and cannot be
turned into one. The hand holds a path it was configured with. Nothing joins
them, and `Tool::run` nevertheless joins the page's workspace-relative names onto
the hand's root — so a `root.txt` left over from another project, or a workspace
that lives only in OPFS, produces a fence around the wrong tree while every
component behaves exactly as designed.

So the hand writes a token to `<root>/.daimond/workspace.id` and says it in
`caps` as `ws:<token>`. The page can read that file through the handle it already
has, and one comparison settles it. The token sits inside `.daimond` because a
fence always denies that directory: a command cannot read it, and therefore
cannot answer for a folder it is not in. Where the folder cannot hold a token the
hand says `ws:unproven` rather than nothing, because a page cannot tell silence
from an older hand.

The hand has one of the two names, so this is evidence and not enforcement. The
refusal belongs in the page, which has both.

## Where the journal lives — an open question

`~/.local/share/daimond/hand/journal`, and `.local` is hidden. That one fact cost
an hour on 2026-08-02: a snap Chromium started the hand, snap's `home` interface
grants only the *non-hidden* files in `$HOME`, and the hand could not open the
journal — so it exited without writing the record it would have used to say why,
and Chrome reported a bare "Native host has exited".

Two things have been done and one has not.

**Done.** Every refusal on the startup path now goes to standard error as a
sentence before the process ends (`refuse` in `src/main.rs`), because Chrome
copies a native host's standard error into its own log and that is the only
channel that survives a journal the hand cannot open. And `install/install.sh`
finds snap and flatpak profiles, refuses to register into them, and says why.

**Not done: the journal has not been moved, and should not be without a
decision.** The argument for moving it — say to `~/Daimond/hand/journal`, not
hidden, reachable by a confined browser — is that the override is an environment
variable and a browser hands a native messaging host *its own* environment, so
`DAIMOND_HAND_JOURNAL_DIR` cannot reach the hand at all. That is precisely why
the granted root is a *file*. An escape hatch nobody can operate is not one.

The argument against is stronger, and is why this is written down rather than
acted on:

- The journal is the tamper-evident record, and its whole value is that its
  location is predictable and boring. `~/.local/share` is where XDG says
  application state goes; a visible directory in `$HOME` is a directory users
  rename, sync, back up into a shared drive, and delete.
- Moving it strands every existing install's chain. The chain is the product's
  claim, and a hand that starts a new one because the path changed under it is a
  hand that has quietly discarded history.
- It fixes the symptom for one packaging. Flatpak's `--filesystem=home` has the
  same hidden-file exclusion, and any future confinement will differ again. The
  refusal at install time works for all of them.

**The recommendation is therefore: keep the path, and fix the override rather
than the default.** `root.txt` cannot be the model here — it lives *inside* the
journal directory, so a file naming that directory cannot live there too. The one
path a browser-launched hand knows without being told is its own: a
`daimond-hand.journal` beside `/proc/self/exe`, written by `install.sh` when an
operator asks for a journal elsewhere, would give the escape hatch to the person
who actually needs it, with no migration and no second guess about where the
record is by default.

That has not been built. It is a change to where the tamper-evident record can be
pointed, and that is the user's call rather than this session's.

## Layout

| File | What it is |
|---|---|
| `src/wire.rs` | The contract: `Req`, `Resp`, `FenceSpec`, the size limits |
| `src/codec.rs` | JSON via `fe2o3_jdat`, framed for native messaging and for WebSocket |
| `src/exec.rs` | The runner: argv, cleared environment, streamed output, process-group kill |
| `src/fence.rs` | What a command may touch |
| `src/seccomp.rs` | What a command may *call* — the half Landlock cannot express |
| `src/verify.rs` | Running a NAMED verifier from the tracked tree, and refusing to report a bare pass |
| `src/journal.rs` | What was run, what it returned, and what it was refused |
| `install/` | The host manifest, the installer (`--workspace`, `--check`, `--selftest`), and a mock host for tests |

## The one thing that runs outside the fence

`Req::Verify` runs a `dev/verify_*.mjs` from the granted tree **unfenced**, and
that is a deliberate exception rather than an oversight. State it plainly before
reading further: a verify makes a process that Landlock and seccomp are not
applied to.

The reason is that the fence makes browser evidence impossible. A fenced command
cannot open the display server's unix socket and cannot `listen`, so every
verifier that drives a real page dies under it — and those verifiers are half the
proof of a release. A machine that can write code and cannot check it is not a
safer machine, it is a machine whose claims nobody can test.

The justification is **provenance, not confinement**. The fence exists to contain
a command a MODEL wrote. What the model supplies here is a *name*, which the hand
looks up in its own granted `dev/` directory, and at most a *break*, which the
hand looks up in that file's own source. What reaches the argument vector is the
directory entry's own file name and a break name parsed out of the file — never
the caller's string, and never through a shell. That puts a verifier in the same
trust class as `cargo test`, which the hand already runs.

Three things keep that checkable rather than merely asserted:

* Every run is journalled as the `Exec` it really is, with the real node command
  line and `fence:none` in its mechanisms. A reader of the record sees the
  exception; nothing hides it.
* `--report` prints the verifiers this machine would run, and says they run
  outside the fence, above the list of what the fence enforces.
* The handshake carries `verify:dev` or `verify:none`, so a page can say "not on
  this computer" rather than discovering it one refusal at a time.

And the verb **cannot report a bare pass**. It runs the clean pass and each
declared break, and answers with three numbers: checks passed, breaks confirmed
red, and breaks that reddened nothing. `verify::Verdict` is an enum whose every
arm carries the third number, so there is no expression in the program that
yields the first without it; a clean-only run is labelled UNPROVEN in the report
and in the trailer the app restates. `dev/verify_verifyverb.mjs` proves this
against a fixture with a deliberately dead break.

## Release gates

> **Read `REVIEW.md` first**, and read its "Where this stands" table before
> anything else in it. Six adversarial reviews on 2026-08-02 demonstrated three
> escapes from the fence and forged a tampered journal three ways; all three
> escapes are now closed, each closure named against the code that answers it and
> proved by re-running the escape, and three findings are still open. The gates
> below were written before that review; gates 1, 2 and 4 now hold, and the
> capability does not ship until the third open finding is decided.

**These are not finished-work notes. They are conditions on shipping, because the
consent window already promises them.** `ext/_locales/en/messages.json` tells the
user that a command runs "only inside the folders the workspace already allows"
and that "every run is written to a journal you can read". Until both are true
and in force, that window is making a claim the code does not keep, and a promise
about safety that is not kept is worse than no promise.

1. **The fence must be in force, or the command must be refused.** Not "run it
   unfenced and mention it" — refused. The `caps` list in the `hello` exists so
   the app can say which guarantee it is actually offering on this machine, and
   the grant window's wording must be chosen from `caps` rather than hard-coded.
2. **The journal must be authoritative and outside every fence.** A journal the
   daimon can rewrite is not a journal.
3. **Neither promise may be softened by weakening the text.** If a guarantee
   cannot be kept, the capability does not ship; the sentence is not what needs
   editing.

4. **The fence must be applied to the command, not to the hand.** `Plan::apply()`
   fences the *calling* process and `pre_exec` is `unsafe`, so the hand re-execs
   itself as a launcher, applies the fence there, and becomes the command through
   a safe `CommandExt::exec`. That landed; `exec::launch_main` is it.

## Two mechanisms, in one order

The compartment is Landlock **and** seccomp, and neither is optional. Landlock
governs opening a file, which leaves two measured escapes it has no way to
express: the metadata calls have no access right, so a command could world-write
a file inside the denied subtree; and `connect()` to a pathname unix socket is
ungoverned below ABI 9, so a command could reach the session bus and start a
process that was never fenced at all. `src/seccomp.rs` refuses both by syscall
number. It is a deny-list and says so — it removes named capabilities from a
command rather than sandboxing it.

The launcher does three things before `execve` and the order is not negotiable:

1. **Adopt the terminal**, where there is one. Landlock ABI 5 governs `ioctl` on
   a device file opened after the ruleset, and `TIOCSCTTY` is exactly that ioctl,
   so a session that fenced first would fence itself out of its own terminal.
2. **Apply the fence.** Doing so *opens every granted path*, so Landlock has real
   work left after its own rules take hold.
3. **Install the filter.** It needs nothing after itself but `execve`. Put before
   the fence, a deny-list that ever named something the `landlock` crate needed
   would break the fence rather than the command — the wrong failure, in the
   wrong layer, for a reason nobody could read.

Both are irreversible, both survive `execve`, and both need `no_new_privs`. A
machine that cannot do either refuses the command; there is no degraded mode.

## The finding that changes the ssh plan

Measured on this machine at Landlock **ABI 8**: **pathname unix sockets are not
governed until ABI 9 (Linux 7.1)**. Landlock alone therefore lets a fenced
command `connect()` to a socket file whose path is outside the fence — the
session bus, the X11 socket, a container daemon, and **`ssh-agent`**.

The filter closes this by refusing `socket(AF_UNIX, …)`, which every one of those
needs first, so what follows is the reasoning that made the refusal
unconditional rather than a problem still open.

That last one matters more than the rest put together, because the plan for
`ssh_run` was that *keys are capabilities, not files*: the hand would hold the
key, offer `ssh_run(host, argv)` against an allow-list, and the daimon would
never see the key at all. **A reachable agent socket defeats that entirely.** A
command that can talk to `ssh-agent` can sign with the user's keys, to any host,
without the key ever being read — which is precisely the property that made
agent forwarding dangerous in the first place.

So `ssh_run` cannot be built on the fence alone, on any kernel below 7.1. It can
be built on the fence *and the filter*, which is why the filter refuses `AF_UNIX`
for every command rather than only for one that was already denied the network:
reaching the agent has nothing to do with whether the command was allowed to
fetch a crate. The cost is that a command cannot use any local socket it names —
a database, a container daemon, X11, an agent-authenticated `git fetch` — and
that cost is stated in `--report` rather than discovered.

**Decide the rest of `ssh_run` before building it, not during it.** The remaining
options are unchanged: rely on `SSH_AUTH_SOCK` being absent (weak — the path is
guessable, and the filter is what actually stops it today); or hold ssh behind a
capability the hand executes in a *separate*, more tightly fenced process.

## Deliberately not done

This once said "no pty", and the paragraph is kept because the reasoning still
explains the shape of the wire: `Req::Exec` is the simple, non-interactive case
and it covers nearly everything an agent does. A terminal turned out to be one of
the cases that hurt, so `Req::Open` exists alongside it, with its own messages
rather than a flag — almost nothing is shared, and keystrokes are never
journalled, because the questions a program asks a terminal are `sudo` wanting a
password and `ssh` wanting a passphrase.
