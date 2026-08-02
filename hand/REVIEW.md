# Adversarial review, 2026-08-02

The hand was written in a single session by five parallel agents plus the lead.
It was then reviewed by six independent adversarial passes, one per area, each
told to prove findings by making them happen rather than by reading. What
follows is what they found.

**The short version: the hand is not close to shippable, and the two guarantees
the product would make about it — the compartment and the journal — currently do
not hold.** Three independent escapes from the fence were demonstrated against
this kernel, and a tampered journal was forged three ways. Nothing is exposed to
anyone, because `main.rs` has no message loop and the host cannot serve a
browser at all; but every claim in `README.md`'s release gates is further off
than it looked when they were written.

Findings are CONFIRMED (the reviewer made it happen) or PLAUSIBLE (reasoned, not
reproduced). Line numbers are as of commit `ad19a62`.

---

## Where this stands

**Everything above this line is the review as it was written on the morning of
2026-08-02, and it is left exactly as written.** The paragraph beginning "The
short version" was true of the code that morning and is no longer true of the
code today — `main.rs` has a message loop, the host serves a browser, and most of
what was found has been repaired. It stays because a finding without its original
verdict is a finding with its teeth pulled, and because the reasoning is why the
code now looks as it does.

**What was added afterwards is a state line on every finding**, marked **CLOSED**
(with what answers it and how that was proved) or **OPEN** (with what the
exposure is meanwhile). Nothing has been softened. Reproductions are left intact:
a closed finding with its reproduction still in it is the strongest thing this
document can carry, and an escape that no longer works is not a secret worth
keeping.

The state lines were written by reading the working tree, driving the release
binary over a pipe where behaviour rather than code was the question, and running
the crate's tests. They are accurate as of the commit this file ships in and
nowhere else; a reader taking any of them on trust should check the code cited,
which is why each one cites code.

| | Finding | State |
|---|---|---|
| 1.1 | Symlink in a carved directory grants its target | **closed** |
| 1.2 | Metadata syscalls ungoverned | **closed** |
| 1.3 | Unix socket is a way out of the compartment | **closed** |
| 1.4 | A fence root of `""` grants everything | **closed** |
| 1.5 | The received fence is not clamped to the grant | **closed** |
| 1.6 | Localhost dev origins in the manifest | **closed** |
| 1.7 | One global grant, not per-origin | **closed** |
| 1.8 | `apply_fence` a no-op returning success | **closed** |
| 2.1 | A truncated history verifies as intact | **closed** |
| 2.2 | One planted filename destroys the record | **closed** |
| 2.3 | Credentials through eight unredacted fields | **closed** |
| 2.4 | `redact_argv` caught 0 of 12 | **closed** |
| 2.5 | No locking; two hands break the chain | **closed** |
| 2.6 | A write that reaches nothing returns `Ok` | **closed** |
| 2.7 | The two verifiers disagree on CRLF | **closed** |
| 2.8 | Nothing calls the journal | **closed** |
| 3.1 | The shipping path can emit an unsendable frame | **closed** |
| 3.2 | Trailing content silently discarded | **closed** |
| 3.3 | An oversized frame poisons the stream | **closed** |
| 3.4 | `argv[0]` never vetted against the fence | **closed** |
| 3.5 | `LD_PRELOAD` settable by the caller | **closed** |
| 3.6 | A duplicate `id` makes a run unkillable | **closed** |
| 3.7 | One noisy run blocks every later one | **closed** |
| 3.8 | No total output cap | **closed** |
| 3.9 | Registry entries leak | **closed** |
| 3.10 | Group signalling degrades on BusyBox | **closed** |
| 3.11 | `u64` fields do not survive JavaScript | **closed** |
| 3.12 | The decoder accepts JDAT, not JSON | **closed** |
| 4.1 | `www/js/hand.js` is dead code | **closed** |
| 4.2 | A host can hold the page open for ever | **closed** |
| 4.3 | A quiet command killed at 30 seconds | **closed** |
| 4.4 | Chunks accumulate with no cap | **closed** |
| 1.9 | `no_write` never populated in the browser build | **open** — being closed elsewhere |
| 1.10 | `fence_spec` not a faithful restatement of `Bound` | **closed** |
| 1.11 | A killed command reported as `exit code: 0` | **closed** |
| 1.12 | `handler.rs` assigns rather than composes | **closed** |
| 1.13 | The first command of a turn costs the turn its network | **open** — a decision for the user |
| 1.14 | No check that the hand's root is the workspace | **closed** at both ends |
| 1.15 | Release gate 1 is nobody's job | **closed** |
| 1.16 | Every disconnect reported as "not installed" | **closed** |
| 1.17 | A lost output tail is detectable and not detected | **closed** |
| 1.18 | Scoped workers cannot run with a default `cwd` | **closed** |
| 1.19 | `id` neither unique nor bounded | **closed** |
| 1.20 | A Diamond's crystal agent could reach another Diamond | **closed** |

**One open, and it is not an escape.** 1.9 and 1.12 were one thing and both are
now closed: a worker is scoped by its own Diamond, and a second bound composes
with the first rather than replacing it. 1.13 is a design decision, not a
defect, and it is written up as a recommendation.

**Both compartment escapes are closed, and each closed by a different layer.**
1.1 was Landlock's own carve; 1.2 and 1.3 needed a mechanism Landlock does not
have, and the filter that provides it had been written, tested and never
installed — the most valuable thing this status pass found. 1.5 was the page
being believed about which folders it was allowed to name.

**The release gates in `README.md` are close but not all met**, because gate 1
now holds at both ends while 1.9 keeps the fence wider than the guide describes.
The consent window's wording can be revisited once 1.9 lands; on this machine the
sentence "only inside the folders the workspace already allows" now has the
exceptions `--report` prints and no others.

---

## Severity 1 — the compartment does not hold

**1.1 A symlink in a carved directory grants its target.** CONFIRMED.
`fence.rs:1151-1157`. `carve()` enumerates a carved parent with `read_dir` and
grants each child without canonicalising it; `apply_linux` (`fence.rs:884`) then
opens it with `PathFd::new`, which follows symlinks and binds the rule to the
target inode. Spec-named paths go through `canonical()`; carved children never
do.

This is not a corner case. `fence_spec` always adds `.daimond` to `deny` inside
the workspace `rw` root, so **every real fence carves the workspace**. A daimon
with ordinary write access to its own Diamond drops `ln -s /home/u ws/escape`
on one turn; on the next, the fence grants read-write on the whole home
directory. Deterministic, persistent, attacker-controlled. Proved twice: a file
was created in an outside directory and a private file there was read.

**CLOSED.** `fence.rs` canonicalises every carved child and refuses one that is a
symbolic link, so the link is dropped from the plan rather than followed; the
drop is reported in `plan.dropped` and named in `plan.caveats()`, so a command
that stops working says why. Proved at both ends by
`a_symlink_in_a_carved_directory_is_not_granted` (the plan carries neither the
link nor its target) and `a_symlink_escape_is_refused_by_the_kernel` (the kernel
refuses the target under a real ruleset), because a plan that looks right and a
fence that is wrong is the failure this file is written against.

**1.2 Metadata syscalls are ungoverned, including inside the denied subtree.**
CONFIRMED. Landlock's `AccessFs` has no right covering `chmod`, `chown`,
`utimensat` or `setxattr`, so none are mediated. Under a full ABI-8 fence, all
four succeeded on a file outside every root, and `chmod 777` succeeded on a file
*inside* the denied `.daimond` subtree — taking it from 600 to 777 — even though
reading it is refused. A fenced `cargo test` can world-write the home directory
or strip protection from the exact secrets the deny exists to protect.
`Fence::holes()` mentions none of this.

**CLOSED — and it was open for a reason worth recording.** `seccomp.rs`
implemented the answer, had tests for both measured halves, and **was called from
nowhere**: `fence.rs`, `exec.rs`, `main.rs` and the launcher never referenced it,
and the crate's only other mention of `seccompiler` was in `Cargo.toml`. The
module's unit tests passed the entire time the launcher ran unfiltered, so a
passing unit test on the filter was precisely the evidence that failed. A defence
that exists in the source and not in the process is worse than none, because it
has already been counted as done.

`launch_inner` now installs it, and the escape is the test. Against the release
binary, over a pipe, with the whole fence in force and the file **inside the
denied subtree**:

```
before   argv: /bin/chmod 777 <ws>/.daimond/secret.txt
         {"t":"ended","id":"e","exit":0,"timed_out":false,"killed":false,…}
         secret.txt mode: 0600 -> 0777    CHANGED

after    argv: /bin/chmod 777 <ws>/.daimond/secret.txt
         {"t":"chunk","stream":"err","data":"chmod: Operation not permitted (os error 1)"}
         {"t":"ended","id":"e","exit":1,…}
         secret.txt mode: 0600 -> 0600    unchanged
```

