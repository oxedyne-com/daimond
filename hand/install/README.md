# Installing Daimond's machine hand

Daimond runs in a web page. A web page cannot start a program — there is no
flag, no setting, and no future browser API that will change that. So if Daimond
is to run a build or a test on your computer, the part that actually starts the
program has to live outside the page, and something has to introduce the two.

That something is your browser. Chrome will start a small program on an
extension's behalf and connect the two by a pipe, but only if a file on this
computer names both of them.

**Two files, once.** One says which program the browser may start. The other
says which folder that program may work in. Nothing listens on a port, nothing
runs in the background, and there is no password to keep. That is the point of
doing it this way: a background service on a port would be reachable by any page
you visit, and its only defence would be a secret you had pasted somewhere. Here
there is nothing to find and nothing to steal — the browser is the doorman.

## What you need

- The **Daimond Hands** extension, loaded in your browser. See `ext/README.md`.
- A **folder** you are content for Daimond to work in. Not your home directory.
- The **hand** binary, built from this repository.

## Do this

All four steps, from the top of the Daimond repository. They take about a minute.

### 1. Build it

```sh
cargo build --release --manifest-path hand/Cargo.toml
```

`--manifest-path`, not `-p`: the hand is its own cargo workspace, so `-p` fails.

### 2. Say which folder it may work in

The hand will not serve a page until it has been told. It does not guess, because
a guessed folder is a guess about what a command may touch.

```sh
mkdir -p -m 700 ~/.local/share/daimond/hand/journal
echo "$HOME/work" > ~/.local/share/daimond/hand/journal/root.txt
```

Replace `$HOME/work` with the folder you chose. It must be an absolute path and
it must already exist.

Three things about this that are easy to get wrong:

- **`-m 700` is not decoration.** The journal holds a record of every command
  every Diamond ran, so the hand refuses to write it into a directory other
  users can read. It creates its own at `700`; a directory *you* create with the
  usual umask is `755`, and the hand will refuse to start. The message it gives
  talks about `DAIMOND_HAND_JOURNAL_DIR`; the fix is `chmod 700`.
- **The environment variable is a trap.** `DAIMOND_HAND_ROOT` does the same job
  and takes precedence, and it will not work for a browser you start from a
  desktop launcher, because your browser hands the hand *its own* environment
  and yours is not in it. Use the file.
- **`~/.local/share/daimond/hand/journal` is where the hand puts its journal**,
  and `root.txt` goes beside it. If you moved the journal with
  `DAIMOND_HAND_JOURNAL_DIR`, `root.txt` moves with it.

### 3. Register it with your browser

```sh
hand/install/install.sh
```

The script prints which browsers it found and which file it wrote in each. It
writes JSON and nothing else: it builds nothing, downloads nothing, starts
nothing, and needs no root.

### 4. Restart your browser

It reads these directories when it starts, and will not notice a file that
appeared while it was running.

That is the whole of it. Nothing is running yet.

## Check it before you open the browser

Two commands, both harmless, and between them they answer "is this thing set up,
and is it actually protecting me".

```sh
hand/target/release/daimond-hand --report
```

prints what the fence can enforce on *this* kernel, and — at greater length —
what it cannot. Read the second list. It is not boilerplate; on a kernel below
Linux 7.1 it includes a way out of the fence entirely.

```sh
hand/target/release/daimond-hand < /dev/null
```

starts the hand the way your browser will, with no browser at the other end.

- `daimond-hand: the page closed the pipe.` — configured, and ready.
- `This hand has not been told which folder it may work in` — step 2 is missing.
- `holds other things and is readable by users other than its owner` — the
  journal directory is not `700`. See step 2.

## Then, in Daimond

The first time Daimond wants to run something, a small window opens and asks
you. It is the same window that asks whether Daimond may operate a website, and
it works the same way: allow it, or don't.

This one has no second Chrome prompt behind it. There is no browser permission
for "may run programs on this computer", so that window **is** the approval, and
the extension remembers your answer itself.

Until you allow it, nothing can be run. Nothing starts on its own.

## What a command can actually reach

Worth knowing before the first thing a daimon runs fails in a way that looks
like a broken tool.

A command runs inside a kernel fence, and the fence is built out of the folder
you granted. On top of that the hand adds two things:

- **The system paths a program needs in order to be a program**: `/usr`, `/bin`,
  `/sbin`, `/lib*`, `/etc`, `/opt` and the harmless `/dev` devices, all
  **read-only**. Without them nothing can start at all — not even `cat`.
- **A private temporary directory**, writable, with `TMPDIR` pointing at it. It
  is the one place outside your folder that a command may write, it is removed
  when the run ends, and no other run can reach it.

Everything else is refused by the kernel, not by a check somebody wrote. Reading
a file one folder outside the grant comes back `Permission denied`, and the
daimon is shown that refusal rather than the file.

**The consequence for build tools.** A toolchain installed under your home
directory — `~/.cargo`, `~/.rustup`, `~/.nvm`, a `node_modules` you keep
elsewhere — is *not* reachable, and today there is no way to grant it: every
path in the fence is built by joining a workspace-relative name onto the folder
you granted, so nothing outside that folder can be named at all. A daimon can
run anything under `/usr/bin` and anything inside your folder. If you want it to
run `cargo test`, the toolchain has to be inside the folder you granted.

## Variants

### If you keep the binary somewhere else

```sh
hand/install/install.sh /path/to/daimond-hand
```

### If your browser keeps its profile somewhere unusual

```sh
hand/install/install.sh --dir /path/to/profile/NativeMessagingHosts /path/to/daimond-hand
```

