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
| `src/journal.rs` | What was run, what it returned, and what it was refused |
| `install/` | The host manifest, the installer (`--workspace`, `--check`, `--selftest`), and a mock host for tests |

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