The trade `Meta::NoLoosening` makes is unchanged and is still in `holes()`:
`chmod 777` is refused, `chmod 644` is not, because `cargo` sets 644 on every
file it unpacks and the utime family has to stay for the same reason.

Also a test now, at `exec::tests::the_filter_is_installed_and_not_merely_written`
— the `chmod` half, because it needs no session bus and can therefore run
anywhere. It drives the real spawn path and the real launcher, and it fails with
"chmod 777 succeeded behind the filter" the moment the install is removed.

**1.3 The unix-socket hole is arbitrary unfenced execution, not a leak.**
CONFIRMED. With `net:false` fully applied, `connect()` to
`/run/user/1000/bus` succeeds, and `systemd-run --user … /bin/cat <denied-file>`
runs **outside the fence** and returns the contents. `SysBase::Minimal` supplies
the tools by granting `/usr` read-only. `holes()` and `README.md` describe this
as "can still talk to the session bus"; the true consequence is that the
compartment can be stepped out of entirely. The under-statement is itself the
defect.

**CLOSED, with 1.2 — and closing it needed a second decision.** The filter
refuses `socket(AF_UNIX, …)`, which every `connect()` to the bus needs first.
Against the release binary, with the fence in force and the bus's address handed
to the command explicitly (the hand clears the environment, and the escape is
`connect()` to a path a compiled attacker carries in its own text, so supplying
it is what makes this a test of the fence rather than of `env_clear`):

```
before   argv: /usr/bin/systemd-run --user --quiet --pipe --wait /bin/cat <denied file>
         {"t":"chunk","stream":"out","data":"the private thing\n"}
         {"t":"ended","id":"e","exit":0,…}

after    {"t":"chunk","stream":"err","data":"Failed to connect to user scope bus
          via local transport: Operation not permitted …"}
         {"t":"ended","id":"e","exit":1,…}
```

**The second decision.** `Spec::for_fence(net)` refused `AF_UNIX` only when the
fence refused the network, reasoning that refusing the bus buys nothing from a
command that may reach outward anyway. That reasoning is wrong and it was
measured wrong: wired in as written, with `net:true`, the filter installed and
the fence in force, `systemd-run` **still returned the file's contents**. And
`fence_spec` sets `net: !tainted`, so `net:true` is the *first command of every
turn* — the compartment would have been open on the first command of every
ordinary session.

The escape is not a network escape. It is a filesystem escape wearing a socket:
the bus starts a process Landlock never bound, and that process reads a path this
fence denies. Whether the command was allowed to fetch a crate has nothing to do
with it, and the same socket reaches `ssh-agent`, which can sign with the user's
keys without the key ever being read. `fence.rs` already scopes *abstract* unix
sockets unconditionally from ABI 6, so refusing the pathname ones unconditionally
is what makes the two layers agree.

So `Spec::for_command()` refuses `AF_UNIX` for every command, and the third line
of the table above is `net:true`, refused. The cost was measured rather than
assumed: a from-scratch `cargo build --offline` succeeds behind it, because
`cargo`, `rustc` and `ld` use `socketpair`, which is a different call and is left
alone. What a command cannot have is a local socket it names — a database, a
container daemon, X11, an `ssh-agent`-authenticated fetch. That is stated in
`Unix::Refuse` and printed by `--report`, and `Unix::Allow` survives as an arm
nothing chooses, so an operator setting has a shape to take.

**1.4 A fence root of `""` grants the whole filesystem.** CONFIRMED.
`exec.rs:709-711,739-742`. The empty-fence guard tests `rw.is_empty()`, not
whether the roots mean anything, and `under()` is `Path::starts_with`, for which
`Path::new("/etc/ssh").starts_with("")` is true. `FenceSpec{rw:[""]}` ran a
command in `/etc/ssh` and returned success.

**This one reaches the app.** `Tool::run` (`tools.rs`) reads the hand's granted
root with `extract_json_string(&st, "root")` and refuses only when the key is
*absent*; a root of `""` returns `Some("")`, passes the check, and `fence_spec`
pushes it into `rw`. The lead wrote both the guard and the hole.

**CLOSED, at both ends.** In the hand, `under()` refuses an empty or relative
prefix outright rather than asking `starts_with` (`exec.rs`, proved by
`test_containment_is_by_component_not_by_prefix`, which asserts
`!under("/etc/ssh", "")`). In the app, `Machine` refuses an absent root and an
empty one alike, and `test_an_unusable_root_fences_nothing_rather_than_everything`
asserts that `""`, `relative/path`, `./ws` and `C:\ws` each yield *no* roots and
no network — failing closed rather than open.

**1.5 The fence is computed inside the page, and the page is not trusted.**
CONFIRMED. `ext/hand.js:506-517,493` validates only `id`, `argv` and `cwd`;
`env`, `fence`, `timeout_ms` and `capture` are forwarded to the executing host
verbatim, and an exec with no `fence` key at all is forwarded too. A page sent
`fence:{rw:["/"],net:true}` with its own `LD_PRELOAD` and the host received it
byte-for-byte.

This is sound against the *model* — the LLM cannot choose its own fence, because
`fence_spec` derives it from `ToolContext` — but not against a hostile origin.
Combined with 1.6 it is a full compromise. **The durable fix is that the host
must clamp any received fence to its own grant and refuse anything wider**; it
cannot know a Diamond's bounds, but it can refuse `rw:["/"]`.

**CLOSED.** First re-measured, because a finding worth fixing is worth
reproducing: driven over a pipe, `fence:{rw:["/"]}` *was* refused, but only
incidentally — the journal lives somewhere under `/`, and `Journal::check_fence`
refuses any fence that reaches the record. Narrow the fence to a root that misses
the journal and it was honoured in full: `fence:{rw:["/etc"]}`, `cwd:"/etc"`,
`argv:["/bin/ls","/etc/ssh"]` started, ran and returned the directory listing,
with the granted root nowhere in it. A coincidence is not a boundary, and that
one stops holding the moment somebody moves the journal.

`exec::vet_roots` now answers the question, and the question is the whole of the
fix. "Every root must be under the granted root" is the obvious rule and it is
wrong: a toolchain does not live in the workspace — `cargo` is under `~/.cargo`,
`node` under `~/.nvm` — so that rule refuses every real build, and a security
check that breaks `cargo` is one somebody switches off. So the clamp asks
whether a root is one **the grant could imply**, against a set that is closed and
knowable: the granted workspace, the hand's own scratch directory, and the
toolchain folders `Toolkit::grants` names in `src/tools.rs`. `deny` is not
clamped and must not be — a deny only ever takes access away.

The two copies of that toolchain list can drift, and the drift fails safe and
loud: a path the hand does not know is refused in a sentence naming both the path
and the constant to add it to, so it is one line to fix rather than a hole to
find.

Measured against the release binary, over a pipe, after the change:

```
refused   rw:[/etc]  cwd:/etc  ls /etc/ssh
refused   rw:[/]     cwd:/etc
refused   ro:[~/.ssh]
refused   rw:[~]     the whole home directory
refused   rw:[/tmp]
ran, 0    rw:[workspace]                          output: in the workspace
ran, 0    rw:[workspace/sub]  a subtree of it
ran, 0    rust toolkit ro:[~/.cargo/bin ~/.rustup]  output: cargo 1.90.0
ran, 0    node toolkit   ~/.nvm ~/.npm
ran, 0    python toolkit ~/.pyenv ~/.local ~/.cache/pip
ran, 0    go toolkit     ~/sdk ~/go ~/.cache/go-build
```

Only Rust is installed on the machine this was measured on; the other three
toolchain directories were created empty for the run and removed afterwards,
because without them the *planner* refuses the fence ("cannot be resolved") long
before the clamp is asked, and a pass for that reason would prove nothing.

Also by `exec::tests::a_fence_may_only_name_roots_the_grant_implies`, which walks
every entry in `TOOLKIT_ROOTS` and needs no directory to exist, and which fails
three ways against broken code: with no clamp at all, with the naive
under-the-root clamp (which refuses `~/.cargo` and takes `cargo` with it), and
with `deny` wrongly clamped too.

**1.6 The two localhost dev origins ship in the extension manifest.** CONFIRMED.
`ext/manifest.json:30-31`. A bare hostile HTML file served from
`http://127.0.0.1:8777` opened the port and completed an exec. Any process that
binds that port — a stray dev server, a static server rooted in `~/Downloads`,
another account on a shared machine, user-level malware — obtains content-script
injection and unfenced execution. DNS rebinding does not apply (Chrome matches
the origin string), so the requirement is genuinely "own that port".