A browser started with `--user-data-dir` reads `<that dir>/NativeMessagingHosts`
and nothing else, which is what this is for.

### To see what it would do, without doing it

```sh
hand/install/install.sh --list
hand/install/install.sh --help
```

## To take it back

Three different things, and all three are worth knowing about.

**Withdraw the permission.** Click the Daimond Hands icon in the toolbar.
"Running commands on this computer" is listed there beside the sites you have
approved, with a Revoke button. Revoking stops anything that is running at that
moment — not at the end of the current build, immediately.

**Take away the folder.** Delete `root.txt`. The hand then refuses to serve at
all, whatever the browser says, and the refusal is a whole sentence rather than
a silent nothing.

**Remove the registration.**

```sh
hand/install/uninstall.sh              # every browser found
hand/install/uninstall.sh --dir DIR    # one directory
```

That deletes the file `install.sh` wrote, so the browser can no longer start the
hand at all. The binary is left where it is; the script did not put it there.

## When it does not work

**"Daimond's machine hand is not installed on this computer."** The browser
looked and found no file naming the host. Either `install.sh` has not been run,
or it was run for a different browser than the one you are using, or the browser
has not been restarted since. `install.sh --list` shows where it looks.

**"The machine hand disconnected without finishing (Native host has exited.)"**
seen on the *first* command, before anything could have crashed, is almost
always step 2: the hand read its configuration, refused to serve, and exited.
Run `hand/target/release/daimond-hand < /dev/null` and it will say which of the
two reasons it was.

**"…did not say which folder it was granted."** The hand answered but named no
root. Same cause, different symptom: `root.txt` is missing, empty, or names a
folder that does not exist.

**"Installed but will not talk to this extension."** The file exists but names a
different extension. This happens if you loaded the extension without the pinned
key in `ext/manifest.json`, which gives it a different id. Find the real id at
`chrome://extensions`, then:

```sh
DAIMOND_HAND_EXT_ID=<the id you see> hand/install/install.sh
```

**"Disconnected without finishing", mid-command.** The hand stopped part-way.
Either it crashed, or it produced a single message over 1 MB, which Chrome
silently refuses to deliver and answers by cutting the connection. The hand
chunks its output well below that, so this should be a crash; its journal will
say.

**A command comes back `Permission denied` on a file you expected it to read.**
That is the fence, working. See "What a command can actually reach".

## The files here

| File | What it is |
|---|---|
| `install.sh` | Writes the host manifest into each browser's directory. |
| `uninstall.sh` | Removes it again. |
| `com.oxedyne.daimond.hand.json` | The manifest, for reading, and for registering by hand on a platform the script does not cover yet. `install.sh` writes its own copy rather than editing this one, so the path and the extension id are decided in exactly one place. |
| `mock_host.py` | A stand-in hand for testing, which speaks the real protocol and runs nothing. See below. |

## Other platforms

Linux is implemented. The others are not, and the paths are written down in
`install.sh` rather than left to be rediscovered:

- **macOS** uses the same file in a different directory
  (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`), and
  additionally needs the binary signed and notarised before Gatekeeper will let
  a browser run it. That is a packaging job, not a path.
- **Windows** has no directory at all: the manifest is found through a registry
  key under `HKCU\Software\Google\Chrome\NativeMessagingHosts\`, whose default
  value is the absolute path to the JSON file, which may live anywhere.

There is no fence on either yet, and the app refuses a command it cannot
contain, so a hand on those platforms would install and then refuse everything.

## Testing without the binary

`mock_host.py` speaks the real framing — a 4-byte native-endian length prefix
and UTF-8 JSON — and the real messages, and runs nothing at all. It exists
because the failures worth testing are ones a correct hand never produces: a gap
in the output sequence, a message over Chrome's 1 MB limit, and a host that dies
mid-command.

Register it like any other binary:

```sh
hand/install/install.sh hand/install/mock_host.py
```

It reads `mock_cfg.json`, beside it, if there is one — Chrome gives a native
messaging host no arguments of its own, so a file is the only way in:

```json
{ "chunks": 3, "gap": false, "huge": false, "crash": false, "delay_ms": 0 }
```

and appends everything it sees and says to `mock_host.log`. Neither file belongs
in a commit.

## The three end-to-end tests

Each needs nothing running, writes its host manifest into a throwaway browser
profile of its own, and never touches yours. Headed, so under a virtual display:

```sh
xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_hand.mjs
xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_handrun.mjs
xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_handreal.mjs
```

| | Browser | Extension | Host | Command |
|---|---|---|---|---|
| `verify_hand` | real | real | **mock** | none |
| `verify_handrun` | real | real | **mock** | none |
| `verify_handreal` | real | real | **real** | **real** |

The first two use the mock deliberately: they test the order of the output, a
gap in it, the 1 MB disconnect, a crash mid-command, a page that goes away with
a command running, the missing-host message, and revoking from the popup — and a
correct hand does none of those things, so a correct hand cannot be used to test
them. `verify_handrun` goes on to check what the *model* was shown, which is the
only thing that matters about a tool result.

`verify_handreal` is the one that proves the join. It builds the binary,
registers it with `install.sh`, writes a `root.txt`, clicks Allow for real, and
then has a daimon run real commands: it asserts that a nonce written to disk a
moment earlier comes back through the model, that a real non-zero exit arrives as
non-zero, that a file outside the fence is refused *by the kernel* and its
contents never reach the model, that the journal on disk names what was run, and
that a real `cargo test` compiles and runs inside the fence. It takes about
twelve seconds after the build.