**CLOSED.** `ext/manifest.json` now lists exactly one origin in both
`externally_connectable` and `content_scripts`: `https://daimond.oxedyne.com/*`.
The two localhost entries are gone.

**1.7 The machine-hand grant is one global boolean, not per-origin.** CONFIRMED.
`ext/hand.js:82,188-195`. Granted from `127.0.0.1:8777`, `localhost:8777` then
reached the host with no window shown at all. Compare `background.js:159-208`,
where site grants are real per-origin `chrome.permissions` patterns that Chrome
itself enforces: the new path is markedly laxer than the old one it was supposed
to match.

**CLOSED.** The grant is a per-origin map (`ext/hand.js`, `{ '<origin>': { at,
caps } }`) rather than one boolean, and the window is shown per origin, so a
grant made from one origin is not a grant to another.

**1.8 `apply_fence` is a no-op that returns success.** `exec.rs:695-700`, called
at `:255`. Gate 1 says a command that cannot be fenced must be *refused*; this
one runs. `fence.net` is never consulted anywhere in `exec.rs`, so the
tainted-turn network rule — the whole answer to prompt injection — is not
enforced at all. A no-op returning `Ok` is the fail-open shape the README warns
against; it should be a refusal or a compile-time gate.

---

**CLOSED.** The fence is really applied. `exec.rs` re-executes the hand as a
launcher, applies the plan there, and becomes the command through a safe
`CommandExt::exec`; `Runner::spawn` plans with `Unfenced::Refuse` and refuses
where the plan is not fenced, and `Desk::exec` makes the same check before
anything is written down or run. `fence.net` reaches the plan. This is release
gate 4, and it landed.

## Severity 2 — the journal does not hold

**2.1 An arbitrarily truncated history verifies as intact.** CONFIRMED.
`journal.rs:1831-1851`. `verify_dir` walks whatever files exist and never checks
that the newest is the newest. From a 29-file journal, deleting the last three
files gave `Intact { entries: 79 }`, and the hand then resumed appending and
*stayed* intact. Blanking the final file to zero bytes does the same
(`verify_file:1740` treats an empty file as intact). Nothing persists a
high-water seq or head, so nothing could detect it. The module doc claims only
the live file's tail is unprotected; in fact **any suffix of history erases
silently** — which is precisely the property a tamper-evident log exists to deny.

**CLOSED.** The journal keeps a high-water mark of its own (`head.json`, written
alongside the chain), so the newest file and the newest entry are recorded rather
than inferred from whatever files happen to exist. Proved by three tests: deleting
whole files off the end no longer verifies as intact, a hand reopened on that
history refuses to carry on as though nothing were missing, and blanking the final
file to zero bytes is caught as the erasure it is.

**2.2 One planted filename destroys the record, permanently and silently.**
CONFIRMED. `journal_files:1365-1385` accepts only 8-digit names, but
`maybe_rotate:1195` and `open:1074` increment past them. Planting
`hand-99999999.jsonl` — which any process running as the user can do, and which
until gate 4 lands means *every command the hand runs* — makes the hand write to
`hand-100000000.jsonl`, which `journal_files` never returns. Nothing is verified
and every later launch rotates into it again from a fresh chain. If the planted
file is empty instead, the hand appends a second chain starting at seq 0 and
`verify_dir` reports Broken forever, making real tampering indistinguishable
from the plant. A *directory* with that name makes both `open` and `verify_dir`
return `Err`, so under "journal before acting" the hand can never act again.

**CLOSED.** The directory is read by one function (`survey`) that accounts for
every file it finds rather than returning only the ones it liked, so a planted
name is visible instead of invisible. All three shapes the finding names have
tests: the highest name the format allows must not push the hand into a file
nothing verifies, an empty plant must not fork a second chain from zero, and a
*directory* wearing a journal file's name must not stop the hand from ever acting
again.

**2.3 Credential values reach the journal through eight unredacted fields.**
CONFIRMED. `Event::from_resp:574-598` applies no redaction whatever:
`Refused.reason` and `Error.message` are recorded verbatim, and a refusal that
quotes the offending command — the natural wording, and what the app's own
refusals do — writes the secret straight in. Also verbatim: `cwd`, `id`, env
*keys*, `fence.rw/ro/deny` paths, `mechs`, `Hello.client`. One secret reached
the file eight times in a single probe.

**CLOSED.** Every free-text field now goes through the same scrubber before it is
written: `Refused.reason`, `Error.message`, `cwd`, `id`, environment keys, `mechs`
and `Hello.client`, and the fence's `rw`/`ro`/`deny` paths as well — a directory
can be named after a token. The count of redactions is recorded in the entry.
Tested through the constructors the message loop actually calls, not only through
the helpers.

**2.4 `redact_argv` caught 0 of 12 real credential shapes.** CONFIRMED.
`journal.rs:754-802`. All twelve returned `cut=0`, including
`https://oauth2:ghp_…@github.com` (the prefix list uses `starts_with`, so a
token *inside* a URL is missed — the commonest way a token lands in argv),
`postgres://u:pw@db`, `--header=Authorization: Bearer …`, `--PASSWORD=x` and
`--Token x` (`SECRET_FLAGS` compares case-sensitively while the header check
lowercases), `--secret-access-key`, `--private-key`, `-phunter2`. Latent bug:
`&a[..h.len()]` at `:784,795` indexes the original string by the lowercased
length; no panic is reachable with today's constants, but one added constant
containing `k` or `s` makes it a slice panic.

**CLOSED.** `redact_argv` was rewritten around a scrubber with separate passes for
credentials inside a URL, `--flag=value` pairs and known prefixes, case-folded
where the review found it case-sensitive. The twelve real credential shapes that
all came back `cut=0` are a test, and the latent slice panic — indexing the
original string by the lowercased length — is gone with the code that did it.

**2.5 No locking; two hands permanently break the chain.** CONFIRMED. Nothing
takes a lock. Two `Journal::open` on one directory both resume at the same head,
and interleaved appends produced `Broken`. Chrome can launch more than one host,
and the design explicitly expects one per tab.

**CLOSED.** The journal takes an exclusive `flock` through `File::try_lock` (safe
Rust, no dependency; it is why `Cargo.toml` names a minimum toolchain). A second
hand on the same directory is refused rather than allowed to interleave, and there
is a test for two hands both thinking they own the chain.

**2.6 A journal write that reaches nothing returns `Ok`.** CONFIRMED.
`flush:1128` writes to a held descriptor; after the journal directory was removed
mid-run, `append` returned `Ok` and the refusal vanished.

**CLOSED.** `flush` calls `sync_data` and returns the failure, so a write that
reaches nothing is an error and "journal before acting" refuses rather than
proceeds.

**2.7 The Rust verifier and the documented shell verifier disagree.** CONFIRMED.
`str::lines()` strips a trailing `\r`, so a CRLF-converted journal verifies as
intact in Rust while the documented `sed | sha256sum` mismatches every line. Two
"independent" checks that disagree is the one failure this product cannot
afford.

**CLOSED.** The verifier splits on `split_inclusive('\n')` rather than `lines()`,
so a `\r` is part of the line it is part of, and the Rust and shell verifiers
agree on a CRLF-converted journal. There is a test that converts one and checks
both.

**2.8 Nothing calls the journal.** `main.rs:57` has no message loop, and neither
`exec.rs` nor `fence.rs` references `Journal`. "Journal before acting" is
asserted nowhere in code and by no test.

---

**CLOSED.** `main.rs` has the message loop, and it opens the journal before it
serves anything — no journal, no service. The handshake, every command, every
signal and the closing line are written, and a command whose record cannot be
written is refused rather than run.

## Severity 3 — protocol and process

**3.1 `chunk_fit` has no callers, and the shipping path can emit an unsendable
frame.** CONFIRMED. `codec.rs:1045`; `exec.rs:606` splits at a fixed `CHUNK_MAX`
without measuring. The `id` is caller-supplied and echoed on every chunk, and
`tools.rs` builds it as `run-{argv[0]}` from **model-chosen text**. A 300 KB
`argv[0]` plus one `CHUNK_MAX` run of control bytes measures 1,086,504 bytes;
`write_resp` returns `FrameTooBig` and the run's output is dropped. The
"measured, not calculated" property is true of a function nothing calls.

**CLOSED.** The writer measures. `main.rs` calls `resp_fits` before writing and
`chunk_fit` to decide where to cut, so the caller-supplied `id` is paid for rather
than assumed; an oversized chunk is cut and the loss is reported, with tests for
both.

**3.2 Trailing content after the first JSON value is silently discarded.**
CONFIRMED. `codec.rs:565,668`. A frame containing two `exec` objects runs the
first and never sees the second, while any reviewer, journal or policy layer
reading the same bytes with a real JSON parser rejects the frame outright or
sees something different.

**CLOSED.** `want_strict_json` scans exactly one value and refuses any trailing
bytes, naming the offset where the message ended. A frame carrying two objects is
refused rather than half-obeyed.

**3.3 An oversized frame poisons the stream permanently.** CONFIRMED.
`codec.rs:891-896`. `INBOUND_MAX` is 1 MB but `ext/hand.js:104` forwards
anything under 60 MB. On `LengthTooBig` the body is never consumed, so the next
four body bytes are read as a length prefix. Every queued request behind it is
lost, with no resynchronisation and nothing telling the page the real ceiling.

**CLOSED.** The reader consumes an oversized body before refusing it, so the next
read starts at a frame boundary, and the page is told the real ceiling. Beyond
`RESYNC_MAX` the connection is ended instead, because a prefix that large is not
a message that went wrong.

**3.4 `argv[0]` is never vetted against the fence.** CONFIRMED. `exec.rs:213`.
An absolute path outside the fence ran; `../outside/evil` ran; and a bare name
resolved through a caller-supplied `PATH`, because `env_clear()` then `execvp`
resolves against the *child's* environment, which the caller writes. Even with an
empty environment, glibc's `confstr(_CS_PATH)` fallback finds `/bin:/usr/bin`.

**CLOSED.** `vet_program` resolves `argv[0]` once, to an absolute path, checks it
against the plan, and hands the launcher something already resolved so nothing
resolves it a second time. An absolute path outside the fence, a `..` spelling
and a bare name through a caller-supplied `PATH` are all refused.

**3.5 `LD_PRELOAD` is settable by the caller.** CONFIRMED. `exec.rs:218-221`.
`README.md:39-41` states that a model able to name environment variables could
set `LD_PRELOAD`, and gives that as the reason the environment is not the
model's. The loop applies caller pairs verbatim with no screen. The guarantee is
stated and not implemented. (The app half sends `env:[]`, so this is reachable
only through 1.5/1.6 today.)

**CLOSED.** `screen_env` refuses the loader variables outright before anything is
spawned, so the guarantee `README.md` states is now implemented rather than
merely stated.

**3.6 A duplicate caller-chosen `id` makes a run unkillable and invisible.**
CONFIRMED. `exec.rs:282,472-474`. Two execs sharing an id leave one registry
slot: `live_count` reports 1 with two children alive, `stop_all` reaps one, and
the survivor outlives `Bye`. Conversely, when the shorter run ends it removes the
*live* run's entry, after which `signal` answers `Finished` for a process that is
still running.

**CLOSED.** An identifier already in use is refused before there is a second
child, in a sentence that tells the caller to pick another or signal the run it
already has. There is no repair after the fact, so it is prevented instead.

**3.7 `spawn` awaits the shared response channel, so one noisy run blocks every
later one.** CONFIRMED. With a flooding producer, a second `spawn` had not
returned after four seconds while its child was already running and unannounced.
A message loop that awaits `spawn` stops reading, so the `Signal` that would stop
the flood never arrives — head-of-line blocking on the one channel carrying both
control acknowledgements and bulk output.

**CLOSED.** The loop is three parts that cannot block each other: a reader thread
on stdin, a dispatcher that never awaits `spawn`, and a writer holding stdout,
with the hand's own responses on a separate channel from bulk output. Proved by a
test that floods one run and shows the next request still being served.

**3.8 No total output cap.** CONFIRMED. `yes` with a three-second timeout
delivered 3,406,442,688 bytes in 52,067 chunks. Memory is bounded, which is
good; nothing bounds the total, so the journal and the extension pipe absorb
gigabytes from one command.

**CLOSED.** `OUTPUT_TOTAL_MAX` bounds a run at 20 MB across both streams
together, with one marker saying what was dropped. The *true* totals still travel
in `Ended`, so nothing is hidden — which is what 1.17 then uses.

**3.9 Registry entries leak when `Started` cannot be sent.** CONFIRMED.
`exec.rs:280-289`. The insert precedes the send; on send failure `spawn` returns
`Err` without removing. Five attempts left five permanent entries that no signal
can clear.

**CLOSED.** The registry entry is removed when `Started` cannot be sent, so a
failed announcement leaves nothing behind.

**3.10 Group signalling degrades silently on BusyBox.** CONFIRMED for the
behaviour, PLAUSIBLE for the consequence. `busybox kill` rejects the `--` form,
and both call sites (`exec.rs:442-445,450-453`) discard the result with `let _ =`.
On Alpine — a realistic Cloud-tier host — `Kill` degrades to killing only the
direct child while the page is told `Ended{killed:true}`. `exec.rs:670-675` also
returns on the first binary that *spawns*, so a working `/usr/bin/kill` is never
reached.

**CLOSED.** A real BusyBox 1.37 was put in front of the code path, linked as
`kill` so its own applet answers, and the finding was measured rather than
reasoned about. The behaviour is confirmed and the *consequence* was wrong in a
way worth recording:

```
busybox kill -s TERM -- -<pgid>   rc=1  stderr "kill: invalid number '--'"   group killed
busybox kill -s TERM    -<pgid>   rc=0                                       group killed
procps  kill -s TERM -- -<pgid>   rc=0                                       group killed
procps  kill -s TERM    -<pgid>   rc=1  (silent)                             group killed
```

BusyBox counts the unreadable operand as an error and carries on to the next
one, so the group *does* die — what is lost is the exit status, not the signal.
That made the consequence the opposite of the one recorded: with the discarded
result now kept, BusyBox produced `Degraded`, and `supervise` would have sent the
page “anything it had started may still be running” about a group that was
already gone, and escalated a `Term` to a hard kill of the child on the strength
of it. No system takes both spellings, so one hard-coded form cannot serve both.

`signal_group` now asks each `kill` which spelling it takes, by sending signal 0
— the null signal, which validates arguments and delivers nothing — to the hand's
own process, and then signals once in the form that binary accepts. The obvious
alternative, sending with `--` and retrying without it, was tried and rejected:
it sends a second signal to a group the first has already emptied, and whether
that reports success turns on whether the leader has been reaped, so the sentence
the user reads would depend on the caller's bookkeeping rather than on what
happened to their command.

Proved by `exec::tests::a_busybox_kill_reaches_the_group_and_says_so`, which
asserts the fixture really does reject `--` (so it stands for the finding rather
than standing in for it), that the probe answers `Bare` for BusyBox and
`Separated` for the system's `kill`, and that a real group with a real grandchild
dies and is reported `Sent`. Against the shipped code that test fails with
`Degraded("… exited 1 (kill: invalid number '--')")`. The test skips silently
where no BusyBox is installed rather than claiming a proof it did not perform.

**3.11 `u64` fields do not survive the JavaScript half.** CONFIRMED. `seq`,
`out_bytes`, `err_bytes` and `timeout_ms` exceed `Number.MAX_SAFE_INTEGER`;
`seq: u64::MAX` reads back as `18446744073709552000` under `JSON.parse`.
`www/js/hand.js:98` compares `msg.seq !== want`, so the gap detection depends on
a value the wire cannot faithfully carry.

**CLOSED, by refusing rather than clamping.** `wire.rs` now states the ceiling
as part of the contract — `SAFE_INT_MAX`, 2^53 − 1 — and it binds all five `u64`
fields the wire has: `Chunk.seq`, `Output.seq`, `Ended.out_bytes`,
`Ended.err_bytes` and `Exec.timeout_ms`. Every one of them is read through one
function in `codec.rs`, so a `u64` added later inherits the rule by being read the
same way, and every one is checked again on the way out, before a byte is
written. The rest of the wire's numbers are `u32`, `i32` or `u16` and cross
unharmed; `exit` is `i32` at both ends, so `-1` survives.

Clamping was the obvious fix and is the wrong one, because it is the shape of
§1.11: a value quietly replaced by a plausible one, which is how a killed
`cargo test` was read as a green build. A clamped `out_bytes` would say nothing
went missing — which is precisely what §1.17 uses that field to detect — and a
clamped `seq` would make two frames compare equal, breaking the gap detection it
exists for. String encoding was the other candidate and moves the same ceiling
into every reader's `BigInt` handling, changing the contract for five fields to
fix a case none of them can reach. So the rule is the one with no silent arm: a
named `Fault` on decode, a refusal to write on encode, and no invented value at
either end. Nothing legitimate is refused — the ceiling is 800 exabytes of
terminal output, nine petabytes down one pipe, or a wall-clock limit of 285,000
years.

Proved by `codec::tests::every_wire_number_is_refused_past_what_javascript_can_hold`,
which fails against each of the four guards removed in turn, and end to end
against the release binary over a pipe: an exec carrying `timeout_ms: 2^60` is
answered with the named fault, the command does not run, and the next exec on the
same connection runs normally.

Two residuals, neither of them this finding. A frame that fails to decode is
answered with `Error{id:null}`, so a page waiting on that run learns nothing
until its own grace timer fires — true of every malformed field, not just this
one, and unreachable through the extension, which screens `timeout_ms` before
forwarding. And `exec.rs`'s `clamp_timeout` still narrows a limit above 24 hours
silently; that is a policy ceiling on an input rather than a misreported result —
the run is killed and `timed_out` says so — but it is the same family and worth a
sentence to the model one day.

**3.12 The decoder accepts JDAT, not JSON.** CONFIRMED. `codec.rs:260`.
`{'t':'bye'}`, `{t:"bye"}`, a trailing comma, a `#` comment and typed values are
all accepted and all rejected by `JSON.parse`. Reachable in Cloud mode, where
the bytes are not Chrome-serialised.

---

**CLOSED, with 3.2, by the same function.** `want_strict_json` is a JSON scanner
run before the JDAT decoder, so single quotes, unquoted keys, trailing commas,
`#` comments and typed values are refused rather than accepted by a superset. Each
of the accepted spellings the finding lists is a case in the test.

## Severity 4 — the page relay

**4.1 `www/js/hand.js` is dead code.** Nothing calls `init`, `setExtId` or
`adopt`; `run()` never sends `hello` and never listens for one, so `state.root`
can never be populated and `Tool::run` always refuses. `dev/verify_hand.mjs`
drives the raw port and never loads this file, so none of it is covered by any
test. Written by the lead and not wired in.

**CLOSED.** `www/index.html` loads `js/hand.js`, `js/daimond.js` calls
`DaimondHand.init(...)`, and `src/wasm/hand.rs` binds the object the `run` tool
reaches through. It is wired at every joint the finding said it was not.

**4.2 A hostile or buggy host holds the page open for ever.** CONFIRMED.
`www/js/hand.js:138-146`. Any message carrying a `t` field resets the grace timer
*before* the type is dispatched, so `{"t":"noop"}` every 700 ms leaves the promise
pending indefinitely — the exact failure `REPLY_GRACE` exists to prevent.

**CLOSED.** An unknown message type touches no timer and no run, so a host
repeating `{"t":"noop"}` cannot hold the promise open.

**4.3 A genuinely quiet command is killed at 30 seconds.** CONFIRMED.
`www/js/hand.js:66,144`. The grace period is refreshed only by output, so a host
that sends `started` and then nothing is rejected with "stopped part-way through
the command" while the process is still alive. This is precisely the `cargo test`
case the file header says the design is for.

**CLOSED.** The grace period is no longer refreshed by output alone, so a `cargo
test` that says nothing for a minute is not reported as a host that died
part-way.

**4.4 Chunks accumulate with no cap.** PLAUSIBLE. `www/js/hand.js:103,167`.
`CHUNK_MAX` bounds a frame; nothing bounds the total, so a command printing many
gigabytes exhausts the tab long before `truncate_output` in `tools.rs` runs.

---

---

**CLOSED.** The page keeps 256 kB of each end of a stream and states in the middle
what was dropped, so a runaway command cannot grow an array until the tab dies and
nobody reads a hole as continuity. Both ends rather than the first, because a
build says what it is doing at the start and why it failed at the end.

## Severity 1 (continued) — the app half, and the seams

**1.9 `ToolContext::no_write` is never populated in the browser build.**
CONFIRMED. `src/wasm/app.rs:221` `set_diamond_scope` is the only thing that ever
builds `diamond_bounds`, and it has **no caller anywhere in the repo**; the
daimon's own steering context sets `no_write: Vec::new()` explicitly
(`src/wasm/app.rs:689`). So `fence_spec` always takes the `rw.push(root)`
fallback and every command is fenced to the entire granted folder.

The claim at `src/tools.rs:1959-1960` — "a daimon's command reaches exactly the
files its `file_read` would have reached" — is therefore **false**: `file_read`
is pinned to OPFS `diamonds/<id>`, and the command gets the whole grant. Every
other divergence below concerns a translation that nothing currently feeds.

**OPEN at the time of this pass, and being closed elsewhere.** `set_diamond_scope`
now documents this finding by name and is written to scope the whole turn — both
doors, the file tools and the fence — but a search of `www/js` finds no caller,
so the browser build still takes the `rw.push(root)` fallback. A separate agent
was landing the caller as this was written; whoever reads this next should check
`www/js` for the call before trusting either state.

**1.10 `fence_spec` is not a faithful restatement of `Bound`.** CONFIRMED, three
ways, each reproduced by a test.

- *The allow-list-before-carve-out ordering is not preserved.* `tools.rs:253`
  pushes every `Bound::MayRead` into `ro` unconditionally, while
  `ToolContext::may_read` tests `within_allow_list` first and refuses. With a
  Diamond's bounds plus `MayRead("elsewhere/secrets")`, the app refuses the read
  and the fence grants it. The `.daimond` deny does not rescue it, because
  `fence.rs:1050-1057` expresses a deny as the *absence* of a rule, so a narrower
  `ro` grant beneath it survives.
- *Any `MayRead` defeats the absent-allow-list guard.* `tools.rs:260` tests
  `rw.is_empty() && ro.is_empty()`; a skill's carve-out fills `ro`, so the guard
  never fires and `rw` stays empty. A skill-bounded turn that may write the whole
  workspace in the app gets a fence with **no writable root at all**, and
  `vet_cwd` then refuses every command. The condition is the bug.
- *A `NoWrite` nested inside an `OnlyUnder` is dropped.* `tools.rs:250` demotes
  only when the `OnlyUnder` sits inside a `NoWrite`, never the reverse, so
  `attached=["proj"], read_only=["proj/docs"]` yields an `rw` covering
  `proj/docs`. Not exploitable end to end — `fence.rs` carves `ro` out of an
  enclosing `rw` — but the spec read alone says "writable", so any second
  consumer (a log line, the grant window, a non-Landlock backend) reads it wrong.

**CLOSED, all three ways.** The allow-list is tested before the carve-out, so a
`MayRead` outside a Diamond's bounds is dropped from `ro` exactly as `may_read`
would refuse it. The absent-allow-list guard now asks whether an allow-list was
*declared* (`if !scoped { rw.push(root) }`) rather than whether the lists came out
empty, so a skill's carve-out no longer defeats it. And a `NoWrite` nested inside
an `OnlyUnder` is re-stated as a read-only root for the hand to carve, in both
directions, so the spec read alone now says what the fence does.

**1.11 A killed or crashed command is reported to the model as `exit code: 0`.**
CONFIRMED. `tools.rs:2040` uses `extract_json_number`, which returns
`Option<u64>` and fails to parse `-1`, so `.unwrap_or(0)` makes it zero.
`ext/hand.js:321` sends exactly `{exit:-1, killed:true}` when the native host
dies mid-run, and `wire.rs:206` reserves `-1` for "no exit status". The daimon
reads partial output plus `[exit code: 0]` and reports a broken build as green.
`killed` is never read by `run_result` at all, so nothing else catches it.

**CLOSED.** `run_result` reads the status with `extract_json_i64`, so `-1` is
`-1`, and the three cases are told apart in the sentence the model reads: timed
out, stopped before it finished, or did not finish and reported no exit code. The
comment at that line records why, because this was the worst defect of the
session.

**1.12 `src/handler.rs:530` assigns rather than composes.**
`narrowed.ctx.no_write = skill_bounds(&dirs)` discards any allow-list already on
the context. The composition documented at `tools.rs:126-129` — "the two compose,
and the allow-list wins" — describes something no code does. If a Diamond-scoped
registry ever reaches that line, the Diamond's fence is deleted outright.

**CLOSED, and the documentation was the one telling the truth.** `src/tools.rs`
now has `compose`, and `src/handler.rs:537` calls it: a skill's bound is merged
into whatever the turn already carried rather than written over it. The rule is
the one the doc comment always claimed — a path survives only where BOTH lists
permitted it — and it is now stated as an invariant rather than a description.
**Composing can never widen either input**, so that line can only narrow, which
is what makes it safe to call from anywhere a bound is set.

Rule by rule. Allow-lists INTERSECT, and the intersection of two prefix sets is
exactly expressible rather than approximated: where one prefix contains the
other the answer is the deeper of the two, and where they are disjoint it is
nothing. Nothing becomes `Bound::Nowhere` and NOT an empty list -- an empty
allow-list reads as no allow-list at all, which is the widest answer there is to
the narrowest question, and that is the empty-prefix trap arriving through the
merge. Denials union. A read carve-out survives only where the other list would
have permitted the whole of its subtree anyway, because `may_read` answers a
carve-out before it looks at any deny, so one carried across would punch through
the other list's denials. A `Toolkit` survives only where both sides granted it:
a toolchain is machine paths a command may reach, and carrying one into a turn
whose other bound granted none would widen that turn's fence.

One consequence is worth saying plainly rather than discovering. **A skill
running inside a Diamond cannot read its own shipped references.** A carve-out
is a hole punched in its own deny fence, and `Bound::MayRead` has always said it
does not escape an `OnlyUnder`; the Diamond denies the whole of `.daimond/` and
allow-lists none of it, so the hole closes. The skill is refused in those words
rather than the Diamond being quietly widened to fit it. Nothing behaves
differently today -- the native handler's context carries no bounds, so a skill
turn composes to exactly `skill_bounds`, as it did when the line assigned -- and
the day skills are wired into the browser this fails closed and loudly instead
of silently and open.

Ten tests, and not one of them passes on the code it replaced: eight fail when
the second bound is assigned over the first, seven fail on the other order, and
the union is all ten. The four-way case is
`test_a_turn_bounded_twice_reaches_what_both_permit_00` -- own Diamond readable
and writable, other Diamond refused, Daimond's own directory refused, the
skill's carve-out subordinate to the allow-list and alive again the moment the
turn is not scoped. The walkers are checked too, in both directions: an
allow-list the merge could have dropped, and a deny the merge could have dropped
inside one. And the section checks itself: `composition_checks` holds eighteen
named effects of the merge, and
`test_every_check_here_fails_on_the_assignment_it_replaced_00` runs every one
against both assignment orders and asserts that twelve of them are wrong under
an assignment. The other six are declared as liveness checks, so the count means
what it says.

`DaimondApp::set_diamond_scope` now composes as well, so that a second caller
can never widen the first: on a freshly built app it is the identity, re-scoping
the same Diamond is idempotent, and re-scoping a *different* one intersects to
`Bound::Nowhere`, which `diamond_scope` reports and the caller already refuses to
start a turn on.

**1.13 The first command of a turn costs the turn its network.** CONFIRMED.
`run_result` wraps output through `ctx.wrap_untrusted`, which sets `tainted`, and
`Tool::run` reads `is_tainted()` when building the fence. So `cargo fetch`
succeeds and then every later command in the same turn gets `net:false`, with no
explanation the model can act on. The gate itself is sound — one-way flag, read
at fence-build time, no ordering hole — but treating a command's own output as
tainting input makes the network rule fire on the second command of every
ordinary build session. A design decision, not a slip, and it needs revisiting.

**OPEN — a recommendation, for the user to decide.** The change lives
entirely in `src/tools.rs`, which the agent that examined this does not own, and
it narrows or widens a security boundary either way, so nothing was altered.

*Exactly what happens now.* `Tool::run` builds the fence with
`fence_spec(&ctx.no_write, &machine, ctx.is_tainted())` (`tools.rs:2766`) and
`fence_spec` sets `net: !tainted` (`:904`). Every `run` ends by returning
`ctx.wrap_untrusted(&origin, &s)` (`:2915`), and `ToolContext::wrap_untrusted`
sets `tainted = true` (`:1507`). The flag is one-way within a turn. So the first
command that *runs* costs the turn its network, whatever it was and whether or
not it printed anything; a command that is *refused* returns before the wrap and
does not. The same flag also arms `egress_check`, so `web_fetch` and `web_open`
start asking for consent from that point on.

*What it costs.* `cargo fetch` then `cargo build`; `npm install` then `npm test`;
`git fetch` then `git pull` — in each pair the second command runs with no
network and fails with the toolchain's own offline error. The model reads a
network failure it has no way to attribute, and the most likely thing it does
next is report the project as broken, which is §1.11's failure mode arriving by a
different road. The turn that most needs the network is a build, and a build is
the thing this makes offline.

*Why the rule is nonetheless right.* Command output is not the user's words. A
build log carries a dependency's name, a test fixture, a fetched page; `curl` is
an argv like any other. Marking it untrusted is the same judgement `shell`
already makes and should not be undone. The defect is not the mark — it is what
the mark is wired to, and that it is silent.

*Recommendation, in the order it should be done.*

1. **Say it.** ACCEPTED, and it is the only one being done. This loosens nothing,
   and it turns an unattributable build failure into a fact the model can report.
   The exact change follows, since `src/tools.rs` is not this agent's to edit.

   *Where.* `Tool::run`'s `wasm32` arm already reads the flag that decides the
   fence:

   ```rust
   let fence = fence_spec(&ctx.no_write, &machine, ctx.is_tainted());
   ```

   Capture it there — `let no_net = ctx.is_tainted();` on the line above — and
   pass it to `run_result`, which composes the text the model reads. Reading
   `ctx.is_tainted()` inside `run_result` happens to give the same answer today,
   because nothing between the two calls taints the turn and `run_result`'s own
   `wrap_untrusted` is its last statement — but that is an accident of ordering
   and the next edit to that function breaks it silently. Pass the value.

   *What.* One more arm on the `tail` that already carries `[exit code: 0]` and
   `[timed out; the command was killed]`, appended after it, outside the
   untrusted envelope because this is the app speaking and not the command:

   ```rust
   if no_net {
       s.push_str(
           "\n[no network: this turn has already read content from outside your \
           workspace, so every command in it runs with the network refused. A \
           fetch, install or clone fails for that reason and not because the \
           project is broken — say so rather than retrying, and ask in a new \
           message for anything that needs to reach out.]");
   }
   ```

   *Why unconditionally rather than only on failure.* Deciding which failures are
   network failures means matching prose from `cargo`, `npm`, `git` and every
   other toolchain, which is the guessing this is meant to end. The cost is one
   line of noise on a command that did not need the network; the benefit is that
   the one that did needs no guessing at all.
2. **Ask rather than withdraw.** Put the `run` case through the consent path
   `egress_check` already has: on a tainted turn, a command that would have had
   the network prompts once, naming the command, and the answer holds for the
   turn. The review's own text says the gate is sound; it is the silence that is
   wrong, and a user watching `cargo build` will say yes while a user watching an
   unexplained `curl` will not.
3. **Grade the taint** — only with the user's explicit agreement. Split
   `TurnState::tainted` into *outside content* (a fetched page, a message, an
   attachment) and *machine output* (a command's own stdout), and let
   `fence_spec` read the first while the envelope and `egress_check` continue to
   read both. A command's output is the machine's words, from programs the user
   installed, in the user's own workspace — a step removed from a stranger's
   words in a page, but not zero, since a dependency's build script prints
   whatever it likes. That is a genuine narrowing of a boundary and belongs to
   the user, not to an agent tidying a review.

**1.14 Nothing checks that the hand's `root` is the app's workspace.** PLAUSIBLE.
`Tool::run` joins workspace-relative paths onto whatever folder the hand reports.
With an OPFS-only workspace, or an FSA folder different from the grant, the fence
names paths on the machine that have nothing to do with the files the model just
read. No folder-identity token exists on the wire.

**CLOSED at both ends.** There now is a folder-identity token, the page compares
it against the folder it has open, and a command is REFUSED where the two cannot
be shown to be the same folder.

*The hand's half.* It writes a random 32-hex token to
`<root>/.daimond/workspace.id` and publishes it in `caps` as `ws:<token>`, beside
the `root:` entry that was already there. The two answer different questions:
`root:` says *where* the hand will work, and `ws:` is what lets the page find out
whether that is the folder it is looking at — which a path alone cannot settle,
because the File System Access API gives the page a handle and never a path.

It lives inside `.daimond` deliberately. A fence always denies that directory, so
a command cannot read the token, and a command that has been talked into helping
cannot answer a challenge about a folder it is not in. The token is written once
and kept, so it identifies the folder rather than the run, and a page that
remembers it notices its workspace being swapped underneath it. Where no token
can be established — an unwritable grant — the hand publishes `ws:unproven`
rather than silence, because a page cannot tell silence from an older hand. A
token can never be the word `unproven`, so one string settles both questions.
`--report` prints the folder and its identity too, since both are configuration a
person can get wrong and neither was visible anywhere before.

Proved by `main::tests::the_page_is_told_which_folder_this_is`, five properties
each of which fails against a deliberately broken version: the token on the wire
is the token in the file, it survives a restart, two folders never share one, a
planted line is replaced rather than published, and an unprovable folder is said
to be unproven rather than given an identity anyway. Confirmed against the
release binary over a pipe, whose `hello` carries
`ws:f3540427d40b90dcffc6bb7a7e4feb90` matching the file on disk and the line
`--report` prints.

*The page's half, in `www/js/hand.js`.* The hand holds one of the two names and
can only supply evidence; the comparison belongs where both names meet, and that
is the page. Once per grant — and again whenever the folder changes — it opens
`.daimond` and then `workspace.id` through the directory handle it holds, passing
no `{create: true}` to either call, because a page that creates the file is a page
that has proved nothing. It takes the first line that is neither blank nor a `#`
comment and compares it with the `ws:` value, exactly, as strings. The file's four
comment lines are why the token is not simply the first line:

```
# Daimond wrote this so that the browser and the machine hand can tell whether
# they are talking about the same folder. It is not a secret and not a key.
# Deleting it costs nothing: the next hand to start writes a new one, and the
# page will ask you to confirm the folder again.
75111c6348d13219899a27405d5a769f
```

The verdict is reached in `status()`, which is the one door every route to a
command already goes through: `Tool::run` reads it before composing a fence,
`pty_request` reads it before opening a terminal, and the Terminal panel shows its
`reason` where it will not open one. So a single refusal closes all of them, and
what the model is handed is a sentence rather than the output of a command that
ran somewhere else.

**The four outcomes, and what the user reads.**

- **Equal.** Nothing is said and nothing is shown. This is the ordinary case and
  it stays silent, or the check becomes a dialog people learn to dismiss.
- **Different, or the file or the `.daimond` directory is missing through the
  handle.** Refused, with: *"The folder you opened in Daimond is not the folder
  the machine hand was told to work in, so a command would run against different
  files from the ones Daimond has been reading. Daimond has «the folder's name as
  the page knows it»; the hand has «the `root:` path». Fix the path in the hand's
  root.txt, or open the other folder here."* Both ends are named, because the two
  fixes are different and the user cannot otherwise tell which end is wrong.
- **No folder at all — an OPFS-only workspace.** Its own case, and not one to
  skip for want of a handle: there is nothing to read the token through, so the
  check cannot pass, and a check that is skipped when it cannot pass is not a
  check. *"This workspace lives in the browser and not in a folder on this
  machine, so there is nothing for the hand's commands to run against. Open a
  folder for this workspace before using the machine hand."*
- **`ws:unproven`.** Refused: *"The machine hand could not write its identity file
  into the folder it was granted, so the two ends cannot confirm they mean the
  same folder. The hand's own error output names the path that failed."*

A fifth thing can happen which is not an outcome of the comparison at all: the
page can fail to say what folder it has. That is refused in the same place and
for the same reason — a check that could not be made has not passed — and the
sentence says so, rather than blaming a folder.

**Two decisions inside that, which a later reader should not undo.**

*The folder's name is never compared.* Not as a fallback, not as a tie-break. Two
projects called `site` on one machine is the ordinary case rather than the exotic
one, and a check that passes for the wrong folder is worse than no check at all.
Both directions are tested: a `site` whose identity is wrong is refused, and a
folder called `moved` whose identity is right is allowed.

*Silence passes.* A hand that publishes no `ws:` at all is an OLDER hand, not a
mismatch. A page cannot tell an old hand from any other silent thing on that wire,
and refusing silence would break every mock host permanently while telling the
user about a folder they can do nothing about. It is a compatibility seam and it
is recorded as one in the source: a page that meets such a hand is back where it
was before this entry, and the proper place to close it is the protocol version,
where "this hand is too old to serve" can be said once and plainly.

The verdict is cached per grant AND per directory handle. Per grant alone was not
enough: the user opens a different folder in the Workspace panel while the hand
says nothing at all, so a remembered verdict would answer for a folder it had
never read — and it would do so in the direction that runs the command.

**How this is tested, given that no automated run can satisfy it.** A page holds a
real folder only through `showDirectoryPicker()`, a native dialog no harness can
answer, so every headless run has an OPFS workspace, which is the third outcome
and a refusal. There is no configuration in which this check passes by accident.
That is a fact about the browser and not a gap in the tests, and it is met in
three places:

- `dev/verify_wsident.mjs` is new and tests the refusal itself: 33 checks, of
  which 10 are proved against a deliberately broken `www/js/hand.js` served through
  a patch. The two folders are real `FileSystemDirectoryHandle`s taken from OPFS,
  each with a real `.daimond/workspace.id` in it, so `getDirectoryHandle`, the
  read, the comment-skipping and the compare all run for real; the only thing
  stood in for is the one thing a headless browser cannot have. The headline case
  is a hand granted folder A while the page holds folder B — both real folders,
  both perfectly good workspaces — refused, with the sentence naming `beta` and
  `/home/u/projects/alpha` in the same breath, and `pty_request` on the real wasm
  then refusing to open a terminal and passing that sentence on whole.
- `dev/verify_ptyedge.mjs` asserts the refusal once against the REAL hand — the
  relay's own `status`, and the engine refusing on the strength of it — and then
  wraps `status` so that the verdict, and only the verdict, is stood in for. Its
  subject is the composition of a terminal request and a real pty on this machine,
  and the hand's own account of itself passes through untouched, so every fence it
  composes is still the real one.
- `dev/verify_handreal.mjs` does the same at the other end of the chain: its first
  turn is now a REFUSAL, asserted on what the model was actually handed — a
  sentence, no nonce, no exit code — after which the same wrapper is installed and
  the file gets on with proving that a real process runs, that its real output
  reaches the daimon and that the kernel refuses what the fence denies.

Both wrappers substitute the folder verdict and nothing else, and both say so at
the point of use. `dev/verify_scope.mjs` had already taken the same route for the
whole of `status`, for the same reason.

**1.15 Release gate 1 is nobody's job.** CONFIRMED. `Tool::run` reads only `root`
from `status()` and ignores `caps` and `paired`; `apply_fence` is an empty stub;
`main.rs` has no message loop. Gate 4 is accurate, but gate 1 — refuse where the
fence is not in force — is unmet on *both* ends, so nothing in the pipeline would
refuse a command an unfenceable hand offered to run.

**CLOSED, at both ends.** In the hand, `Desk::exec` refuses where the plan is not
fenced, before the command is journalled or run. In the app, `Tool::run` reads the
hand's `caps` as the array it is — it was read with a string extractor, which
found nothing in `["fence:none"]`, so the refusal could not fire at all — and
`fence_enforced` answers affirmatively or not at all: an absent or empty list is
refused alongside `fence:none`, because a hand that will not say what it can
enforce has not said that it can enforce anything.

**1.16 Every disconnect is reported as "the hand is not installed".** CONFIRMED.
`www/js/hand.js:175-180` rejects with `NO_HAND` on any `onDisconnect`, including
after `started` and after chunks. A host that crashed, was killed, or blew
Chrome's 1 MB cap makes the daimon tell the user to install software they already
have.

**CLOSED.** `HAND_GONE` is kept apart from `NO_HAND`, and which one the user
reads depends on whether the hand ever greeted the page. Someone whose host
crashed is no longer told to install software they already have.

**1.17 A lost output tail is already detectable, and is not detected.**
CONFIRMED. `Resp::Ended` carries `out_bytes`/`err_bytes`, `www/js/hand.js`
forwards them, and `run_result` never reads them — three bytes were presented to
the model as a 900 kB stream. This retires the earlier concern about `Ended`
lacking a final `seq`: **the byte count already closes that hole**, it is simply
unused. `run.gap` is likewise set and never surfaced.

**CLOSED.** `run_result` compares the bytes that arrived against `out_bytes` and
`err_bytes` and says so in the text the model reads — "some output did not
arrive: N of M bytes" — and the relay's own account of a hole or a disconnect is
shown separately from what the command printed.

**1.18 Scoped workers cannot run a command with a default `cwd`.** CONFIRMED,
latent. `set_diamond_scope` sets bounds but leaves `path_prefix` empty;
`Tool::run` defaults `cwd` to `path_prefix`, and `may_read("")` is false under any
allow-list, so the command is refused as "not in this Diamond's workspace".

**CLOSED.** `path_prefix` is deliberately left empty for a scoped worker, whose
model writes whole workspace-relative paths, and `default_cwd` takes the first
`OnlyUnder` from the allow-list instead. A scoped worker with no `cwd` now lands
inside its own Diamond rather than being refused.

**1.19 `id` is `run-<argv[0]>` and is neither unique nor bounded.** CONFIRMED.
Two concurrent `cargo` runs share an id; `Req::Signal` and the journal both key
on it, so a cancel can reach the wrong run. Unbounded, it also drives 3.1.

---

**CLOSED.** The identifier is `run-<n>-<name>`, where `n` is a per-turn counter
and `name` is the program's basename filtered to a safe alphabet and cut at
`RUN_ID_MAX`. Two concurrent `cargo` runs no longer share an id, and an unbounded
one can no longer drive 3.1.

**1.20 A Diamond's crystal agent could read and write another Diamond, using a
path the model wrote.** FOUND while closing 1.12, and closed with it.

*The reproduction.* `steer_inner` (`src/wasm/app.rs`) gives the crystal agent
`no_write: Vec::new()` and relies entirely on `path_prefix` for its compartment.
`Tool::scoped` joined that prefix to whatever the model wrote --
`fmt!("{}/{}", prefix, rel.trim_start_matches("./"))` -- and never normalised the
result. `wasm::opfs::split_components` then resolved `..` lexically and refused
only a climb above the OPFS ROOT. A Diamond is not the root. So a daimon
steering its crystal and asking for `../beta/crystal.md` was handed
`diamonds/alpha/../beta/crystal.md`, which landed at `diamonds/beta/crystal.md`
-- another Diamond's private notes, inside OPFS, permitted, read and writable.
`guard` could not catch it: it tests the path as the model wrote it against the
turn's bounds, and this turn's bounds are empty, which permits everything.

Six more shapes did the same: a bare `..` and `./..` reached the `diamonds`
directory itself, `notes/../../beta/x.md` and `../../beta/x.md` reached a
sibling from the middle and from the start, `notes/../..` climbed two, and
`../alpha2/x.md` reached a Diamond whose name merely *begins* with this one's --
which is the shape a string-prefix containment test waves through. Only
`../../../../etc/passwd` was ever stopped, and by the wrong fence, with a
message about the workspace rather than about this Diamond.

**This is a model-controlled string leaving its compartment**, the same class as
the empty-prefix escape and reachable by any daimon steering a Diamond. The
instruction that produces the path may itself have come from a stranger's words.

**CLOSED.** `Tool::scoped` normalises the join and refuses what is not under the
prefix, in plain English that names the path, says it is outside this Diamond,
and says nothing was read, written or run. The containment test is `under`,
which compares whole segments, so `../alpha2` is the different Diamond it
actually is. Separators are unified first, so a backslash is not a containment
test that means one thing on one platform and another elsewhere. An absolute
path stays relative to the Diamond and cannot escape it, which is what
`Workspace::resolve` does natively. A turn with no prefix -- the user's own
workspace agent -- is untouched, and bounded by the OPFS root as it always was.

The doc comment records why this cannot be done with `may_read` instead, because
that is the repair the next person will reach for: that door tests the path as
the MODEL wrote it, so a crystal agent asking for `crystal.md` would be measured
against an allow-list of `diamonds/<id>` and refused for its ordinary work. It
is 1.18's collision from the other side -- a prefix and an allow-list are two
ways of saying where a turn lives, and a path can be checked against one, not
both.

Three tests, and the section counts itself: eighteen path shapes, of which nine
must now be refused, and three counters assert that seven of those nine landed
in another compartment before, one was stopped only by the OPFS root jail, and
one was harmless. The ordinary paths are pinned in the same table, so a fix that
simply refused everything would fail here. They run NATIVELY against the same
function the browser calls -- it is compiled for `test` as well as for `wasm32`,
so there is one implementation rather than two that drift -- but nothing in them
reaches the OPFS edge, which no native test can; where the old path landed is
shown through a model of `split_components` and not through the edge itself.

**Still open, and latent: `path_prefix` means two different things.** In the
browser it confines every file path; natively the file tools ignore it entirely
and jail on the workspace root instead, so it reaches only `default_cwd`. Every
native context sets it empty today, so nothing is wrong now -- and the day a
native turn carries a prefix, it will confine nothing. Wiring `scoped` into the
native transport is a no-op on today's values and would make the two agree.

## What was verified as genuinely sound

Worth recording, so a later reader does not re-litigate what has already been
checked:

- **`argv`, never a shell string, holds.** Exactly two `Command::new` calls in
  `exec.rs`, no shell anywhere, metacharacters pass through literally. The
  `/bin/kill` argv is fixed strings plus a pgid from `child.id()`; no caller
  value reaches it.
- **The wire seam agrees end to end.** The exec JSON `Tool::run` composes decodes
  byte-for-byte in the hand, including `"stdin":null` → `None`, `"env":[]`,
  `timeout_ms` as `u64` and `capture:"both"`. Field names and enum spellings
  agree across `tools.rs` → `www/js/hand.js` → `ext/hand.js` → `codec.rs`, and
  the result keys `refused`/`stdout`/`stderr`/`exit`/`timed_out` all exist on
  both sides.
- **No JSON breakout.** `argv`, `cwd`, `stdin`, `id` and every fence path go
  through `json_escape`, which escapes `"`, `\` and all C0; `timeout_ms` is a
  parsed `u64`; and `extract_json_string`'s prefix test makes a `"refused":`
  planted in a command's own stdout unfindable. Attempted and failed.
- **The journal's cryptographic core is correct.** The hash was reproduced with
  coreutils `sed | sha256sum` over 200 entries containing emoji, DEL, U+2029,
  quotes, backslashes, tabs, CJK and 300-element argv, with zero mismatches. The
  `,"entry":"` boundary is *not* attacker-controlled: every field is located
  positionally from the end, never by search. Canonicalisation is RFC
  8785-correct on the values used. Tamper detection *within a present file* is
  genuinely good — edited, rehashed, deleted, reordered, duplicated and torn
  lines were all caught and correctly located.
- **`check_fence_at` survived every attack brought against it**, including a
  symlink onto the journal, `..` spellings through a symlink, relative roots and
  an `rw` parent with a `deny` naming the journal.
- **Native-messaging framing is correct** — 4-byte native-endian, `FRAME_MAX`
  below 1 MiB with slack, prefix counted into the total. `MAX_DEPTH` is really
  enforced: 100,000 open brackets return a named fault in milliseconds. Every
  hostile input tried returned a named `Fault`; nothing panicked, hung or
  allocated unboundedly.
- **Deny-inside-rw carving of real, non-symlink children works** — the denied
  file is unreadable and unwritable and siblings are intact. `..` resolution is
  correct component-wise. The refusal default on Linux never runs unfenced for a
  malformed spec. ABI is never silently rounded up, and partial enforcement is a
  hard error.
- **UTF-8 chunk handling is subtle and right** — split characters are rejoined,
  and text is re-bounded after `from_utf8_lossy` trebles invalid bytes.
- **Revocation reaches a run in flight**, with the right sentence. `dismissed` is
  kept distinct from `declined` and neither is treated as allowed. `bye` then
  disconnect leaves no orphan.
- Style is compliant throughout: no `unwrap()`, no `unsafe`, no `?`.

## What this means

The two claims the product would make about the hand are the two that failed.
That is not a coincidence: they are the claims that require an adversary to be
wrong about something, and the rest of the code only requires the author to be
right.

Three consequences follow.

1. **`Fence::holes()` was the most valuable thing in the fence, and it was
   incomplete.** It should list 1.1, 1.2 and the true severity of 1.3, and the
   capability list should stop implying a compartment that metadata syscalls walk
   straight through.
2. **The consent wording cannot ship as written**, per gate 3: the sentence is
   not what needs editing. On this kernel, "only inside the folders the workspace
   already allows" is false in at least three ways.
3. **A compartment on a kernel below ABI 9, with a reachable user session bus, is
   not a compartment.** That is a statement about Landlock, not about this code,
   and no amount of care in `fence.rs` changes it. Either the bus is made
   unreachable, or the claim is narrowed to what the fence genuinely delivers.

---

## And where those three stand

Written with the state lines above, against the same three consequences.

1. **`Fence::holes()` was made to say all of it, and then to stop saying two of
   them.** It named the symlink race, the metadata syscalls, the true severity of
   the session bus, the breadth of the system base, the leak of existence through
   `stat`, ungoverned UDP, descriptors opened before the fence, hard links, and
   the one place every command may write that the workspace did not name. Two of
   those are now closed by the syscall filter rather than by Landlock, so
   `holes()` is told what the filter refuses and drops exactly those two — a list
   that goes on describing a shut hole is as dishonest as one that leaves an open
   one out. `--report` prints the composed list from both layers, and the test
   asserts entries by keyword in *both* directions: the two must disappear when
   the filter is in force, and nothing else may.
2. **The consent wording can be revisited, and has not been rewritten here.**
   "Only inside the folders the workspace already allows" is now true of this
   kernel with the exceptions `--report` prints: the private temporary directory,
   the read-only system base, metadata reads, and the residue of the filter's own
   trade — `chmod 644` and the utime family, which stay so that `cargo` can unpack
   a crate. Gate 3 says the sentence is not what needs editing, and the sentence
   still has not been edited; what changed is that the claim behind it is now
   nearly the one the code keeps. 1.9 is what stands between "nearly" and "is".
3. **The bus was made unreachable.** The filter refuses `AF_UNIX` for every
   command, not only for one that was denied the network — the change that
   decision needed is at 1.3. So the honest description of the Machine tier is a
   fence that holds against a model and against a command that has been talked
   into something, on a kernel two ABI levels below the one that would make
   Landlock sufficient on its own. What it is not is a syscall sandbox: the filter
   is a deny-list, and it says so in `holes()`.
