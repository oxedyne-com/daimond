use super::*;

// ── The toolchain a build needs and the workspace does not hold ──────────────
//
// A fence built from a Diamond's bounds alone refuses `cargo`, because `~/.cargo/bin/cargo` is not
// in the user's workspace and never will be. The model then meets a refusal it can do nothing with,
// which reads as the app being broken. What follows is the grant that fixes it, and the shape of
// that grant is the whole of the care: it is named, it is short, it is the user's to give, and it
// is never chosen by the thing it is granted to.

/// What a toolkit's path is granted for.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Level {
    /// Readable and executable, never writable: a toolchain is not a command's to edit.
    Ro,
    /// Writable, because a cache a tool must write is not optional.
    Rw,
    /// Denied outright, even where some wider grant would otherwise cover it.
    Deny,
}

/// One path a toolkit names, relative to the home directory the hand reported.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Grant {
    /// The path, relative to the home directory.  Never absolute (see [`Toolkit`]).
    pub tail:  &'static str,
    /// What it is granted for.
    pub level: Level,
    /// Why it is here, for the grant window and for anyone reading the fence afterwards.
    pub why:   &'static str,
}

/// The `PATH` a command is given when a toolkit puts a directory on it.
///
/// A mirror of the hand's own `PATH_FALLBACK`, and it has to be: the hand uses that list only when
/// the caller supplies no `PATH` at all, so a toolkit that sent `~/.cargo/bin` alone would take
/// `cc`, `ld` and `git` away from every build it was meant to enable.
pub(super) const PATH_BASE: &str = "/usr/local/bin:/usr/bin:/bin";

/// Credentials denied whenever any toolkit is granted, whichever one it is.
///
/// Two entries, and each earns its place.  `.netrc` is read by cargo, pip, npm and the go command
/// alike when a registry asks for a password, so it is the one file every toolkit would otherwise
/// hand over at once.  `.config/oxedyne` is a whole directory of credentials -- the Stripe secret
/// keys, the DKIM signing key and the mail password file were all moved there on 2026-08-22
/// precisely so that they would sit outside the tree a hand is granted -- and a directory whose
/// entire contents are secrets is the same class of thing as `.ssh`.
///
/// Both are denied rather than merely left ungranted, because a user whose workspace root IS their
/// home directory has already granted them by granting the workspace.  That hazard has nothing to
/// do with which toolchain was lent, which is why these are here and not in [`Toolkit::Git`]
/// beside `.ssh`: `.ssh` sits there because git is the tool that would reach for it, and an
/// absolute path in an `argv` needs no toolkit at all to be tried.
///
/// A deny costs nothing at the far end.  The hand clamps an arriving fence's `rw` and `ro` roots
/// against what its grant could imply and pointedly does not clamp `deny`, since a deny only ever
/// takes access away; and a denied path that does not exist on the machine is tolerated where a
/// granted one is not (`hand/src/fence.rs`, `canonical`).
pub(super) const CREDS: &[Grant] = &[
    Grant { tail: ".netrc", level: Level::Deny,
        why: "the password file cargo, pip, npm and go all read for a private registry" },
    Grant { tail: ".config/oxedyne", level: Level::Deny,
        why: "the Stripe keys, the DKIM signing key and the mail password, kept out of the \
            workspace on purpose" },
];

/// Denied on EVERY fence, whether or not a toolkit was granted.
///
/// [`CREDS`] above says the hazard out loud -- *"a user whose workspace root IS their home
/// directory has already granted them by granting the workspace"* -- and then applies the answer
/// only where [`Kit::resolve`] runs, which is only where a toolkit was granted.  So the user's
/// private key was safe because it happened to sit outside their workspace root, and for no other
/// reason.  Checked on 2026-08-26: `.ssh` appears at `Level::Deny` in exactly two places, both
/// inside a toolkit's own grant list, and nothing in [`fence_spec`] mentions it at all.
///
/// **A guarantee that holds by accident of a setting is not a guarantee.**  The owner asked that
/// evening whether he should simply point the workspace root at `$HOME` -- he had chosen `~/usr`
/// for no reason beyond seeing no need to go higher -- and the honest answer was that the setting
/// he picked arbitrarily was the only thing standing between a daimon and his private key.  So the
/// rule is written down here instead, and the setting is free to move.
///
/// A deny costs nothing where the path is not granted anyway, and a denied path that does not exist
/// is tolerated (`hand/src/fence.rs`, `canonical`), so this is applied unconditionally rather than
/// worked out.
///
/// **One entry is lifted on one surface, and nowhere else.**  The interactive terminal
/// ([`Surface::Terminal`], threaded from `wasm/pty.rs` and from no other call site) omits the
/// `.ssh` deny, so a user can `ssh` from the Daimond terminal as themselves.  It is safe there for
/// the reason the whole terminal widening is safe: a terminal is the user at a keyboard, no
/// [`Tool`] opens one or types into one, and `pty_request` is a page-driven wasm entry a daimon
/// cannot reach.  The carve lifts `.ssh` ALONE -- ssh reads only `~/.ssh` -- and every other secret
/// here stays denied on the terminal exactly as on a command.  See [`fence_spec_surfaced`].
pub(super) const ALWAYS_DENIED: &[Grant] = &[
    Grant { tail: ".ssh", level: Level::Deny,
        why: "the user's private keys and known hosts, which Daimond reaches another machine \
            as itself or not at all -- lifted ONLY on the interactive terminal, see Surface" },
    Grant { tail: ".gnupg", level: Level::Deny,
        why: "the signing keys, and a directory whose entire contents are secrets" },
    Grant { tail: ".aws", level: Level::Deny,
        why: "the credentials file every AWS tool reads without being asked" },
    Grant { tail: ".git-credentials", level: Level::Deny,
        why: "the passwords git's credential.helper store writes in plain text" },
    Grant { tail: ".config/git/credentials", level: Level::Deny,
        why: "the same passwords, where XDG puts them" },
    Grant { tail: ".npmrc", level: Level::Deny,
        why: "the registry token npm writes on login" },
    Grant { tail: ".pypirc", level: Level::Deny,
        why: "the upload password twine reads" },
    Grant { tail: ".netrc", level: Level::Deny,
        why: "the password file cargo, pip, npm and go all read for a private registry" },
    Grant { tail: ".config/oxedyne", level: Level::Deny,
        why: "the Stripe keys, the DKIM signing key and the mail password, kept out of the \
            workspace on purpose" },
];

/// A named toolchain a Diamond may be granted, so that a build can reach its compiler.
///
/// Three things about this are deliberate, and none of them is negotiable.
///
/// * **It is never inferred from what the model asked to run.**  A fence that widened itself to fit
///   the requested binary would be a fence the model chooses, and the entire arrangement rests on
///   its not being one.  `cargo` is reachable because the user granted the Rust toolkit, and for no
///   other reason.
/// * **It is a grant, so it is the user's to give.**  Off by default, chosen per Diamond, and it
///   arrives here as a [`Bound::Toolkit`] in the turn's own bounds like every other thing the user
///   has decided about this turn.
/// * **It is a short list of named paths and never the home directory.**  `~/.cargo` is 2.2 GB and
///   holds the crates.io token `cargo login` writes to `credentials.toml`.  So the Rust toolkit
///   grants `~/.cargo/bin` and `~/.rustup`, names the two caches cargo must write, and denies the
///   token.  Each toolkit's table below says what every path is for; what a toolkit leaves out is
///   said in its doc comment, because an omission nobody wrote down is an omission that gets
///   quietly repaired later by someone widening the grant.
///
/// **Every path is relative to the home directory the hand reported, and there is no other kind.**
/// The absolute system paths a toolchain also needs -- `/usr`, `/bin`, `/lib`, `/etc`, `/opt` --
/// are already in the hand's own read-only base, so a toolkit naming them would be a second copy of
/// the hand's decision living in the page and free to drift from it.  A hand that does not report a
/// home directory therefore grants no toolkit at all: a browser tab cannot know the path, and a
/// fence built on a guessed one is not a fence.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum Toolkit {
    /// Rust: `cargo`, `rustc`, `rustup`, the two caches cargo cannot build without, and the
    /// target directory the trees here point every build at.
    ///
    /// `~/.cache/cargo-targets` is named because a build in these trees does not put its
    /// artefacts in the workspace: `CARGO_TARGET_DIR` is set per agent under that directory, so a
    /// fence without it leaves a daimon unable to run the build its own repository's scripts
    /// describe.  It is named at that one folder and never at `~/.cache`, which also holds the
    /// browser's cache and the thumbnailer's copy of every image the user has opened.
    ///
    /// Deliberately excluded: `~/.cargo` itself (2.2 GB, and where `cargo login` writes
    /// `credentials.toml`), and `~/.cargo/config.toml`, which names a linker and `rustflags` for
    /// every build on the machine -- writable, it is a way to run something of the command's
    /// choosing the next time the user builds anything at all.
    Rust,
    /// Node: what `nvm` installed, npm's cache, and the scratch the dev scripts write.
    ///
    /// `~/.cache/daimond` is where every `dev/*.mjs` puts what it produces -- shots, logs, a
    /// built extension -- unless `DAIMOND_SCRATCH` says otherwise.  Named at that one folder for
    /// the reason `~/.cache/cargo-targets` is: the directory above it is not this app's.
    ///
    /// Deliberately excluded: `~/.npmrc` and `~/.yarnrc.yml`, which hold registry tokens.  A
    /// project's `node_modules` needs nothing here -- it sits in the workspace, which the turn's
    /// own bounds already cover.
    Node,
    /// Python: the interpreters, what `pip install --user` provides, and pip's cache.
    ///
    /// Deliberately excluded: `~/.local/share`, which is granted by no part of this even though
    /// `~/.local/bin` and `~/.local/lib` are -- it holds `keyrings/`.  And `~/.pypirc`, which is
    /// the PyPI upload token.
    Python,
    /// Go: the toolchains, the module cache and the build cache.
    ///
    /// Deliberately excluded: `~/.config/go/env`.  `go env -w` writes `GOFLAGS` there, and a
    /// `-toolexec` in it runs a program of the writer's choosing on every later build.
    Go,
    /// Git: the user's own configuration, and never a credential.
    ///
    /// The odd one out, and worth saying why it is here.  `git` itself needs no grant -- it lives
    /// in `/usr/bin`, which the hand's own read-only base already covers, which is why `status`,
    /// `diff`, `log`, `add` and `commit` all work with no toolkit at all.  What does not work is
    /// everything the user configured GLOBALLY: their name and email, and `core.hooksPath`, which
    /// is where a credential-scanning `pre-commit` hook usually lives.  A git that cannot read
    /// `~/.gitconfig` runs without the user's identity and without their hooks, and it does so
    /// SILENTLY -- an unreadable hooks directory is indistinguishable from an empty one.  Refusing
    /// `--no-verify` while the hook cannot run at all would be a guard protecting nothing.
    ///
    /// Deliberately excluded: `~/.ssh`, which nothing here ever needs and which is denied outright;
    /// `~/.git-credentials`, which `credential.helper store` writes in plain text; and
    /// `~/.config/git/credentials`, the same file where XDG puts it.
    ///
    /// A hooks directory outside the granted root is still unreachable, and the hook still does not
    /// run: the page cannot read `~/.gitconfig` and so cannot know where to look.
    ///
    /// # The repository itself is not granted here, and cannot be
    ///
    /// Every path in this table is relative to the HOME directory, so none of them can name a
    /// `.git` in the workspace.  Nor do they need to.  A repository sits inside the folder the
    /// Diamond marked, which [`fence_spec`] grants whole and writable, so `.git` is reachable for
    /// exactly the same reason `src` is -- and a daimon that cannot see one is a daimon whose
    /// command is running somewhere the repository is not ABOVE it, which no grant here fixes.
    ///
    /// It is granted WRITABLE and there is no read-only middle ground, which is worth writing down
    /// because `.git/config` sets `core.fsmonitor`, `core.pager` and `core.sshCommand`, each of
    /// which runs a program of the writer's choosing on the next ordinary git command.  Two things
    /// bound that.  A program git starts is a child of the fenced command, so it inherits the
    /// fence and reaches nothing the model could not already reach; the exposure is the user's own
    /// later `git` in their own shell, outside all of this.  And the alternative does not work:
    /// re-stating `.git/config` as read-only makes the hand carve `.git` around it, and a carved
    /// directory cannot have a file created directly in it -- which is `index.lock`, `HEAD.lock`
    /// and `COMMIT_EDITMSG`, so every commit fails.  A `.git` that can be committed to is a
    /// `.git` that can be reconfigured.
    ///
    /// # Ore needs no grant of its own
    ///
    /// A tree under Ore as well as git gets its replica marked by the global `post-commit` hook,
    /// which runs `ore mark` beside the commit -- so the second system rides on the first and
    /// `.ore` is granted at no width, which is the only safe answer: `.ore/key` is a plaintext
    /// signing key and EVERY Ore verb but `init`, `import` and `help` captures the working copy
    /// and signs it, so there is no read-only verb to lend.  What that hook needs is to be
    /// REACHABLE, and `core.hooksPath` usually names a directory outside the folder the Diamond
    /// marked; attach that directory to the Diamond read-only and it runs, since a read-only grant
    /// carries execute.  Unattached, git finds no hook and says nothing -- so the mark is missed
    /// silently, and so is the credential-scanning `pre-commit` beside it.
    ///
    /// One thing not to widen for: a repository initialised `--mirror` has Ore shell out to `git
    /// fast-import`.  There is no mirror in this tree, so that path does not run here.
    Git,
    /// `ssh`, with a key that is Daimond's own -- and only from a terminal the user opened.
    ///
    /// # Why it is not the user's `~/.ssh`
    ///
    /// The three refusals that made this necessary were captured through the real hand in a real
    /// pty, and the first of them is `hostkeys_foreach failed for ~/.ssh/known_hosts: Permission
    /// denied`.  The tempting repair is to lend `~/.ssh`, and it is the wrong one: that directory
    /// holds the keys the user's own life runs on, and [`Toolkit::Git`] denies it by name for
    /// exactly that reason.  So Daimond has a keypair of its OWN, made by Kimberlite's installer,
    /// under `~/.config/oxedyne/kimberlite/ssh`, installed on the machines the user chose with
    /// `restrict,pty` against each one's `authorized_keys`.  Revoking Daimond's reach is then one
    /// line removed from one file, on the machine that wants it back -- which is not true of a
    /// grant of the user's own key.
    ///
    /// The host list is Daimond's own for the same reason and a second one: a `known_hosts` the
    /// user owns would have to be WRITTEN to learn a host, and a writable `~/.ssh` is a way to
    /// add an `authorized_keys` entry.
    ///
    /// # Why the terminal and not a command
    ///
    /// **This is the one toolkit a daimon can never be granted**, and [`Toolkit::terminal_only`]
    /// is where that is enforced in this end.  An `ssh` that reaches another machine reaches it
    /// UNFENCED -- the far end is a login shell under sshd, and nothing this repository can do
    /// binds it -- so a fenced command that could run `ssh` would not be fenced at all.  A
    /// terminal is a different trust class: a person opened it, a person is typing into it, and
    /// what they reach is what they could reach from any other terminal on their own machine.
    ///
    /// Deliberately excluded: `~/.ssh` in every part, denied by name; and
    /// `~/.config/oxedyne/daimond-hand/openrouter.key`, which is the daimon's own budget and
    /// sits in the retiring hand's directory beside where this kit used to live.
    Remote,
}

/// The cap by which Kimberlite names itself as the executor of a turn, in its hello and in its own
/// engine's machine.  See [`Machine::runs_hand`].
pub const CAP_EXECUTOR_KIMBERLITE: &str = "executor:kimberlite";

/// The cap by which Kimberlite says its commands run inside a whole-home fence: that fence alone
/// decides what a command reaches, so there is no toolkit to grant and no toolchain question to
/// put (U1 KIT-ASK).  See [`Machine::whole_home`].
pub const CAP_FENCE_WHOLE_HOME: &str = "fence:whole-home";

/// [`Toolkit::Remote`]'s grants where the retiring native-messaging hand runs the turn: the same
/// rows as Kimberlite's, under the hand's own directory, which is the kit that hand vets against
/// (`TOOLKIT_ROOTS` in `hand/src/exec.rs`).
// R10: delete with the hand.
pub(super) const REMOTE_HAND_GRANTS: &[Grant] = &[
    Grant { tail: ".config/oxedyne/daimond-hand/bin", level: Level::Ro,
        why: "the ssh the hand's installer wrote, which supplies the key, the host \
            list and the session that survives a dropout" },
    Grant { tail: ".config/oxedyne/daimond-hand/ssh", level: Level::Ro,
        why: "the keypair the installer made for this computer's Daimond, which is \
            all that directory holds" },
    Grant { tail: ".config/oxedyne/daimond-hand/known_hosts", level: Level::Rw,
        why: "the hosts ssh has learned -- Daimond's own list, written when it \
            learns one, and never the user's" },
    Grant { tail: ".config/oxedyne/daimond-hand/openrouter.key", level: Level::Deny,
        why: "the daimon's own budget, which sits in the same directory and is no \
            part of reaching another machine" },
    Grant { tail: ".ssh",                 level: Level::Deny,
        why: "the user's own keys and host list, which this never reads: Daimond \
            reaches another machine as itself or not at all" },
];

impl Toolkit {

    /// Every toolkit a user can grant a Diamond, in the order they are offered.
    ///
    /// [`Toolkit::Remote`] is deliberately NOT among them, and that absence is the whole of its
    /// scope: it is not a thing a Diamond holds, so there is no name for a Diamond to record, no
    /// chip to press and nothing for [`Toolkit::parse`] to answer.  A terminal gets it from the
    /// COMPUTER -- see [`Toolkit::terminal_only`] -- and every list built from this one is
    /// therefore a list a daimon may legitimately be told about.
    pub fn all() -> [Self; 5] {
        [Self::Rust, Self::Node, Self::Python, Self::Go, Self::Git]
    }

    /// The toolkit's name, which is what a Diamond records.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Rust   => "rust",
            Self::Node   => "node",
            Self::Python => "python",
            Self::Go     => "go",
            Self::Git    => "git",
            Self::Remote => "remote",
        }
    }

    /// What to call it on a button.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Rust   => "Rust",
            Self::Node   => "Node",
            Self::Python => "Python",
            Self::Go     => "Go",
            Self::Git    => "Git",
            Self::Remote => "Remote",
        }
    }

    /// Which commands it makes available, for the sentence the daimon is told.
    pub fn tools(&self) -> &'static str {
        match self {
            Self::Rust   => "cargo, rustc and rustup",
            Self::Node   => "node and npm",
            Self::Python => "python, pip and what pip installed for the user",
            Self::Go     => "the go command",
            Self::Git    => "git, with the user's own name, email and hooks",
            Self::Remote => "ssh, from a terminal the user opened and never from a command",
        }
    }

    /// The programs that need this toolkit, matched against the tail of a command's program.
    ///
    /// Git's list is empty: `git` is on the base `PATH`, and what its grant lends is the user's
    /// identity, which only some subcommands use (see [`kits_wanted`]).
    pub fn programs(&self) -> &'static [&'static str] {
        match self {
            Self::Rust   => &["cargo", "rustc", "rustup"],
            Self::Node   => &["node", "npm", "npx"],
            Self::Python => &["python", "python3", "pip", "pip3", "pytest"],
            Self::Go     => &["go", "gofmt"],
            Self::Git    => &[],
            Self::Remote => &[],
        }
    }

    /// Read a toolkit from its name.
    ///
    /// # Arguments
    /// * `name` - The recorded name, as [`Toolkit::name`] spells it.
    pub fn parse(name: &str) -> Outcome<Self> {
        for k in Self::all() {
            if k.name() == name {
                return Ok(k);
            }
        }
        Err(err!("'{}' is not a toolkit a Diamond can be granted. Known toolkits: rust, node, \
            python, go, git.", name; Invalid, Input))
    }

    /// This toolkit as a rule in a turn's bounds.
    ///
    /// A grant travels with the other things the user has decided about this turn rather than in a
    /// field of its own, which is why granting one needs no change to [`ToolContext`] and cannot be
    /// forgotten by a caller that builds bounds some other way.
    pub fn bound(&self) -> Bound {
        Bound::Toolkit(*self)
    }

    /// The paths this toolkit names, each relative to the home directory.
    ///
    /// **A row added here needs its twin in `TOOLKIT_ROOTS` in `hand/src/exec.rs`.**  The fence
    /// travels through the page and the page is not the app, so the hand clamps every arriving
    /// `rw` and `ro` root against the folders its own copy of this table says the named toolkits
    /// could imply -- and refuses the WHOLE command, not merely the unknown root, when one is not
    /// there.  The drift fails safe and loud, and the refusal names the constant to fix.
    pub fn grants(&self) -> &'static [Grant] {
        match self {
            Self::Rust => &[
                Grant { tail: ".cargo/bin",           level: Level::Ro,
                    why: "the cargo, rustc and rustup commands" },
                Grant { tail: ".rustup",              level: Level::Ro,
                    why: "the toolchains themselves" },
                Grant { tail: ".cargo/registry",      level: Level::Rw,
                    why: "crate sources and the index, written on every fetch" },
                Grant { tail: ".cargo/git",           level: Level::Rw,
                    why: "checkouts of git dependencies" },
                Grant { tail: ".cargo/.package-cache", level: Level::Rw,
                    why: "the lock cargo takes before touching either cache" },
                Grant { tail: ".cache/cargo-targets", level: Level::Rw,
                    why: "the target directory CARGO_TARGET_DIR points a build at, so the \
                        artefacts do not land in the workspace" },
                Grant { tail: ".cargo/credentials.toml", level: Level::Deny,
                    why: "the crates.io token cargo login writes" },
                Grant { tail: ".cargo/credentials",   level: Level::Deny,
                    why: "the same token, in the spelling older cargo used" },
            ],
            Self::Node => &[
                Grant { tail: ".nvm",                 level: Level::Ro,
                    why: "the node versions nvm installed" },
                Grant { tail: ".npm",                 level: Level::Rw,
                    why: "npm's package cache" },
                Grant { tail: ".cache/daimond",       level: Level::Rw,
                    why: "the scratch every dev script writes into, unless DAIMOND_SCRATCH \
                        names another" },
                Grant { tail: ".npmrc",               level: Level::Deny,
                    why: "the registry token npm login writes" },
                Grant { tail: ".yarnrc.yml",          level: Level::Deny,
                    why: "yarn's npmAuthToken" },
            ],
            Self::Python => &[
                Grant { tail: ".pyenv",               level: Level::Ro,
                    why: "the interpreters pyenv installed, and its shims" },
                Grant { tail: ".local/bin",           level: Level::Ro,
                    why: "the console scripts pip install --user puts there" },
                Grant { tail: ".local/lib",           level: Level::Ro,
                    why: "the packages those scripts import" },
                Grant { tail: ".cache/pip",           level: Level::Rw,
                    why: "pip's wheel cache" },
                Grant { tail: ".pypirc",              level: Level::Deny,
                    why: "the PyPI upload token" },
            ],
            Self::Go => &[
                Grant { tail: "sdk",                  level: Level::Ro,
                    why: "the toolchains go install golang.org/dl fetched" },
                Grant { tail: "go/bin",               level: Level::Ro,
                    why: "the binaries go install has put there" },
                Grant { tail: "go/pkg/mod",           level: Level::Rw,
                    why: "the module cache the go command requires" },
                Grant { tail: ".cache/go-build",      level: Level::Rw,
                    why: "the build cache, without which the go command refuses to run" },
                Grant { tail: ".config/go/env",       level: Level::Deny,
                    why: "go env -w writes GOFLAGS there, and a -toolexec in it runs on every \
                        later build" },
            ],
            Self::Git => &[
                Grant { tail: ".gitconfig",           level: Level::Ro,
                    why: "the user's own git configuration: their name, their email, and the \
                        hooks path" },
                Grant { tail: ".config/git",          level: Level::Ro,
                    why: "the same configuration where XDG puts it, and the global ignore file" },
                Grant { tail: ".git-credentials",     level: Level::Deny,
                    why: "the passwords credential.helper store writes in plain text" },
                Grant { tail: ".config/git/credentials", level: Level::Deny,
                    why: "the same passwords, in the XDG location" },
                Grant { tail: ".ssh",                 level: Level::Deny,
                    why: "the private keys, which nothing here needs and which pushing does not \
                        use" },
            ],
            Self::Remote => &[
                Grant { tail: ".config/oxedyne/kimberlite/bin", level: Level::Ro,
                    why: "the ssh the hand's installer wrote, which supplies the key, the host \
                        list and the session that survives a dropout" },
                Grant { tail: ".config/oxedyne/kimberlite/ssh", level: Level::Ro,
                    why: "the keypair the installer made for this computer's Daimond, which is \
                        all that directory holds" },
                Grant { tail: ".config/oxedyne/kimberlite/known_hosts", level: Level::Rw,
                    why: "the hosts ssh has learned -- Daimond's own list, written when it \
                        learns one, and never the user's" },
                Grant { tail: ".config/oxedyne/daimond-hand/openrouter.key", level: Level::Deny,
                    why: "the daimon's own budget, which happens to sit in the same directory \
                        and is no part of reaching another machine" },
                Grant { tail: ".ssh",                 level: Level::Deny,
                    why: "the user's own keys and host list, which this never reads: Daimond \
                        reaches another machine as itself or not at all" },
            ],
        }
    }

    /// As [`Toolkit::grants`], for a turn run by the executor `m` describes.
    ///
    /// Only [`Toolkit::Remote`] differs: its kit lives in the directory of the executor that
    /// runs the turn, and that executor refuses a fence naming any other.  See
    /// [`Machine::runs_hand`].
    ///
    /// # Arguments
    /// * `m` - The machine whose executor runs the turn.
    pub fn grants_on(&self, m: &Machine) -> &'static [Grant] {
        match self {
            // R10: delete with the hand.
            Self::Remote if m.runs_hand() => REMOTE_HAND_GRANTS,
            _ => self.grants(),
        }
    }

    /// As [`Toolkit::bins`], for a turn run by the executor `m` describes.
    ///
    /// # Arguments
    /// * `m` - The machine whose executor runs the turn.
    pub fn bins_on(&self, m: &Machine) -> &'static [&'static str] {
        match self {
            // R10: delete with the hand.
            Self::Remote if m.runs_hand() => &[".config/oxedyne/daimond-hand/bin"],
            _ => self.bins(),
        }
    }

    /// The directories this toolkit puts on `PATH`, relative to the home directory.
    ///
    /// Empty where a toolchain's binaries sit at a path only the machine knows: nvm's node is under
    /// `~/.nvm/versions/node/<version>/bin`, and a version this page invented would be a `PATH`
    /// entry pointing at nothing.  A toolkit with no entries here is still a grant -- the folders
    /// are readable, and the daimon is told to name the binary in full.
    pub fn bins(&self) -> &'static [&'static str] {
        match self {
            Self::Rust   => &[".cargo/bin"],
            Self::Node   => &[],
            Self::Python => &[".local/bin", ".pyenv/shims"],
            Self::Go     => &["go/bin"],
            // git is in `/usr/bin`, which `PATH_BASE` already carries.
            Self::Git    => &[],
            // AHEAD of `/usr/bin`, which is what makes `ssh argonaut` -- typed exactly like
            // that -- reach the wrapper rather than the system's own ssh. OpenSSH takes the
            // home directory from the passwd entry and not from `HOME`, so there is no
            // environment variable that could point it at Daimond's key and Daimond's host
            // list; a wrapper on `PATH` is the only place those flags can come from without
            // the user typing them. It is granted READ-ONLY, so nothing a fenced command does
            // can put a second program in there.
            Self::Remote => &[".config/oxedyne/kimberlite/bin"],
        }
    }

    /// The environment this toolkit needs, as names and home-relative values.
    ///
    /// `HOME` is pointedly not among them.  Setting it would point every tool a command runs at the
    /// whole home directory -- git at `~/.gitconfig`, ssh at `~/.ssh` -- when what cargo actually
    /// needs is two variables naming two folders it has been granted.
    pub fn vars(&self) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::Rust   => &[("CARGO_HOME", ".cargo"), ("RUSTUP_HOME", ".rustup")],
            Self::Node   => &[("npm_config_cache", ".npm")],
            Self::Python => &[("PIP_CACHE_DIR", ".cache/pip")],
            Self::Go     => &[("GOPATH", "go"), ("GOMODCACHE", "go/pkg/mod"),
                                 ("GOCACHE", ".cache/go-build")],
            // git finds its global configuration through `HOME` and nothing else; see
            // [`Toolkit::needs_home`], which is where that exception is made and argued.
            Self::Git    => &[],
            // Nothing: the wrapper on `PATH` carries the absolute paths, written into it by
            // the installer, so there is no name for a caller to get wrong.
            Self::Remote => &[],
        }
    }

    /// Whether this toolkit needs `HOME` set to the home directory itself.
    ///
    /// Only git does, and it is the exception the comment on [`Toolkit::vars`] warns against --
    /// so it is worth saying why it is safe here and would not be in general.
    ///
    /// That comment's objection is that setting `HOME` points every tool at the whole home
    /// directory.  It points them at it; it does not GRANT it.  The fence decides what is
    /// reachable, and under a Git grant that is two paths and no more, so a tool that follows
    /// `HOME` somewhere else meets a refusal rather than a file.  Cargo is the case worth
    /// checking: with `HOME` set it looks for `~/.cargo/config.toml`, which the Rust toolkit
    /// deliberately does not grant, and it is denied -- the same outcome as not finding it.
    ///
    /// `GIT_CONFIG_GLOBAL` would name the file directly and avoid `HOME` altogether, and it was
    /// rejected: it OVERRIDES git's own search, so pointing it at `~/.gitconfig` would hide a
    /// configuration that lives at `~/.config/git/config` instead, and the page cannot see which
    /// of the two this user has.  Setting `HOME` lets git do its own looking.
    pub fn needs_home(&self) -> bool {
        matches!(self, Self::Git)
    }

    /// Is this toolkit reachable only from a terminal the user opened by hand?
    ///
    /// Yes for exactly one, [`Toolkit::Remote`], and the reason is not that ssh is dangerous
    /// but that it is a **way out of the fence**: the shell at the far end is sshd's child on
    /// another machine, under nothing this repository applies.  So a fenced command that could
    /// run it would not be fenced, and the grant belongs to the trust class where a person
    /// opened the surface and is typing into it.
    ///
    /// # Whose grant it is
    ///
    /// **The user's, and per COMPUTER.**  It was a grant given to one Diamond at a time until
    /// 2026-08-26, and the owner's objection to that is `dev/BLOCKERS.md` B12: *"permissions
    /// should be a global posture setting, not for individual chats and daimons"*.  A Terminal
    /// is not tied to a Diamond, so neither is what one may reach.
    ///
    /// It is held in the one place it cannot drift from: the key and the wrapper themselves.
    /// `hand/install/install.sh --remote` makes them, `exec::remote_ready` in the hand reads
    /// them back, and the hand says `remote:ready` in `hello` beside `home:`, `host:` and
    /// `shell:` -- which is where [`Machine::remote`] gets it.  So there is no fourth store
    /// for a permission to live in, nothing to migrate, and no setting that could still say
    /// yes after the key is deleted.  A machine where the installer never ran says nothing,
    /// and silence is read as off: turning it on is the user running that script.
    ///
    /// It is therefore NOT in [`Toolkit::all`], does not answer to [`Toolkit::parse`], is not
    /// a name `crate::diamond_meta::normalise_kits` keeps, and has no chip in the page's
    /// `KITS` row.  A Diamond cannot record it, so nothing about a Diamond can turn it on.
    ///
    /// # Where the boundary is
    ///
    /// Unchanged by any of that.  Enforced in three places, none of which trusts the other two.
    /// [`toolkit_bounds`] drops
    /// it, so a daimon's turn never carries the rule and [`fence_spec`] never sees it.  Only
    /// [`terminal_toolkit_bounds`] keeps it, and only `crate::wasm::pty::pty_request` calls
    /// that.  And the hand refuses a fence naming these folders unless the request came in by
    /// its terminal door -- see `TOOLKIT_ROOTS` in `hand/src/exec.rs`, which is the copy that
    /// matters, because the fence travels through the page and the page is not the app.
    pub fn terminal_only(&self) -> bool {
        matches!(self, Self::Remote)
    }
}

/// A path under `home`, or `None` where the tail names nothing.
///
/// The result cannot leave `home` whatever the tail says: [`normalise`] resolves `..` lexically and
/// discards what it cannot climb above, so `../../etc/shadow` is `<home>/etc/shadow` -- useless,
/// and inside.  That is the whole reason a toolkit is expressed as a tail rather than as a path.
///
/// # Arguments
/// * `home` - An absolute home directory, without its trailing slash.
/// * `tail` - The toolkit's path, relative to it.
pub(super) fn home_path(home: &str, tail: &str) -> Option<String> {
    let t = normalise(tail);
    if t.is_empty() {
        return None;
    }
    Some(fmt!("{}/{}", home.trim_end_matches('/'), t))
}

/// Whether `p` is a usable absolute directory on the machine.
///
/// `/` fails it, and so does anything carrying a `..`: both are answers a hand should never give,
/// and a fence assembled from either is worse than no fence.
pub(super) fn abs_dir(p: &str) -> bool {
    p.len() > 1
        && p.starts_with('/')
        && !p.contains('\0')
        && !p.split('/').any(|s| s == "..")
}

/// What the machine hand said about the computer a command would run on.
///
/// The page cannot learn any of this for itself.  A real folder arrives through the File System
/// Access API as a handle and never a path, and a browser tab has no home directory, no `uname` and
/// no environment.  So every field here is the hand's answer, and a field the hand did not answer
/// is [`None`] rather than a guess.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Machine {
    /// Which operating system, in the wire's own vocabulary (`linux`, `macos`, `windows`).
    pub os:   String,
    /// The absolute folder the hand's grant covers.
    pub root: String,
    /// The user's home directory, absolute.
    ///
    /// Carried in `caps` as a `home:<path>` entry, exactly as the granted root is carried as
    /// `root:<path>`: `wire::Resp::Hello` has no field for either, and the capability list is the
    /// wire's own way of saying something extra without a new protocol version.
    pub home: Option<String>,
    /// What this hand says it can enforce.
    pub caps: Vec<String>,
    /// This computer's name, where the hand said it.  Carried in `caps` as `host:<name>`.
    pub host: Option<String>,
    /// The user's login shell, absolute, where the hand said it.  Carried in `caps` as
    /// `shell:<path>`.
    pub shell: Option<String>,
    /// The ceiling the user PINNED at a shell, from `terminal-root:<path>` in `caps`.
    ///
    /// A decision already made: the page follows it and offers nothing.  Absent, and the choice
    /// is the user's to make in the app from [`Machine::terminal_ceilings`].
    pub terminal_root: Option<String>,
    /// The folders this machine is willing to fence a TERMINAL to, from `terminal-ceiling:<path>`
    /// entries in `caps`.  Never includes [`Machine::root`], which is always available.
    ///
    /// A terminal is the user at a keyboard and a command is a daimon, so the two may be
    /// different sizes.  **The machine writes this list and the app chooses from it.**  That is
    /// the same rule a [`Toolkit`] follows -- a fixed row with a written reason, ticked by the
    /// user -- applied to the root itself, and it is the line that matters: the app may choose
    /// among folders the machine sanctioned and may never invent one.
    pub terminal_ceilings: Vec<String>,
    // Whether Daimond's own ssh is set up on this computer, from `remote:ready` in `caps`.
    // The Remote toolchain's whole permission, and the user's rather than a Diamond's: see
    // [`Toolkit::terminal_only`].
    pub remote: bool,
}

impl Machine {

    /// The machine a hand's `status()` describes, or `None` where no hand is attached.
    ///
    /// A hand that is not paired, or that did not say which folder it was granted, describes no
    /// machine at all -- and this returning `None` is what makes the briefing in
    /// [`crate::prompts`] silent rather than wrong.
    ///
    /// # Arguments
    /// * `status` - The relay's JSON, as `wasm::hand::status` returns it.
    pub fn paired(status: &str) -> Option<Self> {
        if extract_json_bool(status, "paired") != Some(true) {
            return None;
        }
        let m = Self::from_status(status);
        if !m.rooted() {
            return None;
        }
        Some(m)
    }

    /// Everything readable out of a hand's `status()`, paired or not.
    ///
    /// # Arguments
    /// * `status` - The relay's JSON.
    pub fn from_status(status: &str) -> Self {
        let caps = extract_json_string_array(status, "caps").unwrap_or_default();
        Self {
            os:   extract_json_string(status, "os").unwrap_or_default(),
            root: extract_json_string(status, "root").unwrap_or_default(),
            home: cap_value(&caps, "home").filter(|h| abs_dir(h)),
            terminal_root: cap_value(&caps, "terminal-root").filter(|h| abs_dir(h)),
            terminal_ceilings: caps.iter()
                .filter_map(|c| c.strip_prefix("terminal-ceiling:"))
                .map(|p| p.to_string())
                .filter(|p| abs_dir(p))
                .collect(),
            host: cap_value(&caps, "host").filter(|h| !h.trim().is_empty()),
            // Absolute or nothing. A relative name would be resolved by the hand against a
            // `PATH` the page cannot see, and a terminal opening on a refusal is worse than
            // one opening on `/bin/sh`.
            shell: cap_value(&caps, "shell").filter(|p| p.starts_with('/')),
            // Affirmative, and only ever this one spelling: an older hand says nothing, and
            // silence is "not set up" rather than "probably fine". The posture is the user's
            // act on this machine and the hand reads it off the key and the wrapper
            // themselves -- `exec::remote_ready` in `hand/src/exec.rs`.
            remote: caps.iter().any(|c| c == "remote:ready"),
            caps,
        }
    }

    /// A machine known only by the folder it granted.
    ///
    /// # Arguments
    /// * `root` - The absolute folder the hand's grant covers.
    pub fn at(root: &str) -> Self {
        Self {
            os:    String::new(),
            root:  root.to_string(),
            home:   None,
            terminal_root: None,
            terminal_ceilings: Vec::new(),
            host:   None,
            shell:  None,
            remote: false,
            caps:   Vec::new(),
        }
    }

    /// Whether the retiring native-messaging hand, rather than Kimberlite, runs this machine's turns.
    ///
    /// Kimberlite always says who it is: its hello and its own engine's machine both carry
    /// [`CAP_EXECUTOR_KIMBERLITE`], and its hello's `bin:` names the `kimberlite` image.  A turn
    /// with neither is the hand's -- including an older hand that predates the `bin:` cap -- so a
    /// hand is never refused its own kit for having said too little about itself.
    // R10: delete with the hand.
    pub fn runs_hand(&self) -> bool {
        let kimb_bin = self.caps.iter()
            .find_map(|c| c.strip_prefix("bin:"))
            .and_then(|p| p.rsplit('/').next())
            == Some("kimberlite");
        !kimb_bin && !self.caps.iter().any(|c| c == CAP_EXECUTOR_KIMBERLITE)
    }

    /// Does this machine run its commands inside a whole-home fence?
    ///
    /// Then no toolkit row widens what a command reaches, so a toolchain is never asked for nor
    /// refused for want of a grant: on the runner nobody could answer the question, and every
    /// `python3` or `cargo` would be refused.  Only Kimberlite says so ([`CAP_FENCE_WHOLE_HOME`]);
    /// the hand never does, and asks as it always has.
    pub fn whole_home(&self) -> bool {
        self.caps.iter().any(|c| c == CAP_FENCE_WHOLE_HOME)
    }

    /// Whether the granted root is a path a fence can be expressed against.
    pub fn rooted(&self) -> bool {
        !self.root.is_empty() && self.root.starts_with('/')
    }
}

// Whether a command has anywhere to run, for a decision that cannot await it
//
// `ToolRegistry::offered` has to decide whether the machine tools are worth their schema BEFORE
// the request goes out, and asking the hand is an `await` it does not have -- it is called from
// `definitions_json`, from `tool_names` and from the Tools panel alike.  So the answer is recorded
// where it IS asked: `prompts::machine_briefing` is composed once per turn, before the schema
// array is built, from the same `status()` call `Tool::run` makes, and returns it; the turn's
// owner then sets it on the turn's own registry (`ToolRegistry::set_machine_rooted`).
//
// ON THE REGISTRY AND NOT THE PAGE (UNBLOCK-32 F4b).  It was a thread-local, one value for the
// whole page, written by whichever context briefed last: another Diamond's turn, or the Wire band
// opened mid-turn, flipped a rooted turn to "nowhere to run", swapped `run`'s schema for its stub
// mid-turn (a prefix-cache miss) and ended the turn on a false question.
//
// `None` is "nobody has asked yet" and OFFERS the tools, which is the only safe default: a build
// with no briefing composer, or the moment before the first one runs, must not withhold a tool the
// user can actually use.

// The name of the device this page runs on
//
// A PAGE FACT, not a turn's: every turn on the page runs on the same device, so one value is the
// truth for all of them, which is why this one may be a thread-local where the machine answer
// above may not.  Set by the page from its own device label (`set_device_label` in `wasm::entry`)
// before each turn, because the label can be renamed.  A sentence a turn ends on names the device
// that ran it, since on a handed-off turn the reader is somewhere else (UNBLOCK-32 F4b).

thread_local! {
    pub(super) static DEVICE_LABEL: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

/// Record the name the person knows this device by.
pub fn set_device_label(name: &str) {
    DEVICE_LABEL.with(|c| *c.borrow_mut() = name.trim().to_string());
}

/// The name the person knows this device by, or "the device running this turn" where the page
/// has not said.
pub fn device_label() -> String {
    let n = DEVICE_LABEL.with(|c| c.borrow().clone());
    if n.is_empty() { "the device running this turn".to_string() } else { n }
}

/// What `run` says of itself where there is nowhere to run it; see
/// [`ToolRegistry::machine_stub_json`].
pub const RUN_STUB_DESC: &str =
    "Not available on this device: no folder on this computer is reachable from this page. Call \
     it only when the ask cannot be done without a command. Nothing runs: the turn ends and the \
     user is asked for what is missing.";
pub const RUN_STUB_PARAMS: &str = r#"{"type":"object","properties":{"argv":{"type":"array","items":{"type":"string"},"description":"What you would run."}},"required":["argv"]}"#;

/// The value of a `key:<value>` capability entry, where the hand sent one.
///
/// # Arguments
/// * `caps` - What the hand reported in its `hello`.
/// * `key` - The entry's name, without its colon.
pub(super) fn cap_value(caps: &[String], key: &str) -> Option<String> {
    let pre = fmt!("{}:", key);
    caps.iter().find_map(|c| c.strip_prefix(&pre).map(|v| v.to_string()))
}

// ── A toolchain asked for on first use ─────────────────────────────
//
// Workspace round 2, E1 (specs/daimond_workspace_firstprinciples_20261009.md §3.3).  A toolkit is
// still never INFERRED from what the model ran: the command only chooses which question is put,
// and the grant is the user's press in the consent door.  A no is not remembered past the command
// (N2), and nothing but that press and the head's Toolchains entry writes `set_toolkits` (N3).

/// The name the toolchain question travels under through the consent door.
pub const KIT_TOOL: &str = "toolkit";

/// The word a yes to [`KIT_TOOL`] comes back as, and nothing else: an `allow` from a posture, a
/// shortcut or an older page means no here, for the reason [`RUN_NET_ALLOW_WORD`] gives.
pub const KIT_ALLOW_WORD: &str = "allow-kit";

/// The git subcommands that use the user's identity, and so ask for the Git toolkit.
pub(super) const GIT_IDENTITY: [&str; 4] = ["commit", "merge", "rebase", "tag"];

/// The toolkits one simple command needs, from its words.
pub(super) fn kits_of_words(words: &[&str], out: &mut Vec<Toolkit>) {
    // Assignments and the wrappers that run the next word as the command.
    let mut i = 0;
    while i < words.len() {
        let w = words[i];
        let wrapper = matches!(w, "env" | "exec" | "command" | "time" | "nohup" | "nice");
        if wrapper || (w.contains('=') && !w.starts_with('-') && !w.starts_with('=')) {
            i += 1;
        } else {
            break;
        }
    }
    let prog = match words.get(i) {
        Some(p) => p.rsplit('/').next().unwrap_or(p),
        None    => return,
    };
    let mut push = |k: Toolkit| if !out.contains(&k) { out.push(k); };
    if prog == "git" {
        // The first word that is not an option is the subcommand; `-C` and `-c` take a value.
        let mut j = i + 1;
        while j < words.len() {
            let w = words[j];
            if w == "-C" || w == "-c" {
                j += 2;
            } else if w.starts_with('-') {
                j += 1;
            } else {
                if GIT_IDENTITY.contains(&w) {
                    push(Toolkit::Git);
                }
                break;
            }
        }
        return;
    }
    for k in Toolkit::all() {
        if k.programs().contains(&prog) {
            push(k);
        }
    }
}

/// The toolkits a command line needs: its program, and each simple command inside a `sh -c`.
///
/// A plain split on the shell's separators, not a parser.  A wrapper script calling `cargo` is
/// not seen here; the fence refuses it as before.
pub fn kits_wanted(argv: &[String]) -> Vec<Toolkit> {
    let mut out = Vec::new();
    let prog = match argv.first() {
        Some(p) => p.rsplit('/').next().unwrap_or(p),
        None    => return out,
    };
    let shell = matches!(prog, "sh" | "bash" | "dash" | "zsh");
    let script = argv.iter().skip(1)
        .position(|a| a.starts_with('-') && !a.starts_with("--") && a.contains('c'))
        .and_then(|p| argv.get(p + 2));
    match (shell, script) {
        (true, Some(s)) => {
            let cut: String = s.chars()
                .map(|c| if matches!(c, ';' | '&' | '|' | '\n' | '(' | ')' | '`' | '{' | '}')
                    { '\n' } else { c })
                .collect();
            for line in cut.split('\n') {
                let words: Vec<&str> = line.split_whitespace()
                    .map(|w| w.trim_matches(|c| c == '"' || c == '\''))
                    .filter(|w| !w.is_empty() && *w != "$")
                    .collect();
                kits_of_words(&words, &mut out);
            }
        },
        _ => {
            let words: Vec<&str> = argv.iter().map(|a| a.as_str()).collect();
            kits_of_words(&words, &mut out);
        },
    }
    out
}

/// Which toolkits to ask the user for before a command runs; empty means run as it stands.
///
/// Asked only where the answer can be a press here: a Diamond's own turn (there is somewhere to
/// record the yes), someone watching (a worker alone has nobody to ask), a rung that asks
/// ([`Mode::Bypass`] never does), and a hand that reported a home (without one a grant reaches
/// nothing).  Everywhere else the command runs inside the fence it has, as before.
///
/// # Arguments
/// * `argv` - The command.
/// * `granted` - The toolkits this turn already holds.
/// * `can_ask` - Whether the question can be put at all, as above.
pub fn kits_to_ask(argv: &[String], granted: &[Toolkit], can_ask: bool) -> Vec<Toolkit> {
    if !can_ask {
        return Vec::new();
    }
    kits_wanted(argv).into_iter().filter(|k| !granted.contains(k)).collect()
}

/// The toolkits a command's own "not found" names, where a question before it ran could not see
/// them: a wrapper script calling `cargo` (§7 of the Workspace spec).  Empty unless the shell
/// itself gave up on a program (exit 127) and that program is one an ungranted toolkit lends.
///
/// Read from the shells' own sentences -- bash's `cargo: command not found`, dash's `cargo: not
/// found` and env's `'cargo': No such file or directory` -- and from nothing else, so a program
/// reporting a missing FILE is not mistaken for a missing toolchain.  Git is never named, since
/// [`Toolkit::programs`] lists none for it.
///
/// # Arguments
/// * `err` - The command's stderr.
/// * `exit` - Its exit status.
/// * `granted` - The toolkits the command already ran with.
pub fn kits_not_found(err: &str, exit: i64, granted: &[Toolkit]) -> Vec<Toolkit> {
    let mut out: Vec<Toolkit> = Vec::new();
    if exit != 127 {
        return out;
    }
    for line in err.lines() {
        let head = if let Some(h) = line.strip_suffix(": command not found") {
            h
        } else if let Some(h) = line.strip_suffix(": not found") {
            h
        } else if let Some(h) = line.strip_suffix(": No such file or directory") {
            // Only env's form: a bare path here is a program's own missing file.
            if !line.starts_with("env: ") { continue; }
            h
        } else {
            continue;
        };
        let word = head.rsplit(": ").next().unwrap_or(head)
            .trim_matches(|c| c == '\'' || c == '"' || c == '`' || c == '\u{2018}' || c == '\u{2019}');
        let prog = word.rsplit('/').next().unwrap_or(word);
        for k in Toolkit::all() {
            if !granted.contains(&k) && !out.contains(&k) && k.programs().contains(&prog) {
                out.push(k);
            }
        }
    }
    out
}

/// What the daimon reads after a "not found" raised the toolchain question once the command had
/// run: granted for this turn and to be run again, or the user's no, which is not to be retried.
pub fn kit_after_note(argv: &[String], kits: &[Toolkit], answer: Permit) -> String {
    match answer {
        Permit::Allow   => fmt!("\n[{} was not found by this command because this Diamond had \
            not been granted it. The user has now granted it: run '{}' again.]",
            kit_labels(kits), safe_origin(&argv.join(" "))),
        Permit::No(no)  => fmt!("\n[{} is installed but not granted to this Diamond, and {}. It \
            is asked again the next time a command needs it, so say what you wanted it for rather \
            than retrying.]", kit_labels(kits), permit_no_clause(no)),
    }
}

/// Why a permit was not granted, as a clause the model reads after "and".  Only a refusal says
/// the user decided; the other three say plainly that the user did not.
pub(super) fn permit_no_clause(no: PermitNo) -> &'static str {
    match no {
        PermitNo::Refused   => "the user said not now",
        PermitNo::TimedOut  => "the user was asked and didn't answer in time, so the user did not \
            say no",
        PermitNo::Unasked   => "this device could not ask on the user's other device, so the user \
            did not say no",
        PermitNo::Absent    => "the user could not be asked on this device, so the user did not \
            say no",
    }
}

/// The kits named for a person: "Rust", "Rust and Git", "Rust, Node and Git".
pub fn kit_labels(kits: &[Toolkit]) -> String {
    let names: Vec<&str> = kits.iter().map(|k| k.label()).collect();
    match names.split_last() {
        None              => String::new(),
        Some((l, []))     => fmt!("{}", l),
        Some((l, rest))   => fmt!("{} and {}", rest.join(", "), l),
    }
}

/// What the daimon reads when the user says no to a toolchain, or nobody answers.
///
/// Says it is the user's decision and that it is not remembered, so the daimon neither reworks
/// the command nor concludes the toolchain is missing from the computer.
pub fn kit_refusal(argv: &[String], kits: &[Toolkit], no: PermitNo) -> String {
    fmt!("Refused: '{}' needs {}, which this Diamond has not been granted, and {}. Nothing was \
        run. {} is waiting for the user's yes; it is asked again the next time a command needs \
        it, so say what you wanted it for rather than retrying.",
        safe_origin(&argv.join(" ")), kit_labels(kits), permit_no_clause(no), kit_labels(kits))
}

// Workspace round 2, E2 (specs/daimond_workspace_firstprinciples_20261009.md §3.3).  A model's
// write refused for being outside what its Diamond may change is put to the user once, in the
// moment, through the consent door: "Let <Diamond> change <place>?".  The place is the NARROWEST
// folder holding the file (owner, 2026-10-09), or the waiting mark over it where one was made on
// another device.  A yes is the page writing the same `holds` link and marks-here entry the ◈
// writes; a no is not remembered (N2).

/// The name the write question travels under through the consent door.
pub const PLACE_TOOL: &str = "place";

/// The word a yes to [`PLACE_TOOL`] comes back as, and nothing else (see [`KIT_ALLOW_WORD`]).
pub const PLACE_ALLOW_WORD: &str = "allow-place";

/// A refused write the user may be asked about.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlaceAsk {
    pub path:       String, // normalised, as refused
    pub place:      String, // what a yes adds
    pub waiting:    bool,   // `place` is a mark made on another device
}

impl PlaceAsk {
    /// The question's detail for the page, which draws and records from it.
    pub fn detail(&self, id: &str) -> String {
        fmt!("{{\"id\":\"{}\",\"place\":\"{}\",\"waiting\":{}}}",
            json_escape(id), json_escape(&self.place), self.waiting)
    }
}

/// The narrowest folder holding `path`: its parent, or the file itself at the root.
pub fn narrowest_place(path: &str) -> String {
    let p = normalise(path);
    match p.rfind('/') {
        Some(i) => fmt!("{}", &p[..i]),
        None    => p,
    }
}

/// What the daimon reads when the user says no to a write, or nobody answers.
pub fn place_refusal(ask: &PlaceAsk, no: PermitNo) -> String {
    let why = match no {
        PermitNo::Refused   => fmt!("the user said not now to this Diamond changing '{}', so '{}' \
            was not changed", ask.place, ask.path),
        _                   => fmt!("'{}' was not changed, because this Diamond may not change \
            '{}' yet and {}", ask.path, ask.place, permit_no_clause(no)),
    };
    fmt!("Refused: {}. It is asked again the next time a write needs it, so say what you wanted \
        to change rather than retrying.", why)
}

/// The page's door for a write question; none on a native build, where nobody is there to press.
pub(super) async fn place_door<H: Host>(ask: PlaceAsk, id: String, turn: String, host: &H) -> Option<Permit> {
    if !H::HOSTED {
        let _ = (ask, id, turn, host);
        return None;
    }
    host.net().egress_allowed_place(&turn, &ask.path, &ask.detail(&id)).await
}

/// The toolkits a turn's bounds grant, in the order the user gave them and each named once.
///
/// # Arguments
/// * `bounds` - The turn's [`Bound`] rules.
pub fn toolkits(bounds: &[Bound]) -> Vec<Toolkit> {
    let mut out: Vec<Toolkit> = Vec::new();
    for b in bounds {
        if let Bound::Toolkit(k) = b {
            if !out.contains(k) {
                out.push(*k);
            }
        }
    }
    out
}

/// The toolkits a turn grants, as the JSON array of names the wire carries.
///
/// The hand clamps an arriving fence against the toolchains it was told were granted, and it has to
/// be TOLD: a toolchain does not live in the workspace, so a fence naming `~/.cargo/registry`
/// cannot be checked against the granted root, and the alternative -- allowing every toolchain
/// folder unconditionally -- is what let a fence name `~/.local/bin` writable when nothing had been
/// granted at all.
///
/// The names are read back out of the bounds rather than passed alongside them, so there is exactly
/// one place a toolkit can enter a request and it is the same place [`fence_spec`] and
/// [`Kit::resolve`] read: what the user granted.  `argv` never reaches this.
///
/// # Arguments
/// * `bounds` - The turn's [`Bound`] rules.
pub fn toolkit_names_json(bounds: &[Bound]) -> String {
    let names: Vec<String> = toolkits(bounds).iter()
        .map(|k| fmt!("\"{}\"", k.name()))
        .collect();
    fmt!("[{}]", names.join(","))
}

/// The toolchains a Diamond recorded, as rules in its turn's bounds.
///
/// The companion to [`diamond_bounds`], and separate from it for the reason a grant is separate
/// from a scope: a Diamond's directories are what it holds, and a toolkit is what the user decided
/// to lend it.  A caller composes the two -- `diamond_bounds(..)` then `extend(toolkit_bounds(..))`
/// -- so that neither can be built without the other being visible in the same expression.
///
/// **The names come from what the user granted, and from nowhere else.**  In particular they are
/// never derived from `argv`: a fence that widened itself to fit the requested binary would be a
/// fence the model chooses, and the whole arrangement rests on its not being one.  `cargo` is
/// reachable because the user granted the Rust toolkit, and for no other reason.
///
/// A name this build does not know is DROPPED, not refused.  A workspace written by a later build
/// may record a toolkit this one cannot express, and the safe reading of "I do not know what that
/// grants" is "it grants nothing" -- refusing the whole list would take away the grants that ARE
/// known, and approximating it would grant paths nobody chose.
///
/// # Arguments
/// * `names` - The recorded toolkit names, as [`Toolkit::name`] spells them.
pub fn toolkit_bounds(names: &[String]) -> Vec<Bound> {
    // `true` asks for the WIDEST list this build can compose and then drops the terminal-only
    // part of it, rather than asking for a narrow one. That is deliberate: the filter below is
    // the rule that matters, and a filter reached only by a branch nothing takes is a rule
    // nothing tests. This way every call through this door exercises it.
    terminal_toolkit_bounds(names, true).into_iter()
        // The one narrowing between the two doors, and the whole of it. A toolkit marked
        // [`Toolkit::terminal_only`] is a grant to a surface the USER opened; a command is a
        // surface a daimon reaches, so the rule is dropped here and can never enter a turn's
        // bounds by this route. Dropped rather than refused, exactly as an unknown name is:
        // the Diamond legitimately records the grant, and what this door does with it is
        // grant nothing.
        .filter(|b| !matches!(b, Bound::Toolkit(k) if k.terminal_only()))
        .collect()
}

/// The toolchains a Diamond recorded, for a terminal the user opened by hand.
///
/// The same list as [`toolkit_bounds`] plus the grants that belong to this door alone.
/// **`crate::wasm::pty::pty_request` is the only caller there should ever be**, and a second
/// one is a decision about trust rather than a convenience: see [`Toolkit::terminal_only`].
///
/// **The two arguments come from different people and that is the point.**  `names` is what the
/// USER lent this Diamond and it is per Diamond; `remote` is what the user did to this COMPUTER
/// and it is per machine.  [`Toolkit::Remote`] cannot arrive through `names` at all -- it is not
/// in [`Toolkit::all`], so [`Toolkit::parse`] does not answer to it and no Diamond can record it
/// -- which is why moving its scope needed no new store and left the three refusals where they
/// were.
///
/// # Arguments
/// * `names` - The recorded toolkit names, as [`Toolkit::name`] spells them.
/// * `remote` - [`Machine::remote`]: whether Daimond's own ssh is set up on this computer.  Never
///   taken from the ask, for the reason no toolkit ever is -- a caller that could name its own
///   grant would be choosing its own fence.
pub fn terminal_toolkit_bounds(names: &[String], remote: bool) -> Vec<Bound> {
    let mut out: Vec<Bound> = Vec::new();
    for n in names {
        if let Ok(k) = Toolkit::parse(n) {
            let b = k.bound();
            if !out.contains(&b) {
                out.push(b);
            }
        }
    }
    if remote {
        let b = Toolkit::Remote.bound();
        if !out.contains(&b) {
            out.push(b);
        }
    }
    out
}

/// The bounds the interactive terminal runs with: a Diamond's, with its allow-list taken away.
///
/// **A terminal is the user at a keyboard, not a daimon, so its fence is the machine grant and not
/// this Diamond's attachments.**  The owner asked for it in those words on 2026-08-26 (9348afc4):
/// *"I don't really want the terminal to be daimon and chat workspace bound, I want it to be able
/// to roam over the browser and machine workspaces of the user"*.  No [`Tool`] opens a terminal or
/// types into one, so a daimon cannot reach this surface -- which is the whole reason the widening
/// is safe here and would not be in `Tool::Run`.
///
/// **Only the allow-list goes.**  A folder the user marked read-only keeps its [`Bound::NoWrite`],
/// Daimond's own directory keeps its [`Bound::NoRead`], and every standing credential deny
/// [`fence_spec_surfaced`] applies is untouched; only [`Surface::Terminal`] lifts `.ssh`.  With no
/// allow-list left, [`fence_spec_surfaced`] reads the turn as unscoped and grants the granted root.
/// [`Bound::Nowhere`] goes too: a terminal that belongs to no Diamond is an ordinary terminal.
///
/// **`crate::wasm::pty::pty_request` is the only caller there should ever be.**  A scoped command
/// fence must never equal what this composes, and a unit test pins that the two stay apart.
///
/// **R2 becomes a hole the day a daimon gets a tool that types into a terminal**: this fence, the
/// lifted `.ssh` and the Remote toolchain's ssh key are then a daimon's, and an ssh is a shell on
/// another machine no fence here binds.
///
/// # Arguments
/// * `toolkits` - The toolkit names the user granted this Diamond, never anything from `argv`.
/// * `remote` - [`Machine::remote`], the machine's answer, see [`terminal_toolkit_bounds`].
pub fn terminal_bounds(
    own_dir:   &str,
    attached:  &[String],
    read_only: &[String],
    toolkits:  &[String],
    remote:    bool,
) -> Vec<Bound> {
    let mut out: Vec<Bound> = diamond_bounds(own_dir, attached, read_only)
        .into_iter()
        .filter(|b| !matches!(b,
            Bound::OnlyUnder(_) | Bound::OnlyWriteUnder(_) | Bound::Nowhere))
        .collect();
    // `terminal_toolkit_bounds` and not `toolkit_bounds`: the Remote toolkit lends an ssh key, and
    // a person typing here may use it where a daimon's `run` never can.
    out.extend(terminal_toolkit_bounds(toolkits, remote));
    out
}

// ── Two bounds on one turn ───────────────────────────────────────────────────
//
// A turn can be narrowed twice: once by the Diamond it works for, and once by the skill it runs
// under. Until this existed, the second narrowing was ASSIGNED over the first (`src/handler.rs`),
// so whichever ran last won and the other vanished without a word -- either the daimon lost its
// Diamond's allow-list, or the skill lost its carve-out (`hand/REVIEW.md` §1.12). What follows is
// the merge, and the whole of its correctness is one sentence: the result permits a path only where
// BOTH lists permitted it.

/// The allow-list a bound list declares: whether one is declared at all, and the prefixes it names.
///
/// The two answers are separate because they pull opposite ways, exactly as
/// [`ToolContext::within_allow_list`] has them: a prefix that normalises away is DECLARED and names
/// nothing, so a scope naming nowhere is not the same as no scope.
///
/// # Arguments
/// * `bounds` - The list to read.
pub(super) fn allow_list(bounds: &[Bound]) -> (bool, Vec<String>) {
    let mut declared = false;
    let mut out: Vec<String> = Vec::new();
    for b in bounds {
        if let Bound::OnlyUnder(p) = b {
            declared = true;
            let n = normalise(p);
            if !n.is_empty() && !out.contains(&n) {
                out.push(n);
            }
        }
    }
    (declared, out)
}

/// As [`allow_list`], for the WRITE allow-list a chat's worker carries.
///
/// Separate because the two fence different things and a turn may carry either, both or neither.
/// It exists chiefly so [`compose`] cannot drop one: a composition that silently lost a write
/// fence would be a widening, and every widening in here is silent by nature.
///
/// # Arguments
/// * `bounds` - The rules to read.
pub(super) fn write_allow_list(bounds: &[Bound]) -> (bool, Vec<String>) {
    let mut declared = false;
    let mut out: Vec<String> = Vec::new();
    for b in bounds {
        if let Bound::OnlyWriteUnder(p) = b {
            declared = true;
            let n = normalise(p);
            if !n.is_empty() && !out.contains(&n) {
                out.push(n);
            }
        }
    }
    (declared, out)
}

/// Intersect two allow-lists, as [`compose`] intersects them.
///
/// Two prefixes that both contain some path are both prefixes of it, so one is inside the other:
/// comparable or disjoint, and there is no third case.
///
/// # Arguments
/// * `dec_a`, `a` - Whether the first side declared a list, and what it named.
/// * `dec_b`, `b` - The same for the second.
pub(super) fn intersect_allow(dec_a: bool, a: Vec<String>, dec_b: bool, b: Vec<String>) -> Vec<String> {
    if dec_a && dec_b {
        let mut v: Vec<String> = Vec::new();
        for x in &a {
            for y in &b {
                let keep = if under(x, y) {
                    Some(x)
                } else if under(y, x) {
                    Some(y)
                } else {
                    None
                };
                if let Some(p) = keep {
                    if !v.contains(p) {
                        v.push(p.clone());
                    }
                }
            }
        }
        v
    } else if dec_a {
        a
    } else if dec_b {
        b
    } else {
        Vec::new()
    }
}

/// Whether `bounds` permits reading EVERYTHING beneath `prefix`, which is already normalised.
///
/// Used to decide whether one list's read carve-out may survive being composed with another.  The
/// question has to be asked of the whole subtree rather than of the prefix itself, because
/// [`ToolContext::may_read`] answers a carve-out before it looks at any deny: a carve-out kept over
/// a list that denies part of its subtree would open that part too.
///
/// # Arguments
/// * `bounds` - The other list, whose denials this carve-out must not punch through.
/// * `prefix` - The normalised, non-empty carve-out prefix.
pub(super) fn permits_subtree(bounds: &[Bound], prefix: &str) -> bool {
    // A hole in the other list that covers this one: then the other list carves out the subtree
    // too, and keeping this carve-out grants nothing the other did not.
    if bounds.iter().any(|b| matches!(b, Bound::MayRead(c)
        if !normalise(c).is_empty() && under(prefix, c)))
    {
        return true;
    }
    // Otherwise no denial of the other list may touch the subtree, in either direction: one above
    // it denies the whole of it, one inside it denies a part.
    !bounds.iter().any(|b| match b {
        Bound::NoRead(d) => {
            let n = normalise(d);
            denied_under(prefix, &n) || denied_under(&n, prefix)
        },
        _ => false,
    })
}

/// Two bounds on one turn, merged into the one list both doors read: what BOTH permit, and never
/// one thing more.
///
/// A turn can be narrowed twice -- scoped to a Diamond and running under a skill -- and the two
/// narrowings must COMPOSE.  Assigning one over the other deletes the other silently, which is the
/// one way this can go wrong that nobody notices (`hand/REVIEW.md` §1.12).
///
/// **The invariant, and it is the whole of the security argument: the result is at least as narrow
/// as each input taken alone.**  For every path, `compose(a, b)` permits it only where `a` permitted
/// it and `b` permitted it.  Composition can therefore never be a way to widen a bound by adding a
/// second one, which is what makes it safe to call from anywhere a bound is about to be set.
///
/// Rule by rule, and each is stated as what it must not do:
///
/// * **An EMPTY list is no restriction**, so composing with one yields the other unchanged.  This is
///   the case that runs today: the native handler's context carries no bounds, so a skill turn
///   composes to exactly [`skill_bounds`], as it did when the line assigned.
/// * **[`Bound::Nowhere`] on either side decides the whole list.**  Nothing widens nothing.
/// * **Allow-lists INTERSECT.**  Two prefixes overlap only where one contains the other, and then
///   the intersection is the deeper of the two; two disjoint prefixes intersect in nothing.  The
///   intersection is therefore exactly expressible as a union of prefixes and is never approximated.
///   If a scope was declared on either side and the intersection is empty, the result is
///   [`Bound::Nowhere`] -- NOT an empty allow-list, which reads as no allow-list at all and would
///   hand back everything the two lists were narrowing.  That is the empty-prefix trap arriving
///   through the merge, and refusing is the answer to it.
/// * **Denials UNION.**  A denial from either side denies, which is the direction that narrows.
/// * **A read carve-out survives only where the other list would have permitted the whole of it
///   anyway** (see [`permits_subtree`]), and only inside the composed allow-list.  A carve-out is a
///   hole punched in ITS OWN deny fence, and a hole in one fence is not a hole in the other.  So a
///   skill's carve-out for its own folder does NOT survive composition with a Diamond's scope: the
///   Diamond denies its whole directory and does not allow-list it, and "the allow-list wins" is
///   what [`Bound::MayRead`] has always said.  A skill running inside a Diamond therefore cannot
///   read its own shipped references, and is refused in those words rather than quietly widening the
///   Diamond to reach them.
/// * **A [`Bound::Toolkit`] survives only where BOTH sides granted it.**  A toolkit is machine paths
///   a command may reach, so carrying one across from a list that granted it into a turn bounded by
///   a list that did not would widen that turn's fence -- the one thing this must not do.  A caller
///   that means to compose a narrowing and keep a grant says so in its own expression, by extending
///   [`toolkit_bounds`] onto the result, where the decision is visible.
///
/// The merge is symmetric in effect; the argument order decides only the order of the result, and
/// therefore which allowed directory [`ToolContext::default_cwd`] picks.  Pass the turn's existing
/// bounds first.
///
/// # Arguments
/// * `a` - The bounds the turn already carries.
/// * `b` - The bounds being applied on top of them.
pub fn compose(a: &[Bound], b: &[Bound]) -> Vec<Bound> {
    // No restriction composed with a restriction is that restriction. Read before anything else:
    // an empty list has no allow-list to intersect, and treating it as one that named nowhere would
    // turn every ordinary turn into `Nowhere`.
    if a.is_empty() {
        return b.to_vec();
    }
    if b.is_empty() {
        return a.to_vec();
    }
    if a.iter().chain(b.iter()).any(|x| matches!(x, Bound::Nowhere)) {
        return vec![Bound::Nowhere];
    }
    let (dec_a, allow_a) = allow_list(a);
    let (dec_b, allow_b) = allow_list(b);
    let allow: Vec<String> = intersect_allow(dec_a, allow_a, dec_b, allow_b);
    // The write allow-list, intersected the same way and for the same reason. Dropping it -- which
    // is what happened before it was named here -- would compose a chat's worker, whose writing is
    // fenced, into a turn whose writing is not. Every mistake this function can make is silent, and
    // that one is silent AND in the direction of more reach.
    let (wdec_a, wallow_a) = write_allow_list(a);
    let (wdec_b, wallow_b) = write_allow_list(b);
    let write_allow: Vec<String> = intersect_allow(wdec_a, wallow_a, wdec_b, wallow_b);
    if (wdec_a || wdec_b) && write_allow.is_empty() {
        return vec![Bound::Nowhere];
    }
    if (dec_a || dec_b) && allow.is_empty() {
        // A scope was declared and the two sides have no place in common -- or the only side that
        // declared one named nowhere usable. Emitting no rule at all would say "unscoped", which is
        // the widest answer there is to the narrowest question. Refuse instead.
        return vec![Bound::Nowhere];
    }
    let mut out: Vec<Bound> = Vec::new();
    for p in &allow {
        out.push(Bound::OnlyUnder(p.clone()));
    }
    for p in &write_allow {
        out.push(Bound::OnlyWriteUnder(p.clone()));
    }
    // Denials from both sides, normalised so one prefix spelled two ways is one rule.
    for src in [a, b] {
        for x in src {
            let rule = match x {
                Bound::NoWrite(p) => Bound::NoWrite(normalise(p)),
                Bound::NoRead(p)  => Bound::NoRead(normalise(p)),
                Bound::NoSecretNames => Bound::NoSecretNames,
                _                 => continue,
            };
            if !out.contains(&rule) {
                out.push(rule);
            }
        }
    }
    // Carve-outs, each tested against the list it did not come from.
    for (src, other) in [(a, b), (b, a)] {
        for x in src {
            let p = match x {
                Bound::MayRead(p) => normalise(p),
                _                 => continue,
            };
            // A carve-out that names nowhere carves nothing: `under(p, "")` is true for every path.
            if p.is_empty() {
                continue;
            }
            if (dec_a || dec_b) && !allow.iter().any(|q| under(&p, q)) {
                continue;
            }
            if !permits_subtree(other, &p) {
                continue;
            }
            let rule = Bound::MayRead(p);
            if !out.contains(&rule) {
                out.push(rule);
            }
        }
    }
    // Granted on both sides or not at all.
    for x in a {
        if let Bound::Toolkit(k) = x {
            let rule = Bound::Toolkit(*k);
            if b.contains(&rule) && !out.contains(&rule) {
                out.push(rule);
            }
        }
    }
    out
}

/// Every toolkit a turn was granted, resolved to absolute paths on one machine.
///
/// One value rather than one per toolkit, because a Diamond building a web front end against a Rust
/// back end needs both and `PATH` can only be sent once.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Kit {
    /// Which toolkits this came from.
    pub kits: Vec<Toolkit>,
    /// Absolute paths the command may read.
    pub ro:   Vec<String>,
    /// Absolute paths the command may write.
    pub rw:   Vec<String>,
    /// Absolute paths denied outright.
    pub deny: Vec<String>,
    /// The environment that finds the toolchains, ready for the wire.
    pub env:  Vec<(String, String)>,
}

impl Kit {

    /// The toolkits `bounds` grant, resolved against `m`, or `None` where there is nothing to
    /// resolve or nowhere to resolve it against.
    ///
    /// `None` for two quite different reasons, and a caller that wants to tell them apart asks
    /// [`toolkits`] as well: no toolkit was granted, or one was and this hand did not report a home
    /// directory.  The second is why the briefing says so rather than staying silent -- a daimon
    /// that has been told `cargo` is available and finds it refused has been told something false.
    ///
    /// # Arguments
    /// * `bounds` - The turn's [`Bound`] rules.
    /// * `m` - The machine the hand described.
    pub fn resolve(bounds: &[Bound], m: &Machine) -> Option<Self> {
        let kits = toolkits(bounds);
        if kits.is_empty() {
            return None;
        }
        let home = match &m.home {
            Some(h) if abs_dir(h) => h.trim_end_matches('/').to_string(),
            _                     => return None,
        };
        let mut out = Self { kits: kits.clone(), ..Self::default() };
        let mut bins: Vec<String> = Vec::new();
        for k in &kits {
            for g in k.grants_on(m).iter().chain(CREDS.iter()) {
                let p = match home_path(&home, g.tail) {
                    Some(p) => p,
                    None    => continue,
                };
                let list = match g.level {
                    Level::Ro   => &mut out.ro,
                    Level::Rw   => &mut out.rw,
                    Level::Deny => &mut out.deny,
                };
                if !list.contains(&p) {
                    list.push(p);
                }
            }
            for b in k.bins_on(m) {
                if let Some(p) = home_path(&home, b) {
                    if !bins.contains(&p) {
                        bins.push(p);
                    }
                }
            }
            for (name, tail) in k.vars() {
                if let Some(p) = home_path(&home, tail) {
                    let pair = (name.to_string(), p);
                    if !out.env.iter().any(|(n, _)| n == name) {
                        out.env.push(pair);
                    }
                }
            }
        }
        // The one variable that is not a path under a granted folder but the folder they are all
        // under. See `Toolkit::needs_home` for why this is safe and why it is not general.
        if kits.iter().any(|k| k.needs_home()) && !out.env.iter().any(|(n, _)| n == "HOME") {
            out.env.push((fmt!("HOME"), home.clone()));
        }
        if !bins.is_empty() {
            // The base is appended and not replaced: a build reaches `cc`, `ld` and `git` through
            // it, and a toolkit that took them away would break the builds it exists to enable.
            out.env.push((fmt!("PATH"), fmt!("{}:{}", bins.join(":"), PATH_BASE)));
        }
        Some(out)
    }

    /// This kit's environment as the JSON the hand reads: a list of `[name, value]` pairs.
    pub fn env_json(&self) -> String {
        env_json_of(&self.env)
    }
}

/// An environment as the JSON the hand reads: a list of `[name, value]` pairs.
///
/// Separate from [`Kit::env_json`] because a command's environment now has two sources -- the
/// granted toolchain and, on a push, the credential -- and one serialiser for both is what stops
/// them being escaped by two slightly different rules.
///
/// # Arguments
/// * `env` - The pairs, in the order they should reach the hand.
pub(super) fn env_json_of(env: &[(String, String)]) -> String {
    let pairs: Vec<String> = env.iter()
        .map(|(k, v)| fmt!("[\"{}\",\"{}\"]", json_escape(k), json_escape(v)))
        .collect();
    fmt!("[{}]", pairs.join(","))
}

/// Which surface a fence is being built for.
///
/// This decides ONE thing and only one: whether `~/.ssh` is denied.  Everything else
/// [`fence_spec_surfaced`] computes -- the allow-list, the credential denies, the toolkit fold, the
/// net rule -- is identical for both surfaces, and the two secrets a shell reaches for, the private
/// keys and the known hosts, both live under `~/.ssh` and nowhere else.
///
/// [`Surface::Tool`] is what every command and every [`compose`] door builds: `.ssh` denied like
/// every other secret in [`ALWAYS_DENIED`].  [`Surface::Terminal`] is built at exactly one call
/// site -- `wasm/pty.rs`, where a person is typing into an interactive pseudo-terminal -- and it
/// omits the `.ssh` deny so a user can `ssh` from the Daimond terminal as themselves.
///
/// **Why lifting `.ssh` is safe, and only there.**  A terminal is the user at a keyboard, not a
/// daimon: no [`Tool`] opens a terminal or types into one, and `pty_request` is reached only by a
/// page-driven wasm entry, never a tool dispatch or an agent turn.  So the carve touches no
/// model-driven path.  And the surface is a code-path constant -- a literal at the one pty call
/// site, never read from the ask, the bounds, the machine or anything a request could shape -- so a
/// daimon has no way to name [`Surface::Terminal`] and no way to reach the code that does.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Surface {
    Tool,      // a command or a compose door -- `.ssh` denied like every other secret
    Terminal,  // the interactive pty, the user at a keyboard -- `.ssh` readable, nothing else lifted
}

/// The bounds a turn runs with, restated as the fence the machine hand enforces.
///
/// This is the whole of the compartmentalisation claim, and it is worth being clear about why it
/// is so short: [`diamond_bounds`] already produces exactly the structure a landlock ruleset wants
/// -- a set of paths, each read-only or read-write, plus a deny for Daimond's own directory.  The
/// compartment is therefore **not a new concept**.  It is the same [`Bound`] list enforced one
/// layer down, and only the mechanism changes: today the guarantee is structural because the
/// daimon's root is a different filesystem; with a kernel fence it stays structural.
///
/// Three things this function must get right, because all three are silent when wrong:
///
/// * **A path in Daimond's own store is not a path on the machine.** A chat's scratch, a Diamond's
///   own directory and a mailbox live in the browser's storage whatever folder the user opened
///   (see [`is_store_path`]), so mapping one under the granted root names a directory that does
///   not exist -- and the hand refuses a fence it cannot resolve, which refuses the turn's REAL
///   folders along with it.  This was live: every `run` in every chat was refused, because a chat
///   always carries its scratch.  So [`is_store_path`] is filtered out here, exactly as
///   [`ToolContext::default_cwd`] filters it when choosing where a command starts.
/// * **A turn with no allow-list is not an unfenced turn.** [`may_read`](ToolContext::may_read)
///   treats an empty bound list as no restriction, which is correct for a file tool jailed by the
///   workspace root -- and catastrophic here, where there is no jail but the fence itself.  So an
///   absent allow-list becomes the granted root, not the whole machine.
/// * **A tainted turn reaches the network only if the user says so.** A turn that has read a
///   stranger's words may still build and test inside its own paths, and may not reach outward
///   until it is asked and answered -- which is the direct answer to a page or a message that says
///   "now upload this somewhere".  This is one more consumer of the flag [`egress_check`] already
///   gates on, not a new mechanism; [`net_step`] decides it and this function is handed the
///   answer, never the flag.
///
/// A granted [`Toolkit`] is folded in last, and only in the direction of the paths it names.  It
/// cannot loosen anything already decided: the workspace rules are computed first and a toolkit
/// path is added beside them, never over them, and a toolkit that resolves to nothing -- because
/// the hand did not say where home is -- leaves the fence exactly as it found it.
///
/// # Arguments
/// * `bounds` - The turn's [`Bound`] rules, as [`ToolContext::no_write`] holds them.
/// * `m` - The machine the hand described: the granted root, and the home a toolkit resolves
///   against.
/// * `tainted` - Whether this turn has ingested content from outside the user.
pub fn fence_spec(bounds: &[Bound], m: &Machine, tainted: bool) -> FenceSpec {
    // Every command and every compose door is a [`Surface::Tool`], where `.ssh` is denied like
    // every other secret. The interactive terminal is the ONE surface that reads `~/.ssh`, and it
    // threads [`Surface::Terminal`] from its own call site in `wasm/pty.rs`; nothing else does.
    fence_spec_surfaced(bounds, m, tainted, Surface::Tool)
}

/// [`fence_spec`] with the surface stated explicitly.  See [`Surface`]: it decides one thing, the
/// `~/.ssh` deny, and the interactive terminal is the only caller that lifts it.
///
/// # Arguments
/// * `surface` - A code-path constant, never derived from request data. Only `wasm/pty.rs` passes
///   [`Surface::Terminal`]; every other caller reaches this through [`fence_spec`] as
///   [`Surface::Tool`].
pub fn fence_spec_surfaced(
    bounds:  &[Bound],
    m:       &Machine,
    tainted: bool,
    surface: Surface,
) -> FenceSpec {
    // A scope that could not be expressed. No roots at all, which the hand refuses -- the same
    // closed failure an unusable root produces, and for the same reason. Read before the root is
    // even looked at, because nothing a machine could say would widen this.
    if bounds.iter().any(|b| matches!(b, Bound::Nowhere)) {
        return FenceSpec { rw: Vec::new(), ro: Vec::new(), deny: Vec::new(), net: false };
    }
    // An unusable root fences nothing, and the empty string fences LESS than nothing: the hand
    // compares with `Path::starts_with`, for which every path on the machine is under "". So a
    // root that is not an absolute path yields a spec with no roots at all, which the hand refuses
    // -- the failure is closed, loud, and cannot be mistaken for a fence. A toolkit does not rescue
    // it either: the return is here, above the fold, so a machine with no usable root grants a
    // toolchain no more than it grants anything else.
    let root = m.root.as_str();
    if root.is_empty() || !root.starts_with('/') {
        return FenceSpec { rw: Vec::new(), ro: Vec::new(), deny: Vec::new(), net: false };
    }
    let abs = |rel: &str| -> String {
        let p = normalise(rel);
        if p.is_empty() { root.to_string() } else { fmt!("{}/{}", root.trim_end_matches('/'), p) }
    };
    let mut rw:   Vec<String> = Vec::new();
    let mut ro:   Vec<String> = Vec::new();
    let mut deny: Vec<String> = Vec::new();
    // The allow-list, gathered first, because every other rule is read against it. Its PRESENCE is
    // what decides whether this turn is scoped at all -- not whether any path happened to land in
    // `rw` or `ro`, which is a different question and was once confused with it.
    //
    // And not whether any path survived normalisation either, which is the same confusion one step
    // further on: a prefix that normalises away is dropped, because `abs("")` is the granted root
    // and keeping it would restate the whole grant as the Diamond's own folder. Dropping it must
    // NOT then make the turn unscoped -- that hands back the same root through the `!scoped`
    // fallback below -- so `scoped` reads the rules that were DECLARED and `allow` the places they
    // named, and a turn that declared a scope naming nowhere gets a spec with no roots.
    //
    // A path in the STORE is dropped for the same reason and a stronger one: it is not a place on
    // this machine at all. `chats/<id>/work`, `diamonds/<id>` and `mail/<address>` resolve to the
    // browser's own storage whatever folder is open (see `is_store_path` and
    // `crate::wasm::opfs::resolve_root`), so `abs` would invent `<granted-root>/chats/<id>/work` --
    // a directory nobody made, on a disk the scratch was designed never to touch. The hand then
    // refuses the WHOLE fence, and is right to: "the fence was told to grant rw access to ...,
    // which cannot be resolved. Granting nothing there would leave the command failing for a
    // reason nobody could see." So every `run` in every chat was refused, including the ones whose
    // user HAD marked a real folder in -- a chat always carries its scratch, and one unresolvable
    // grant takes the whole fence down with it. `default_cwd` has skipped these paths since
    // `hand/REVIEW.md` §1.18; this is the other half of that fix, which said where a command
    // starts and left what it may touch alone.
    // ── BOTH allow-lists, read as one ───────────────────────────────────────
    //
    // `Bound::OnlyWriteUnder` -- the rule every scope in this build is made of -- leaves READING
    // free at the file tools, and this is the one place that deliberately does not follow it.  A
    // command's fence names the marked places for reading as well as for writing, exactly as it
    // would for a `Bound::OnlyUnder`, so nothing about the verb split reaches the machine.
    //
    // **THE RULE IS NOT "READING IS FREE" FLAT. It is: reading is free where Daimond can see what
    // is read.**  A file tool names one path and hands back its text, and every other rule in this
    // app still applies around it -- the taint, the egress check, the untrusted envelope.  A
    // command is opaque: nobody can look at an `argv` and say what it will do, which is the same
    // sentence that makes it a write.
    //
    // Follow the tidy version one step further and it is stark. A command that could read the whole
    // grant AND write into its own folder is **an exfiltration path with two legs**: read anything
    // on the machine, copy it into the marked folder, and the daimon reads the marked folder and
    // has the network.  Neither leg looks like anything on its own.  So the mark is the whole of a
    // command's reach, both verbs, and `dev/verify_scope.mjs` proves through the KERNEL that a
    // command working for one Diamond cannot read the folder attached to another -- with a file
    // tool reading that same folder freely in the check beside it, so the refusal is "no access to
    // THAT" and not "no access at all".
    //
    // A future reader will notice the inconsistency between this and `may_read`, think it an
    // oversight, and split the verbs here to be tidy.  It is not an oversight.  The unit test
    // `test_the_bytes_a_scoped_diamond_hands_the_fence_00` pins this spec byte for byte, and putting
    // the granted root into `ro` turns it and the kernel checks red together.
    //
    // Read as one list rather than as two branches, because two branches is how the store-path
    // filter and the toolkit resolution below came to exist on only one of them.
    let scoped = bounds.iter()
        .any(|b| matches!(b, Bound::OnlyUnder(_) | Bound::OnlyWriteUnder(_)));
    let allow: Vec<String> = bounds.iter()
        .filter_map(|b| match b {
            Bound::OnlyUnder(p) | Bound::OnlyWriteUnder(p) => Some(normalise(p)),
            _ => None,
        })
        .filter(|p| !p.is_empty())
        .filter(|p| !is_store_path(p))
        // A mark under Daimond's own directory can never be granted -- `diamond_bounds` denies
        // `DAIMOND_DIR` outright, so surfacing it here is a self-contradiction the hand cannot
        // absorb: when the named file does not exist, `canonical()` cannot resolve it and refuses
        // the WHOLE fence, taking every real folder's grant down with it. Reading a skill file
        // under `.daimond/` already needs no mark (`is_skills_disclosure`), so nothing legitimate
        // is lost by dropping it here.  By the one deny predicate, not by spelling (QRFIX2 F1): on a
        // folding disk `.DAIMOND/x` is the same place, and dropping a mark only ever refuses more.
        .filter(|p| !in_daimond_dir(p))
        .collect();
    // A NoWrite prefix takes writing away. It may sit ABOVE an allowed path or BELOW it, and both
    // directions matter: above, the whole grant becomes read-only; below, the grant stays writable
    // and the nested prefix is re-stated as a read-only root the hand carves out of it.
    let no_write: Vec<String> = bounds.iter()
        .filter_map(|b| match b { Bound::NoWrite(p) => Some(normalise(p)), _ => None })
        .collect();
    for p in &allow {
        if no_write.iter().any(|w| under(p, w)) { ro.push(abs(p)); } else { rw.push(abs(p)); }
    }
    for w in &no_write {
        // Nested inside a grant, and not Daimond's own directory (which is denied outright below).
        // A store path cannot arrive here at all: it is not in `allow`, and no allowed prefix
        // encloses one -- `chats`, `diamonds` and `mail` are whole first segments, and the only
        // prefix above them is the empty one, which is dropped.
        //
        // An UNSCOPED turn's grant is the root itself, so every read-only mark is nested in it.
        // The Terminal is the case that needs it: `terminal_bounds` takes the allow-list away and
        // keeps each `NoWrite`, and until 11 Oct 2026 this loop then dropped them, so a folder the
        // user marked read-only was writable from the Terminal, against 9348afc4's own account.
        let nested = if scoped {
            allow.iter().any(|a| under(w, a)) && !allow.contains(w)
        } else {
            !w.is_empty() && !is_store_path(w)
        };
        if !in_daimond_dir(w) && nested {
            let a = abs(w);
            if !ro.contains(&a) { ro.push(a); }
        }
    }
    for b in bounds {
        match b {
            // A read carve-out is a read grant and never a write one -- and it is NOT a way out of
            // an allow-list. `may_read` tests the allow-list before the carve-out, so a skill
            // running inside a Diamond cannot read past the Diamond by declaring a folder; the
            // fence has to make the same ordering, or the two disagree and the fence is the laxer.
            Bound::MayRead(p) => {
                let n = normalise(p);
                // A carve-out that names nowhere carves nothing. Unguarded it read as the granted
                // root, which is not a hole in the fence but the removal of it.
                //
                // Nor does one naming the store: it is browser storage and not a directory on this
                // machine, so granting it is the unresolvable grant the allow-list above drops --
                // and it would arrive here even on a turn with no allow-list at all.
                if n.is_empty() || is_store_path(&n) {
                    continue;
                }
                if !scoped || allow.iter().any(|a| under(&n, a)) {
                    let a = abs(&n);
                    if !ro.contains(&a) { ro.push(a); }
                }
            },
            Bound::NoRead(p) => deny.push(abs(p)),
            // A toolkit names paths on the machine, not in the workspace, so `abs` would be wrong
            // for it and it is resolved below against the home the hand reported instead.
            // `Nowhere` returned above, before any of this was computed. Both allow-lists were read
            // into `allow` above, together, so neither is read again here.
            // `NoSecretNames` judges by name, which Landlock cannot; the runner walks for those.
            Bound::OnlyUnder(_) | Bound::OnlyWriteUnder(_) | Bound::NoWrite(_)
                | Bound::Toolkit(_) | Bound::Nowhere | Bound::NoSecretNames => {},
        }
    }
    // NO allow-list means the turn is bounded only by the workspace, so the fence is the granted
    // root -- never the machine. The test is whether one was DECLARED: a turn carrying only a
    // skill's read carve-out has no allow-list, and must still be able to write its workspace.
    if !scoped {
        rw.push(root.to_string());
    }
    // Daimond's own directory is out of bounds whatever else was said. `diamond_bounds` already
    // adds it, and an ordinary turn does not, so it is asserted here rather than assumed.
    let own = abs(DAIMOND_DIR);
    if !deny.contains(&own) {
        deny.push(own);
    }
    // The user's own secrets, denied on every fence and not only on one that happened to grant a
    // toolkit. See [`ALWAYS_DENIED`]: until 2026-08-26 these were out of reach because the
    // workspace root was narrower than the home directory, which is a property of a setting the
    // user picked arbitrarily rather than a rule anything enforced.
    if let Some(h) = &m.home {
        if abs_dir(h) {
            let home = h.trim_end_matches('/');
            for g in ALWAYS_DENIED {
                // The interactive terminal is the user at a keyboard, and `ssh` from it reads the
                // user's OWN `~/.ssh` exactly as they would at any shell. No `Tool` opens or types
                // into a terminal (see `wasm/pty.rs`), so lifting `.ssh` here reaches no daimon --
                // and it lifts `.ssh` ALONE: every other secret stays denied on the terminal too.
                if surface == Surface::Terminal && g.tail == ".ssh" { continue; }
                if let Some(p) = home_path(home, g.tail) {
                    if !deny.contains(&p) { deny.push(p); }
                }
            }
        }
    }
    // The toolchain the user granted, if any, and nothing else: `Kit::resolve` reads the grant out
    // of these same bounds, so there is no second path by which a toolkit could arrive -- and in
    // particular none that starts with what the model asked to run.
    if let Some(kit) = Kit::resolve(bounds, m) {
        for p in kit.ro   { if !ro.contains(&p)   { ro.push(p);   } }
        for p in kit.rw   { if !rw.contains(&p)   { rw.push(p);   } }
        for p in kit.deny { if !deny.contains(&p) { deny.push(p); } }
    }
    FenceSpec { rw, ro, deny, net: !tainted }
}

/// Whether a hand's `caps` list says it can actually contain a command.
///
/// Release gate 1: a command that cannot be fenced is REFUSED, never run unfenced and mentioned
/// afterwards.  The hand's own vocabulary is a list rather than a version number precisely so this
/// question can be asked of a particular machine, and it always answers with one of `fence:linux`
/// or `fence:none`.
///
/// The test is AFFIRMATIVE, and that is the whole of it: silence is not a fence.  A hand that says
/// nothing about what it can enforce -- an older build, a different implementation, a mock -- has
/// not said that it can enforce anything, so the answer is no and the refusal is the safe way to
/// be wrong.
///
/// # Arguments
/// * `caps` - What the hand reported in its `hello`.
pub fn fence_enforced(caps: &[String]) -> bool {
    caps.iter().any(|c| c.starts_with("fence:") && c != "fence:none")
        && !caps.iter().any(|c| c == "fence:none")
}

pub const CAP_METER_DELETES: &str = "meter:deletes"; // said by `hand/src/main.rs`
pub const CAP_RUN_ROOT_START: &str = "run:root-start"; // said by `hand/src/main.rs`
pub const CAP_RELAY_ROOT_START: &str = "relay:root-start"; // added by `ext/hand.js` to the hello
pub const CAP_WRITE_IF: &str = "file:write-if"; // said by `hand/src/main.rs` (`wire::CAP_WRITE_IF`)

/// The words a hand's refusal of a conditional write opens its reason with, followed by what
/// stands there now as `now sha256 <hex>` or `now absent` (`wire::WRITE_CHANGED` in the hand).
pub const HAND_WRITE_CHANGED: &str = "changed since it was read";

/// Does this hand compare what stands at a path with what the page expects, and write only over
/// that, in one op?  Affirmative, like [`deletes_metered`]: a hand older than 2026-10-12 ignores a
/// write's `expect` and writes whatever stands there, so it is refused any change at the link
/// ([`change_refusal`]).
pub fn writes_if(caps: &[String]) -> bool {
    caps.iter().any(|c| c == CAP_WRITE_IF)
}

/// What a hand that refused a conditional write found there, read from its sentence: `None` where
/// the sentence is not that refusal.
pub fn hand_found(said: &str) -> Option<crate::diamond_versions::Seen> {
    let at = match said.find(HAND_WRITE_CHANGED) {
        Some(i) => i + HAND_WRITE_CHANGED.len(),
        None    => return None,
    };
    let rest = &said[at..];
    if let Some(i) = rest.find("now sha256 ") {
        let h: String = rest[i + "now sha256 ".len()..].chars().take(64).collect();
        if crate::diamond_versions::is_hash(&h) {
            return Some(crate::diamond_versions::Seen::Bytes(h));
        }
    }
    if rest.contains("now absent") {
        return Some(crate::diamond_versions::Seen::Absent);
    }
    // The refusal, with no reading of what is there: the next question binds to nothing it
    // could compare, so it is asked again rather than written past.
    Some(crate::diamond_versions::Seen::Unread)
}

/// May a command start at the workspace root above its fence? See [`ToolContext::run_cwd`].
///
/// Both ends vet the cwd, so both must say so: a newer hand behind an extension the browser
/// has not reloaded would otherwise have every command refused by the relay.
pub fn root_start(caps: &[String]) -> bool {
    caps.iter().any(|c| c == CAP_RUN_ROOT_START)
        && caps.iter().any(|c| c == CAP_RELAY_ROOT_START)
}

/// Does this hand meter what a command removes?
///
/// Affirmative, like [`fence_enforced`]: a hand that does not say it meters has not said it does.
/// Every hand built before 2026-09-23 says nothing, and runs a daimon's `rm -rf` to its end.
pub fn deletes_metered(caps: &[String]) -> bool {
    caps.iter().any(|c| c == CAP_METER_DELETES)
}

/// The fence a command runs inside: [`fence_spec`], with nothing writable where the hand does not
/// meter removals.
///
/// **A new page on an old hand is the window this closes** (audit F2, 2026-09-23).  The page
/// deploys everywhere at once and each machine's hand is rebuilt by hand, so a page that sends a
/// meter field to a hand older than the meter is the ordinary state of a fleet mid-update -- and
/// that hand ignores the field and runs `rm -rf` to the end, which is how a Diamond was emptied on
/// 2026-09-22.  Refusing only the deletion-class commands would need `argv` read for intent, which
/// is guessing; making only the marks read-only would leave the granted root writable, and on the
/// owner's own machine that root is the whole of a synced folder.  So every `rw` root moves to
/// `ro` -- marks, the unscoped granted root and toolchain caches alike.
///
/// The old hand honours `ro` through Landlock (no write, create, remove or rename) and accepts a
/// working directory under one, so a command still runs, reads and reports; it changes nothing.
/// The one writable place left is the per-run scratch the hand adds for itself and removes when
/// the run ends.
///
/// Read by every door a turn has to the machine -- `Tool::run_exec`, the file tools' `reach_of`,
/// and the named verifier's question about what the turn works on -- and by
/// [`crate::prompts::machine_note`], so the briefing and the fence cannot disagree.  The file door
/// kept [`fence_spec`] until the re-check of 2026-09-23 (H1), on the reasoning that a file tool
/// changes one named file under the page's own copy: an old hand then took a daimon's writes one
/// file at a time, which is not "no writes without the meter".  Only the terminal keeps
/// [`fence_spec`], because a terminal is the user at a keyboard.
pub fn command_fence(bounds: &[Bound], m: &Machine, tainted: bool) -> FenceSpec {
    let spec = fence_spec(bounds, m, tainted);
    if deletes_metered(&m.caps) { spec } else { spec.read_only() }
}

/// The refusal a file tool's change on this computer meets where the hand is older than the
/// deletion meter: [`command_fence`] gives such a hand nothing writable, by any door.
///
/// # Arguments
/// * `raw` - The path as the model wrote it.
/// * `host` - This computer's name, where the hand said it.
pub(super) fn meterless_change_refusal(raw: &str, host: Option<&str>) -> String {
    let at = match host.map(str::trim).filter(|h| !h.is_empty()) {
        Some(h) => fmt!("on {}", h),
        None    => fmt!("on this computer"),
    };
    fmt!("Refused: the machine hand {} is older than the deletion meter, so until the user \
        updates it nothing there is written, created, removed or renamed through it -- by a file \
        tool or by a command -- and '{}' was left as it is. Reading it still works. Do not look for \
        another way to change it: Daimond has already told the user how to update the hand, so \
        tell them which file you meant to change and why.", at, raw)
}

/// Why a file tool's change on this computer is refused at the link, for what the hand said it
/// is in its hello: `None` where the hand may be sent a change.
///
/// # Arguments
/// * `caps` - What the hand said it can do.
/// * `raw` - The path as the model wrote it.
/// * `host` - This computer's name, where the hand said it.
pub(super) fn change_refusal(caps: &[String], raw: &str, host: Option<&str>) -> Option<String> {
    if !deletes_metered(caps) {
        return Some(meterless_change_refusal(raw, host));
    }
    if !writes_if(caps) {
        return Some(writeless_change_refusal(raw, host));
    }
    None
}

/// The refusal a file tool's change on this computer meets where the hand is older than the write
/// that compares before it writes ([`CAP_WRITE_IF`]): every write that follows a read is bound to
/// that read, and such a hand would write over a save made since (U3a RMW2, 2026-10-17).
///
/// # Arguments
/// * `raw` - The path as the model wrote it.
/// * `host` - This computer's name, where the hand said it.
pub(super) fn writeless_change_refusal(raw: &str, host: Option<&str>) -> String {
    let at = match host.map(str::trim).filter(|h| !h.is_empty()) {
        Some(h) => fmt!("on {}", h),
        None    => fmt!("on this computer"),
    };
    fmt!("Refused: the machine hand {} is older than the write that checks a file is unchanged \
        as it writes, so until the user updates it nothing there is written, created, removed or \
        renamed through it by a file tool, and '{}' was left as it is. Reading it still works. Do \
        not look for another way to change it: tell the user the machine hand needs to be updated, \
        and which file you meant to change and why.", at, raw)
}

/// Is this a name a verifier or a break may be looked up by?
///
/// The same alphabet the hand applies and the extension applies: lower case, digits and
/// underscore.  Repeated here rather than shared because the three ends have no shared code, and
/// the point of the narrowness is what it leaves OUT -- no dot, so `..` cannot be spelled; no
/// slash; no dash, so nothing can begin with one and be read as an option.  A name that gets past
/// all three still names nothing unless the file is really there.
///
/// # Arguments
/// * `name` - The name, as the model wrote it.
pub fn verify_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}


/// The word every refusal this layer writes opens with.
///
/// Written down once because [`call_outcome`] reads it back: a refusal is recognised by the fact
/// that [`refusal_line`] composed it, and a spelling kept in two places is a spelling that will
/// eventually be two spellings.
pub const REFUSAL_OPENING: &str = "Refused";

/// The word every tool failure opens with, composed by [`error_line`] and read back by
/// [`call_outcome`].
pub const ERROR_OPENING: &str = "Error";

/// A refusal as the model should read it, prefixed once.
///
/// The hand writes its own refusals as whole sentences and most already open with
/// "Refused:".  Prefixing unconditionally produced "Refused: Refused: …", which reads as a
/// stutter and, worse, as two different refusals stacked -- inviting the model to explain
/// one thing twice.
///
/// **Every refusal returned as a tool RESULT opens with this word**, and composing it here is how
/// that stays true whatever wrote the sentence: the opening is what [`call_outcome`] reads, so a
/// refusal that neither opens with it nor is passed through here is a call the fold's ledger will
/// book as work that was done.
///
/// # Arguments
/// * `reason` - The sentence the hand sent.
pub fn refusal_line(reason: &str) -> String {
    if reason.trim_start().starts_with(REFUSAL_OPENING) {
        reason.to_string()
    } else {
        fmt!("{}: {}", REFUSAL_OPENING, reason)
    }
}

/// A tool failure as the model should read it.
///
/// The counterpart of [`refusal_line`], and it exists for the same reason: the opening word is
/// what [`call_outcome`] reads, so it is composed in one place rather than written out at each
/// arm of [`ToolRegistry::dispatch`].
///
/// **THE REASON MUST COME FROM `Error::plain()` AND NEVER FROM `Display`.** An `fe2o3` error
/// displays for a developer at a terminal: ANSI colour, the `UpstreamErr{…}` / `LocalErr{…}`
/// frames, and a `file:line` of ours at every level. A model was reading all of it. What
/// actually reached one on 2026-08-24, when a daimon read a directory as a file:
///
/// ```text
/// Error: \u{1b}[91m\u{1b}[1mUpstreamErr{\u{1b}[0m … "src/tools.rs:8733: file_read: …
/// ```
///
/// The sentence after that colon had been written and reworded FOR A MODEL that same evening,
/// and it was delivered inside an envelope addressed to somebody else. `plain()` gathers the
/// messages, drops the locations and carries no colour -- it is in `fe2o3_core` and has been all
/// along, which makes this one more of the shape where the right thing existed and the caller
/// reached past it.
///
/// # Arguments
/// * `reason` - What went wrong, as a whole sentence, from `Error::plain()` where it came from an
///   error at all.
pub fn error_line(reason: &str) -> String {
    fmt!("{}: {}", ERROR_OPENING, reason)
}


// ┌───────────────────────────────────────────────────────────────┐
// │ The road, which is not a result                                │
// └───────────────────────────────────────────────────────────────┘

// A LOCAL FAILURE IS NOT INFORMATION THE MODEL SHOULD REASON ABOUT.
//
// Every function above turns something into a sentence for a model to read, and that is right
// for everything a tool can be told by the world: a 404, a refusal, a host that would not answer.
// It is wrong for one thing.  "Your user's phone went to sleep and the request never left the
// device" is not a fact about the world; it is an infrastructure event, and a model handed it as
// a tool result does the reasonable thing with a failed tool -- it apologises and answers around
// it.  On a real iPhone, on 2026-08-28, that came back as "I can't get through to the web right
// now to look this up", and the sentence is now a permanent assistant turn in the conversation,
// re-sent to the model on every turn after it and folded into the summary.  A moment of platform
// behaviour became a durable false fact in the record.
//
// So the two are told apart and treated oppositely.  A remote answer becomes a result, exactly as
// before.  A road failure never becomes one: see [`ToolRegistry::try_dispatch`].

/// The sentence a browser request that never got an answer is marked with.
///
/// **Quoted verbatim from `www/js/gateway.js`, where `roadMark` sets it**, and
/// `dev/verify_toolroad.mjs` asserts the two literals are the same string -- so a change to one
/// of them breaks a test rather than quietly stopping the classification.
///
/// It is tested for EXACTLY and never as a pattern.  `BROWSER_ROAD` in js/daimond.js holds
/// `refused`, meaning "connection refused", and the tool layer is full of sentences carrying that
/// word for an entirely different reason -- [`refusal_line`] prefixes some twenty of them.  A
/// pattern classifier over tool results would read a permission refusal as a dead road, retry it
/// eight times and then kill the turn, which is a worse fault than the one being fixed.
pub const ROAD_MARK: &str = "daimond-road: the request never left this device";

/// Did this failure happen on the road, rather than at the far end?
///
/// `plain()` and not `Display`, and `contains` and not `starts_with`: the mark is set at the
/// browser's `fetch` and the error is wrapped by `res!` several times on its way out, so by the
/// time it is asked about, the marked sentence is one frame among several in the chain.
/// `Error::plain` gathers every frame's words, which is why the mark survives at all -- it rides
/// in the MESSAGE rather than in a tag, because `Error::tags` on an `Upstream` frame reports that
/// frame's tags alone and a tag set at the bottom of the chain is invisible from the top.
///
/// The same reasoning as [`crate::llm::TransportErr::crossed`], one layer down.
pub fn road_failed(e: &Error<ErrTag>) -> bool {
    e.plain().contains(ROAD_MARK)
}


// ┌───────────────────────────────────────────────────────────────┐
// │ A person's pause, which is a refusal and not a fault           │
// └───────────────────────────────────────────────────────────────┘

/// The mark a door's refusal crosses the JavaScript edge with when a person's PAUSE holds the
/// spend it was asked for, the node it names in brackets after it: `daimond-paused[root/web]`.
///
/// **A pause is a refusal, never a fault.**  Every door that asks the pause tree -- `search.js`,
/// the gateway's 423 through `web.js`, `models.js` -- throws an `Error` carrying `paused` and
/// `pauseNode`, and the wasm edge read only its `message`: the registry dressed it as a failure,
/// and the page had nothing but the translated sentence to learn which control held it (QA-1).
/// The edge now writes this mark ([`paused_mark`]), the registry turns it into [`paused_line`],
/// and the tool-result event carries the node ([`paused_node`]).  It rides in the MESSAGE for
/// the reason [`ROAD_MARK`] does, and no model ever reads the mark itself.
pub const PAUSE_MARK: &str = "daimond-paused";

/// How a pause's refusal opens as a tool result: a refusal, and the node that holds it.
pub(super) const PAUSED_AT: &str = "Refused (paused at ";

/// The message a door's pause refusal crosses the edge as: the mark, the node, the sentence.
pub fn paused_mark(node: &str, said: &str) -> String {
    fmt!("{}[{}] {}", PAUSE_MARK, node, said)
}

/// The node and the sentence of a refusal a pause made, where `e` carries one ([`paused_mark`]).
pub fn paused_refusal(e: &Error<ErrTag>) -> Option<(String, String)> {
    let plain = e.plain();
    let from = match plain.find(PAUSE_MARK) {
        Some(at) => at + PAUSE_MARK.len(),
        None     => return None,
    };
    let rest = match plain[from..].strip_prefix('[') {
        Some(r) => r,
        None    => return None,
    };
    match rest.split_once(']') {
        Some((node, said)) if !node.trim().is_empty() =>
            Some((node.trim().to_string(), said.trim().to_string())),
        _ => None,
    }
}

/// A pause's refusal as the model reads it.  It opens as a refusal, so [`call_outcome`] books it
/// as one, and it names the node, so [`paused_node`] can hand the page the control to point at.
pub fn paused_line(node: &str, said: &str) -> String {
    fmt!("{}{}): {}", PAUSED_AT, node, said)
}

/// The pause node a tool result names, where [`paused_line`] composed it.
pub fn paused_node(reply: &str) -> Option<String> {
    let rest = match reply.trim_start().strip_prefix(PAUSED_AT) {
        Some(r) => r,
        None    => return None,
    };
    match rest.split_once("): ") {
        Some((node, _)) if !node.is_empty() => Some(node.to_string()),
        _                                   => None,
    }
}

/// What became of one tool call.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CallOutcome {
    /// The tool ran and did what it was asked.
    Done,
    /// A door refused the call.  Nothing was read, written, run or fetched.
    Refused,
    /// The tool tried and failed.  Nothing was completed.
    Failed,
}

impl CallOutcome {

    /// The word this outcome travels as, on the wire and in a stored tool log.
    ///
    /// Spelled here and nowhere else because the browser recognises these three words and no
    /// others: an encoder that invented a fourth spelling would not fail, it would quietly hand
    /// every consumer a refusal they read as work that was done -- which is the defect this field
    /// exists to close.
    pub fn wire(&self) -> &'static str {
        match self {
            Self::Done      => "done",
            Self::Refused   => "refused",
            Self::Failed    => "failed",
        }
    }
}

/// What a tool reply says about whether its call actually did anything.
///
/// **The tool layer states this and its readers ask, rather than each reader guessing.**  The
/// fold's ledger guessed, with `!reply.starts_with("Error")`, and every refusal in this build is
/// returned as an `Ok` sentence opening "Refused" -- so a write the scope fence had just stopped
/// was recorded as a write, and the note the fold handed the model listed files that were never
/// created, under a closing line telling it to trust that list.
///
/// The repair is not a longer list of openings kept in the fold: it is that the classification
/// lives HERE, beside [`refusal_line`] and [`error_line`], which compose the only two openings
/// there are.  A refusal reworded in this file cannot then change what another file concludes
/// about it, because the wording is not what is read -- the constructor's own opening is.
///
/// Anything else is [`CallOutcome::Done`], which is both the old reading of a successful reply and
/// the only one available: a tool's success wording is its own, and demanding a positive marker
/// would book every genuine write as nothing.
///
/// # Arguments
/// * `reply` - The tool result as it went into the conversation.
pub fn call_outcome(reply: &str) -> CallOutcome {
    let head = reply.trim_start();
    if head.starts_with(REFUSAL_OPENING) {
        CallOutcome::Refused
    } else if head.starts_with(ERROR_OPENING) {
        CallOutcome::Failed
    } else {
        CallOutcome::Done
    }
}

/// The `DOMException.name` a browser throws when a file-system grant has been withdrawn.
pub const WITHDRAWN_GRANT: &str = "NotAllowedError";

/// Does this thrown exception's NAME say a file-system grant was withdrawn?
///
/// The name is compared WHOLE.  A substring test over the same word is what turned a search
/// result into a revoked grant on 2026-09-13, and `NotAllowedError` appears in this codebase's own
/// prose often enough that a loose test will meet it again.
pub fn is_withdrawn_grant(name: &str) -> bool {
    name == WITHDRAWN_GRANT
}

/// Whether a tool call's OWN failure says the browser took the open folder away.
///
/// **Two terms, and the first is the one the defect turned on.**  A call that SUCCEEDED says
/// nothing about the grant however its result reads: on 2026-09-13 a `file_search` for
/// `on the user's screen|ask_result|drawn` matched the sentence in `src/wasm/opfs.rs` that names
/// `NotAllowedError`, the alarm fired on a result rather than on a failure, the page dropped to the
/// sandbox, and every later read of the user's folder was refused against a grant the browser had
/// never touched.  So the outcome is asked first, and a `Done` is never a loss.
///
/// The second term is the exception the file edge caught
/// ([`crate::wasm::opfs::take_thrown`]), not the words the tool returned.  A failed `file_edit`
/// whose `old_string` quoted that sentence would fail for its own reasons and say that word in its
/// error; only something thrown is evidence about the grant.
///
/// # Arguments
/// * `outcome` - What became of the call, read from the reply by [`call_outcome`].
/// * `thrown` - The name of the exception the file edge caught, empty when nothing threw.
pub fn folder_loss_reported(outcome: CallOutcome, thrown: &str) -> bool {
    outcome != CallOutcome::Done && is_withdrawn_grant(thrown)
}

/// What a call says about one path, once it has returned.
///
/// **Read off the ARGUMENTS, never off the reply.**  A reply is a sentence the tool composed, and
/// four consumers once tried to read facts back out of such sentences -- which is the defect
/// [`call_outcome`] exists to close.  The arguments are the model's own statement of which file it
/// meant, they are the same whatever the wording, and they are what an audit can check.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PathClaim {
    Left,       // on the store when the call returned
    Removed,    // gone from the store when the call returned
}

/// A list of strings as a JSON array.
pub(super) fn json_list(v: &[String]) -> String {
    let items: Vec<String> = v.iter().map(|s| fmt!("\"{}\"", json_escape(s))).collect();
    fmt!("[{}]", items.join(","))
}

/// What a command may touch, as the machine hand's wire spells it.
///
/// A mirror of the hand's own `wire::FenceSpec`, kept here rather than shared through a common
/// crate because the two ends are deployed separately: the page is sealed into the transparency
/// log and the hand is installed by the user, so they will sometimes be different versions and the
/// protocol -- not a shared type -- is what has to hold them together.
#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct FenceSpec {
    /// Absolute roots the command may read and write.
    pub rw:   Vec<String>,
    /// Absolute roots the command may read and not write.
    pub ro:   Vec<String>,
    /// Absolute subtrees denied outright, even inside `rw` or `ro`.
    pub deny: Vec<String>,
    /// Whether the command may reach the network at all.
    pub net:  bool,
}

impl FenceSpec {

    /// This fence as the JSON the hand reads.
    pub fn to_json(&self) -> String {
        fmt!(
            r#"{{"rw":{},"ro":{},"deny":{},"net":{}}}"#,
            json_list(&self.rw), json_list(&self.ro), json_list(&self.deny), self.net,
        )
    }

    /// The same places, none of them writable.  See [`command_fence`].
    pub fn read_only(self) -> Self {
        let mut ro = self.rw;
        for p in self.ro {
            if !ro.contains(&p) { ro.push(p); }
        }
        Self { rw: Vec::new(), ro, deny: self.deny, net: self.net }
    }
}

/// The hand's own bounds on a `made` (`kimberlite/src/wire.rs`), which refuses the whole request on
/// any one of them: so [`made_json`] keeps inside every one rather than sending what it refuses.
pub(super) const MADE_KEEPER_MAX: usize = 256;
pub(super) const MADE_ROOTS_MAX:  usize = 64;
pub(super) const MADE_FILES_MAX:  usize = 4096;
pub(super) const MADE_PATH_MAX:   usize = 4096;

/// The `made` an exec request carries (MADE-1): which files under the command's writable roots
/// the Diamond made, with the sha256 of the bytes it left, so the hand's write meter lets a
/// command change or remove them and no other file that was there before the turn
/// (write_meter_plan.md invariants 1 and 9).
///
/// `files` comes from the Diamond's own record and nothing else
/// ([`crate::diamond_versions::made_by_diamond`], at most `MADE_SENT_MAX`), so no argument a
/// model chose can add a file.  Each file goes under the closest root holding it, as the hand
/// judges it; a file under no root, or whose path the hand would refuse, is left out, which makes
/// it the user's.  `null`, which the hand reads as nothing being the Diamond's, where `keeper` is
/// not one the hand accepts.  The tab's hand and the runner both send what this builds.
///
/// # Arguments
/// * `keeper` - The Diamond whose record this is.
/// * `rw` - The fence's writable roots, absolute.
/// * `files` - `(absolute path, sha256)` of what the Diamond's file tools last wrote.
pub fn made_json(keeper: &str, rw: &[String], files: &[(String, String)]) -> String {
    if keeper.is_empty() || keeper.len() > MADE_KEEPER_MAX {
        return "null".to_string();
    }
    let mut roots: Vec<(&str, Vec<String>)> = Vec::new();
    for r in rw.iter() {
        let r = r.trim_end_matches('/');
        if !r.starts_with('/') || r.contains('\0') || r.split('/').any(|p| p == "..")
            || roots.iter().any(|(k, _)| *k == r)
        {
            continue;
        }
        if roots.len() == MADE_ROOTS_MAX {
            break;
        }
        roots.push((r, Vec::new()));
    }
    for (path, sha) in files.iter() {
        let at = roots.iter_mut()
            .filter_map(|(root, list)| path.strip_prefix(*root)
                .and_then(|rest| rest.strip_prefix('/'))
                .map(|rel| (root.len(), rel, list)))
            .max_by_key(|(n, _, _)| *n);
        let (rel, list) = match at {
            Some((_, rel, list)) => (rel, list),
            None                 => continue,
        };
        let plain = !rel.is_empty() && rel.len() <= MADE_PATH_MAX && !rel.contains('\0')
            && !rel.contains('\\') && rel.split('/').all(|p| !p.is_empty() && p != "." && p != "..");
        let hex = sha.len() == 64
            && sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if plain && hex && list.len() < MADE_FILES_MAX {
            list.push(fmt!(r#"{{"path":"{}","sha256":"{}"}}"#, json_escape(rel), sha));
        }
    }
    let roots: Vec<String> = roots.iter()
        .map(|(root, list)| fmt!(r#"{{"root":"{}","files":[{}],"capped":false}}"#,
            json_escape(root), list.join(",")))
        .collect();
    fmt!(r#"{{"keeper":"{}","roots":[{}]}}"#, json_escape(keeper), roots.join(","))
}

/// Whether the normalised `path` sits at or beneath `prefix`, comparing whole path segments so
/// `.daimonds-notes/x.md` is not "inside" `.daimond` merely by spelling it.
pub(super) fn under(path: &str, prefix: &str) -> bool {
    let pre = normalise(prefix);
    if pre.is_empty() {
        return true; // an empty prefix is the whole workspace
    }
    path == pre || path.starts_with(&fmt!("{}/", pre))
}

/// Whether `path` falls under the DENY rule `prefix`: [`under`] by spelling, or folded (see
/// [`fold`]), so a disk that folds case or Unicode cannot be told one spelling and read, list,
/// search, walk or write another.  **The one predicate every deny and every store-name test
/// asks** -- the read deny, the write deny, Daimond's own directory and the marks beneath a move --
/// so no door can compare a deny by spelling where another compares it folded (release QA qr1 F1:
/// `file_read .DAIMOND/config.jdat` passed the read fence on a case-folding disk).  Never for an
/// allow: folded, an allow grants a folder the user never marked.
pub(super) fn denied_under(path: &str, prefix: &str) -> bool {
    under(path, prefix) || under(&fold(path), &fold(prefix))
}

// ── Secret names (F3-4 SECRET-NOW) ────────────────────────────────
//
// Judged by name and not by a walk of the disk, so a secret made after the bounds were drawn is
// refused to the file tools at once.  Kimberlite's walk reuses the same lists for its commands,
// whose kernel fence can only name what exists.

/// Secret stores known by name (FENCE-2a, QA-S1 H-C).  [`secret_name`] adds `.env.*`, `id_*` and
/// [`SECRET_SUFFIXES`].
pub const SECRET_NAMES: &[&str] = &[
    ".ore",                                 // an Ore store and its plaintext signing key
    ".env",                                 // a project's keys, by convention
    ".ssh", ".gnupg", ".aws", ".netrc", ".git-credentials",
    "key4.db",                              // a Firefox or Thunderbird profile's key store
    "logins.json", "logins-backup.json",    // its saved logins, which `key4.db` decrypts
    "cookies.sqlite",                       // its signed-in sessions
    "encrypted-openpgp-passphrase.txt",     // Thunderbird's OpenPGP passphrase
    "privkey.pem",                          // a certificate's private key
];

/// Endings that make a name a secret store: a KeePass vault, a private key, a certificate.
pub const SECRET_SUFFIXES: &[&str] = &[".kdbx", ".key", ".pem"];

/// Folders Kimberlite's walk does not enter in `Walk` mode, for its cost: each is rebuilt by a
/// tool, and each is large.  Never part of the judgement (RULE-ONE): a command can move a folder
/// into one, so what it holds is judged by name like anything else.
pub const SECRET_PRUNE: &[&str] = &["node_modules", "target", ".git", "site-packages"];

/// Leaves spelled as a secret that stay readable: the trust store HTTPS reads in a virtual
/// environment (`site-packages/certifi/cacert.pem`).  Never below a secret-named folder.
pub const SECRET_LEAF_ALLOW: &[&str] = &["cacert.pem"];

/// The longest `id_` key name, in bytes after `id_`.  The kernel's profile cannot say "no dot"
/// over a run of any length, so it writes each length out; a longer name is secret to neither.
pub const SECRET_ID_MAX: usize = 64;

/// The AppArmor profile every fenced command stacks onto itself (F3-4b SECRET-FAST).
pub const SECRET_PROFILE: &str = "kimberlite-command";

/// Is `name` a secret store by name?  An `id_` name with no extension is an ssh key (`id_rsa`,
/// `id_work`); one with an extension is code (`id_map.rs`) or a public key (`id_ed25519.pub`).
pub fn secret_name(name: &str) -> bool {
    SECRET_NAMES.contains(&name)
        || name.starts_with(".env.")
        || SECRET_SUFFIXES.iter().any(|s| name.len() > s.len() && name.ends_with(s))
        || (name.len() > 3 && name.len() <= 3 + SECRET_ID_MAX && name.starts_with("id_")
            && !name.contains('.'))
}

/// Is the workspace-relative `path` secret, by its names alone (RULE-ONE, design §9 H1)?  It is
/// when a folder on the way is secret-named, or its leaf is and is not in [`SECRET_LEAF_ALLOW`].
/// Each name is judged as spelled and folded (see [`fold`]).  Only names count, since a command
/// cannot rename a secret it may not read (a secret-named folder too, by its `S/`), but it can
/// move the folder holding one anywhere: into `target`, or to a hidden name.  The kernel's
/// profile ([`secret_profile`]) holds the same rule, by bytes, less its exempt prefixes, so the
/// file tools refuse at least what a command is refused.
pub fn secret_path(path: &str) -> bool {
    if engine_rule_off("secret_rule_one") {
        return secret_path_first_wins(path);
    }
    let p = normalise(path);
    let parts: Vec<&str> = p.split('/').collect();
    let last = parts.len().saturating_sub(1);
    for (i, c) in parts.iter().enumerate() {
        if (secret_name(c) || secret_name(&fold(c))) && (i < last || !SECRET_LEAF_ALLOW.contains(c)) {
            return true;
        }
    }
    false
}

/// F3-4's rule, kept only for the break (`KIMBERLITE_RULE_OFF=secret_rule_one`): judged from the
/// top, a [`SECRET_PRUNE`] folder ends the judgement.
pub(super) fn secret_path_first_wins(path: &str) -> bool {
    for c in normalise(path).split('/') {
        if SECRET_PRUNE.contains(&c) {
            return false;
        }
        if secret_name(c) || secret_name(&fold(c)) {
            return true;
        }
    }
    false
}

/// One place the kernel judges secret names (F3-4b RULE-ONE): his home, or another mount's view
/// of part of it, with the prefixes below it that nothing can be moved into.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretScope {
    pub root:   String,         // absolute, with no trailing `/`
    pub exempt: Vec<String>,    // relative to `root`; an empty one exempts it whole
}

/// What the profile keeps from being written, fixed at install (F3-4b §11): the read-only class
/// roots and the snapshot of the computed rows, each under every spelling the kernel may see.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProfileRows {
    pub rows:   Vec<String>,            // absolute, spelled from `[A-Za-z0-9._/-]`, no trailing `/`
    pub sealed: Vec<(String, String)>,  // a row left to Landlock's seal, and why
}

/// The AppArmor profile [`SECRET_PROFILE`], for `scopes`: the rule of [`secret_path`] by bytes,
/// below every scope's root, less its exempt prefixes (design §9).  Read, map, exec and a hard
/// link to a secret are refused; write and create are not, since what a command writes is its
/// own and it cannot read it back, but for a secret-named folder itself, which is neither made,
/// renamed nor removed.  The first line, `# rule <sha256>`, is [`secret_rule_hash`],
/// by which the runner knows a loaded profile is the one its own lists make.
///
/// # Arguments
/// * `scopes` - Each root must be absolute and spelled from `[A-Za-z0-9._/-]`, which is all the
///   profile can hold without quoting, and has no glob in it.
/// * `rows` - What no command may write, rename, remove or hard-link to (F3-4b §11), each row
///   spelled as a root is, strictly beneath one, and with no secret name in it; its ancestors up
///   to that root are kept from being renamed or removed.  Its sealed rows are noted only.
pub fn secret_profile(scopes: &[SecretScope], rows: &ProfileRows) -> Outcome<String> {
    let body = res!(secret_profile_body(scopes, rows));
    Ok(fmt!("# rule {}\n{}", rule_hash_of(&body), body))
}

/// The sha256, in hex, of the profile [`secret_profile`] writes for `scopes`: its lists, its
/// roots and their exempt prefixes, as rendered.
///
/// # Arguments
/// * `scopes`, `rows` - As for [`secret_profile`].
pub fn secret_rule_hash(scopes: &[SecretScope], rows: &ProfileRows) -> Outcome<String> {
    let body = res!(secret_profile_body(scopes, rows));
    Ok(rule_hash_of(&body))
}

pub(super) fn rule_hash_of(body: &str) -> String {
    let mut out = String::with_capacity(64);
    for b in oxedyne_fe2o3_hash::sha256::digest(body.as_bytes()).iter() {
        out.push_str(&fmt!("{:02x}", b));
    }
    out
}

/// May `p` stand in a profile unquoted?  The bytes AppArmor reads as glob or syntax are absent.
pub(super) fn profile_safe(p: &str) -> bool {
    p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'/' || b == b'-')
}

/// `items` as one AppArmor alternation: a group needs two items or more.
pub(super) fn alternation(items: &[String]) -> String {
    match items.len() {
        1 => items[0].clone(),
        _ => fmt!("{{{}}}", items.join(",")),
    }
}

/// The profile after its hash line.
pub(super) fn secret_profile_body(scopes: &[SecretScope], rows: &ProfileRows) -> Outcome<String> {
    if scopes.is_empty() {
        return Err(err!("A secret profile needs at least one root."; Invalid, Input, Missing));
    }
    let mut roots: Vec<String> = Vec::new();
    for sc in scopes {
        let r = &sc.root;
        if !r.starts_with('/') || r.len() < 2 || r.ends_with('/') || r.contains("//")
            || !profile_safe(r)
        {
            return Err(err!("The secret profile's root {:?} is not an absolute path spelled \
                from [A-Za-z0-9._/-] with no trailing '/'.", r; Invalid, Input));
        }
        for e in &sc.exempt {
            if e.starts_with('/') || e.ends_with('/') || e.contains("//") || !profile_safe(e)
                || e.split('/').any(|c| c == "..")
            {
                return Err(err!("The exempt prefix {:?} below {:?} is not a relative path \
                    spelled from [A-Za-z0-9._/-].", e, r; Invalid, Input));
            }
        }
        roots.push(r[1..].to_string());
    }
    // S: every secret name, as bytes.
    let mut names: Vec<String> = SECRET_NAMES.iter().map(|n| n.to_string()).collect();
    names.push(fmt!(".env.*"));
    for s in SECRET_SUFFIXES {
        names.push(fmt!("?*{}", s));
    }
    for n in 1..=SECRET_ID_MAX {
        names.push(fmt!("id_{}", "[^./]".repeat(n)));
    }
    // A path rule must begin with `/`, so the roots' alternation follows it.
    let r = fmt!("/{}", alternation(&roots));
    let s = alternation(&names);
    let l = alternation(&SECRET_LEAF_ALLOW.iter().map(|n| n.to_string()).collect::<Vec<_>>());
    let secret = fmt!("{}/{{,**/}}{}{{,/**}}", r, s);
    let rows_v = res!(profile_rows_checked(scopes, &rows.rows));
    let ancestors = row_ancestors(scopes, &rows_v);
    // The rows as one alternation after the leading `/`, as a path rule must begin with one.
    let ra = fmt!("/{}", alternation(&rows_v.iter().map(|x| x[1..].to_string()).collect::<Vec<_>>()));
    let to_rows = fmt!("{}{{,/**}}", ra);
    let mut t = String::new();
    t.push_str("abi <abi/4.0>,\n");
    // Enforce mode, with no flag: `default_allow` is packed as unconfined (parser 5.0.2
    // profile.h:96-98), and the kernel checks no file rule of an unconfined profile
    // (security/apparmor/file.c:234, 256), so its denies did nothing (F34b-4e).  `allow all,`
    // grants every class the kernel mediates instead, and a deny below still beats it.  Stacked,
    // the label is the intersection, so it only narrows.
    t.push_str(&fmt!("profile {} {{\n", SECRET_PROFILE));
    t.push_str("  allow all,\n");
    // Exec is pinned to inherit, so no exec leaves the profile.
    t.push_str("  allow /** rwlkmix,\n");
    t.push_str("  deny change_profile,\n");
    t.push_str("  deny /run/user/*/bus w,\n");
    // p0: a secret leaf, and a hard link to anything secret, made from anywhere.  A folder is
    // named with its `/` when it is a rename's source, opened as a directory or removed, which
    // `{S}` alone does not match (QA F3-4b H1).
    t.push_str(&fmt!("  deny {}/{{,**/}}{}{{,/}} mrx,\n", r, s));
    t.push_str(&fmt!("  deny link /** -> {},\n", secret));
    // p0: the rows (F3-4b §11).  Nothing is written or linked in a row, nor is a hard link made
    // to one from anywhere, since a link's target is never asked its own `l`.  Each ancestor is
    // named as a directory, with its `/`, so it is neither renamed nor removed, while what is
    // inside it is judged by its own path.
    for row in &rows_v {
        t.push_str(&fmt!("  deny {}{{,/**}} wl,\n", row));
        t.push_str(&fmt!("  deny link /** -> {}{{,/**}},\n", row));
    }
    for a in &ancestors {
        t.push_str(&fmt!("  deny {}{{,/}} w,\n", a));
    }
    // p1: the allowed leaves and the exempt prefixes.  A higher priority overrides every
    // permission of a lower one where they overlap, the link deny too, so each says it again,
    // and so do the rows, each only inside the higher rule's own paths.
    t.push_str(&fmt!("  priority=1 allow {}/{{,**/}}{} rwlkmix,\n", r, l));
    t.push_str(&fmt!("  priority=1 deny link {}/{{,**/}}{} -> {},\n", r, l, secret));
    if !rows_v.is_empty() {
        t.push_str(&fmt!("  priority=1 deny {}/{{,**/}}{} wl,\n", ra, l));
        for row in &rows_v {
            if SECRET_LEAF_ALLOW.iter().any(|x| row.ends_with(&fmt!("/{}", x))) {
                t.push_str(&fmt!("  priority=1 deny {} wl,\n", row));
            }
        }
        t.push_str(&fmt!("  priority=1 deny link {}/{{,**/}}{} -> {},\n", r, l, to_rows));
    }
    let mut again: Vec<String> = Vec::new();
    for sc in scopes {
        if sc.exempt.is_empty() {
            continue;
        }
        let at = if sc.exempt.iter().any(|e| e.is_empty()) {
            fmt!("{}/**", sc.root)
        } else {
            fmt!("{}/{}/**", sc.root, alternation(&sc.exempt))
        };
        t.push_str(&fmt!("  priority=1 allow {} rwlkmix,\n", at));
        t.push_str(&fmt!("  priority=1 deny link {} -> {},\n", at, secret));
        if rows_v.is_empty() {
            continue;
        }
        t.push_str(&fmt!("  priority=1 deny link {} -> {},\n", at, to_rows));
        let xs: Vec<String> = if sc.exempt.iter().any(|e| e.is_empty()) {
            vec![sc.root.clone()]
        } else {
            sc.exempt.iter().map(|e| fmt!("{}/{}", sc.root, e)).collect()
        };
        for x in &xs {
            for row in &rows_v {
                let line = if row == x {
                    fmt!("  priority=1 deny {}/** wl,\n", row)
                } else if abs_beneath(row, x) {
                    fmt!("  priority=1 deny {}{{,/**}} wl,\n", row)
                } else if abs_beneath(x, row) {
                    fmt!("  priority=1 deny {}/** wl,\n", x)
                } else {
                    continue;
                };
                if !again.contains(&line) {
                    again.push(line);
                }
            }
            for a in &ancestors {
                // The exempt folder's own name with its `/` is inside `X/**`; without it, not.
                let line = if a == x {
                    fmt!("  priority=1 deny {}/ w,\n", a)
                } else if abs_beneath(a, x) {
                    fmt!("  priority=1 deny {}{{,/}} w,\n", a)
                } else {
                    continue;
                };
                if !again.contains(&line) {
                    again.push(line);
                }
            }
        }
    }
    for line in &again {
        t.push_str(line);
    }
    // p2: a secret-named folder and anything below it, exempt or not.  Its own name, `S/`, is
    // not read, so it is not renamed and then read under a plain name (QA F3-4b H1): a rename
    // asks its source for read, write and delete (`apparmor_path_rename`).  rc ruling (Addendum
    // 3 (2), 24 Oct): there is no `S/ w` deny.  Measured in the parser's tables with that line
    // cut, every folder form gained `w` and none gained `r`, so the rename stays refused and
    // only the mkdir and the rmdir of an empty folder open: a full one gives ENOTEMPTY, an empty
    // one leaks nothing, and a tainted command may `ore init` in its run dir.  What is inside
    // the folder is still written as anywhere else.
    t.push_str(&fmt!("  priority=2 deny {}/{{,**/}}{}/{{,**}} mrx,\n", r, s));
    if !rows_v.is_empty() {
        t.push_str(&fmt!("  priority=2 deny {}/{{,**/}}{}/** wl,\n", ra, s));
        t.push_str(&fmt!("  priority=2 deny link {}/{{,**/}}{}/** -> {},\n", r, s, to_rows));
    }
    // What is left to Landlock's seal, and why, so the rule hash changes with it too.
    for (at, why) in &rows.sealed {
        let one = |x: &str| x.replace(|c: char| c == '\n' || c == '\r', " ");
        t.push_str(&fmt!("# sealed {}: {}\n", one(at), one(why)));
    }
    t.push_str("}\n");
    Ok(t)
}

/// Is absolute path `p` strictly beneath absolute path `d`?
pub(super) fn abs_beneath(p: &str, d: &str) -> bool {
    p.len() > d.len() && p.starts_with(d) && p.as_bytes()[d.len()] == b'/'
}

/// The scope root `row` lies strictly beneath, the deepest where scopes nest.
pub(super) fn scope_of<'a>(scopes: &'a [SecretScope], row: &str) -> Option<&'a str> {
    scopes.iter().map(|sc| sc.root.as_str()).filter(|r| abs_beneath(row, r))
        .max_by_key(|r| r.len())
}

/// `rows` checked, sorted, each once, and none beneath another, which the outer one holds.
pub(super) fn profile_rows_checked(scopes: &[SecretScope], rows: &[String]) -> Outcome<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for row in rows {
        if !row.starts_with('/') || row.ends_with('/') || row.contains("//") || !profile_safe(row)
            || row.split('/').any(|c| c == "." || c == "..")
        {
            return Err(err!("The profile row {:?} is not an absolute path spelled from \
                [A-Za-z0-9._/-] with no trailing '/'.", row; Invalid, Input));
        }
        let root = match scope_of(scopes, row) {
            Some(r) => r,
            None    => return Err(err!("The profile row {:?} is not beneath any scope's root; a \
                root itself is never a row.", row; Invalid, Input)),
        };
        if secret_path(&row[root.len() + 1..]) {
            return Err(err!("The profile row {:?} has a secret name in it, so it is left to \
                Landlock's seal.", row; Invalid, Input));
        }
        if !out.contains(row) {
            out.push(row.clone());
        }
    }
    out.sort();
    let all = out.clone();
    out.retain(|r| !all.iter().any(|o| abs_beneath(r, o)));
    Ok(out)
}

/// Every folder strictly between a row and its scope's root, sorted, each once, and none that a
/// row holds already.
pub(super) fn row_ancestors(scopes: &[SecretScope], rows: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for row in rows {
        let root = match scope_of(scopes, row) {
            Some(r) => r,
            None    => continue,
        };
        let mut at = root.to_string();
        let parts: Vec<&str> = row[root.len() + 1..].split('/').collect();
        for p in &parts[..parts.len() - 1] {
            at = fmt!("{}/{}", at, p);
            if !rows.iter().any(|r| *r == at || abs_beneath(&at, r)) && !out.contains(&at) {
                out.push(at.clone());
            }
        }
    }
    out.sort();
    out
}

/// Whether `path` is inside Daimond's own directory, under any spelling a folding disk accepts.
pub(super) fn in_daimond_dir(path: &str) -> bool {
    denied_under(&normalise(path), DAIMOND_DIR)
}

/// The workspace-relative path of the entry `name` in a listing of `dir`, as the model spelled
/// `dir`: the spelling [`ToolContext::may_list`] is asked in.
pub(super) fn list_child(dir: &str, name: &str) -> String {
    let base = normalise(dir);
    if base.is_empty() { name.to_string() } else { fmt!("{}/{}", base, name) }
}

/// The line a listing ends with when the turn's bounds kept entries out of it.  Never "empty": a
/// folder whose entries were withheld is not an absence, and a model told so states one.
pub(super) fn list_hidden_note(hidden: usize) -> String {
    fmt!("[file_list] NOT listed: {} entr{} out of bounds for this turn.\n", hidden,
        if hidden == 1 { "y" } else { "ies" })
}

/// The hand's listing of `dir` (bare names, `name/` for a folder, or a line already carrying its
/// parentheses), kept to the entries this turn may list, and how many were left out.
///
/// The same per-entry rule browser storage's listing is held to ([`ToolContext::may_list`]), so
/// what a walk shows does not depend on which side of a mark the folder lies (WALK check D3).
///
/// # Arguments
/// * `ctx` - The turn whose bounds decide.
/// * `dir` - The folder listed, as the model spelled it.
/// * `text` - The hand's own listing.
pub(crate) fn machine_in_bounds<H: Host>(ctx: &ToolContext<H>, dir: &str, text: &str)
    -> (String, usize)
{
    let mut kept = String::with_capacity(text.len());
    let mut hidden = 0;
    for line in text.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        // The name is what comes before a line's own parentheses, if it carries any.
        let name = match line.find("  (") {
            Some(i) if line.ends_with(')') => &line[..i],
            _                              => line,
        };
        let is_dir = name.ends_with('/');
        if ctx.may_list(&list_child(dir, name.trim_end_matches('/')), is_dir) {
            kept.push_str(line);
            kept.push('\n');
        } else {
            hidden += 1;
        }
    }
    (kept, hidden)
}

/// A workspace-relative path in one canonical form, so one path is not several ways past a guard.
///
/// Separators are unified, `.` and empty segments dropped, and `..` resolved lexically -- the last
/// of these matters most: without it, `.daimond/skills/mine/../theirs/SKILL.md` sits under the
/// carve-out for `.daimond/skills/mine` and reads another skill's files.
pub(crate) fn normalise(path: &str) -> String {
    let repl = path.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for seg in repl.split('/') {
        match seg {
            "" | "." => continue,
            ".."     => { parts.pop(); },
            s        => parts.push(s),
        }
    }
    parts.join("/")
}

/// The refusal a file tool gives for an absolute path, or `None` where the path is relative.
///
/// There are three path conventions here and nothing in a model's training says which is which:
/// the file tools address the workspace, `run`'s `argv` addresses the machine, and `run`'s `cwd`
/// addresses the workspace again.  An absolute path handed to a file tool was read as a chain of
/// folders *inside* the workspace -- `/home/u/x` became `home/u/x` -- so the browser answered
/// "OPFS: open dir 'home' failed", which names neither the convention nor the fix, and a turn went
/// on it every session.  The convention is therefore said here, at the moment it is met.
///
/// # Arguments
/// * `tool` - The tool asked, named so the model knows which of the three conventions it met.
/// * `path` - The path as the model wrote it.
pub(super) fn absolute_path_refusal(tool: &Tool, path: &str) -> Option<String> {
    if !path.starts_with('/') {
        return None;
    }
    // The first segment is the recognition hook: it is the folder name the OPFS edge used to
    // complain about, so a model that has seen that message can join the two.
    let norm = normalise(path);
    let head = norm.split('/').next().unwrap_or("");
    let inside = if head.is_empty() {
        String::new()
    } else {
        fmt!(" -- read as written it names a folder called '{}' inside the workspace, which is \
            not there", head)
    };
    Some(fmt!(
        "Refused: '{}' is an absolute path on the machine, and {} takes a path relative to the \
        workspace{}. Give the path from the workspace root down, e.g. 'src/main.rs'. Absolute \
        paths belong only in run's 'argv'; run's 'cwd' is workspace-relative, like this one.",
        path, tool.name(), inside))
}

/// The keys of `tool`'s arguments that name a workspace path, for [`based_args`].
pub(super) fn path_keys(tool: &Tool) -> &'static [&'static str] {
    match tool {
        Tool::FileRead                                         => &["path", "paths"],
        Tool::FileMove                                         => &["path", "to"],
        Tool::WebFetch                                         => &["to"],
        Tool::TypstCompile                                     => &["path", "out"],
        Tool::Run | Tool::Verify                               => &["cwd"],
        Tool::FileWrite | Tool::FileEdit | Tool::FileList | Tool::FileSearch | Tool::Outline
        | Tool::FileGlob | Tool::FileDelete | Tool::FileRevert | Tool::DirCreate
        | Tool::ArtefactAdd | Tool::FileFetch | Tool::FileShow | Tool::SheetRead
        | Tool::DocEdit | Tool::SheetWrite | Tool::Serve | Tool::Ocr => &["path"],
        Tool::ImageEdit                                        => &["path", "out"],
        _                                                      => &[],
    }
}

/// The byte range of `key`'s array value in `args`, brackets included, or `None`.
pub(super) fn array_span(args: &str, key: &str) -> Option<(usize, usize)> {
    let needle = fmt!("\"{}\"", key);
    let after = match args.find(&needle) {
        Some(i) => i + needle.len(),
        None    => return None,
    };
    let rest = &args[after..];
    let colon = match rest.find(|c: char| !c.is_whitespace()) {
        Some(j) if rest.as_bytes()[j] == b':' => after + j + 1,
        _                                     => return None,
    };
    let tail = &args[colon..];
    let open = match tail.find(|c: char| !c.is_whitespace()) {
        Some(k) if tail.as_bytes()[k] == b'[' => colon + k,
        _                                     => return None,
    };
    let bytes = args.as_bytes();
    let (mut at, mut quoted) = (open + 1, false);
    while at < bytes.len() {
        match (bytes[at], quoted) {
            (b'\\', true) => at += 1,
            (b'"', _)      => quoted = !quoted,
            (b']', false)  => return Some((open, at + 1)),
            _              => {},
        }
        at += 1;
    }
    None
}

/// Whether a test has switched the machine folder's root off (`folder_root` named in
/// `KIMBERLITE_RULE_OFF`, comma-separated), to see its own arm go red: no path is rebased on the
/// folder and the briefing does not name it.  Never in a release build.
pub(crate) fn folder_root_off() -> bool {
    engine_rule_off("folder_root")
}

/// Whether a test has switched the engine's rule `rule` off (named in `KIMBERLITE_RULE_OFF`,
/// comma-separated), the engine's side of kimberlite's `run::rule_off`.  Never in a release build.
pub(crate) fn engine_rule_off(rule: &str) -> bool {
    if !cfg!(debug_assertions) {
        return false;
    }
    match std::env::var("KIMBERLITE_RULE_OFF") {
        Ok(v)   => v.split(',').any(|r| r.trim() == rule),
        Err(_)  => false,
    }
}

/// Whether a test has switched U13b's native compile off (`typst_native` named in
/// `KIMBERLITE_RULE_OFF`), so `typst_compile` on a machine goes back to `ui().compile_project`
/// and its check goes red.  Never in a release build.
pub(crate) fn typst_native_off() -> bool {
    if !cfg!(debug_assertions) {
        return false;
    }
    match std::env::var("KIMBERLITE_RULE_OFF") {
        Ok(v)   => v.split(',').any(|r| r.trim() == "typst_native"),
        Err(_)  => false,
    }
}

/// The script `typst_compile` runs on a machine, under `sh` only to bring the PDF back: typst
/// writes it into the command's own TMPDIR (which the engine never sees, and the hand clears
/// after the command), and it comes back as base64 on stdout, the one channel a command's result
/// carries.  typst's arguments are `$0` and `"$@"`, so no path is ever parsed by a shell.
///
/// The typst used is the first on the command's PATH that RUNS: the system's folders first, then
/// the tool prefix's `bin`s, as the runner orders them (`Prefix::on_path`).  One the fence will
/// not let the command read -- a `/usr/local/bin/typst` linked into the user's own `~/bin` on a
/// folder-granted machine -- is passed over rather than failing the compile with a permission
/// error.  None at all says so on stderr with the marker [`TYPST_MISSING`] and exit 127.
pub const TYPST_SCRIPT: &str = "set -f; t=; IFS=:; \
    for d in $PATH; do \
    if [ -x \"$d/typst\" ] && \"$d/typst\" --version >/dev/null 2>&1; then t=\"$d/typst\"; break; fi; \
    done; unset IFS; \
    [ -n \"$t\" ] || { echo daimond-typst-missing >&2; exit 127; }; \
    o=\"${TMPDIR:?}/daimond-typst-$$.pdf\"; \
    \"$t\" \"$@\" \"$o\" || exit $?; \
    base64 < \"$o\"; s=$?; rm -f \"$o\"; exit $s";

/// What [`TYPST_SCRIPT`] says on stderr when the machine has no `typst` on the command's PATH.
pub const TYPST_MISSING: &str = "daimond-typst-missing";

/// The sentence a machine without Typst gives `typst_compile`.  Nothing is installed silently
/// (U13b; a pinned install is U13c), so the model is told how, as Claude Code would be.
pub const TYPST_NOT_INSTALLED: &str = "Typst is not installed on this machine, so the project \
    was not compiled. Install it into the tool prefix with 'run' (for example \
    `micromamba install -c conda-forge typst`, or `cargo install typst-cli`) and call \
    typst_compile again.";

/// The workspace folders a project's fonts may be in, nearest first: `fonts` and then
/// `assets/fonts` in the source's own folder and in each folder above it, up to the workspace
/// root -- the rule the tab's gatherer follows, so a project compiles alike on both.
///
/// # Arguments
/// * `src_rel` - The source's workspace path.
pub fn typst_font_candidates(src_rel: &str) -> Vec<String> {
    let src = normalise(src_rel);
    let mut parts: Vec<&str> = src.split('/').filter(|p| !p.is_empty()).collect();
    // The source's own name is not a folder.
    parts.pop();
    let mut out = Vec::new();
    loop {
        let dir = parts.join("/");
        for sub in ["fonts", "assets/fonts"] {
            out.push(match dir.is_empty() {
                true    => sub.to_string(),
                false   => fmt!("{}/{}", dir, sub),
            });
        }
        if parts.pop().is_none() {
            break;
        }
    }
    out
}

/// The command `typst_compile` runs on a machine: `sh -c` [`TYPST_SCRIPT`] with typst's own
/// arguments after it -- the project root, short diagnostics (file and line, as the tab's), each
/// font folder, system fonts ignored so that a font the project lacks is refused rather than
/// substituted, and the source.  The output path is the script's own, in the command's TMPDIR.
///
/// # Arguments
/// * `root_abs` - The workspace root on this machine, typst's `--root`.
/// * `fonts_abs` - The font folders that exist, absolute, nearest first.
/// * `src_abs` - The source, absolute.
pub fn typst_argv(root_abs: &str, fonts_abs: &[String], src_abs: &str) -> Vec<String> {
    let mut argv: Vec<String> = ["sh", "-c", TYPST_SCRIPT, "typst", "compile", "--root", root_abs,
        "--diagnostic-format", "short"].iter().map(|a| a.to_string()).collect();
    for f in fonts_abs {
        argv.push(String::from("--font-path"));
        argv.push(f.clone());
    }
    argv.push(String::from("--ignore-system-fonts"));
    argv.push(src_abs.to_string());
    argv
}

/// Is `key` where `tool` starts when the call names none: `path` for a walk, `cwd` for a command
/// (F2-FIX H1).
pub(super) fn start_key(tool: &Tool, key: &str) -> bool {
    match tool {
        Tool::FileList | Tool::FileSearch | Tool::FileGlob  => key == "path",
        Tool::Run | Tool::Verify                            => key == "cwd",
        _                                                   => false,
    }
}

/// `args` with every path `tool` names rebased on the workspace's base (UNBLOCK-32 F2b), or
/// `None` where there is no base or nothing changed.
///
/// **The root of the folder's fence**: made once, at the door every call passes, before the
/// guard, so every check after it -- the path convention, the bounds, the licence, the link
/// proofs -- judges the root-relative path the act reaches ([`Workspace::based`]), never the
/// path as written.  A walk or a command that names no start starts at the base.
pub(crate) fn based_args(tool: &Tool, args: &str, ws: &Workspace) -> Option<String> {
    if ws.base().is_empty() || folder_root_off() {
        return None;
    }
    let mut out = args.to_string();
    for key in path_keys(tool) {
        if *key == "paths" {
            let list = match extract_json_string_array(&out, key) {
                Some(l) => l,
                None    => continue,
            };
            if let Some((from, to)) = array_span(&out, key) {
                let items: Vec<String> = list.iter()
                    .map(|p| fmt!("\"{}\"", json_escape(&ws.based(p)))).collect();
                out = fmt!("{}[{}]{}", &out[..from], items.join(","), &out[to..]);
            }
            continue;
        }
        match (extract_json_string(&out, key), crate::profile::string_span(&out, key)) {
            (Some(p), Some((from, to))) => {
                out = fmt!("{}\"{}\"{}", &out[..from], json_escape(&ws.based(&p)), &out[to..]);
            },
            // A walk that names no start, and a command that names no `cwd` (F2-FIX H1), start
            // at the base: the briefing says "You start in ~/<folder>", so `run ["rm","-rf",
            // "build"]` acts there, never on the home, and every check after judges the base.
            _ => if start_key(tool, key) {
                if let Some(i) = out.find('{') {
                    let rest = out[i + 1..].trim_start();
                    let sep = if rest.starts_with('}') { "" } else { "," };
                    out = fmt!("{}\"{}\":\"{}\"{}{}", &out[..=i], key, json_escape(ws.base()), sep, &out[i + 1..]);
                }
            },
        }
    }
    if out == args { None } else { Some(out) }
}

/// The refusal for a tool path that is not one canonical relative path, or `None` where it is.
///
/// Every path a tool names is judged here once, through [`RelPath`], before anything trims,
/// resolves or normalises it (PATHTYPE, R3, D-20261012-07).  A second spelling of a place is a
/// second name for it: `" ../x.md"` got a consent that read as a climb and wrote a folder named
/// `" .."`, and [`normalise`] read `../B/x.png` as `B/x.png` (CAPTURE-FENCE QA B F1, F2).  So a
/// non-canonical path is refused rather than mended, and the refusal names the one spelling to
/// write where there is one.  `""` and `"."` name the workspace root and pass.
pub(crate) fn path_refusal(tool: &Tool, path: &str) -> Option<String> {
    path_refusal_said(tool, path).map(|s| refusal_line(&s))
}

// The sentence alone; path_refusal composes it as a refusal (TOOLROW-STATUS).
fn path_refusal_said(tool: &Tool, path: &str) -> Option<String> {
    if path.is_empty() || path == "." {
        return None;
    }
    let fault = match RelPath::fault(path) {
        Some(f) => f,
        None    => return None,
    };
    match fault {
        Fault::Absolute     => absolute_path_refusal(tool, path),
        Fault::EdgeSpace    => padded_name_refusal(tool.name(), path),
        Fault::DotDot       => Some(dotdot_refusal(tool.name(), path)),
        // ONE trailing '/' on a path that is otherwise canonical (HATE-15, rc-b ruling of 26 Oct
        // 2026, amending PATHTYPE's refusal for this case only): a listing tool's 'dev/' names
        // the same folder as 'dev', and refusing it cost a call in 3 of 3 probe runs. The tool
        // is handed the path without it (see `trailing_slash_args`). A file tool still refuses,
        // in one plain sentence.
        Fault::EmptySegment if trailing_slash_stem(path).is_some() => match tool {
            Tool::FileList | Tool::FileSearch | Tool::FileGlob => None,
            _ => Some(fmt!("'{}' ends in '/', and {} takes a file: drop the trailing slash and \
                write '{}'. Nothing was read or changed.",
                path, tool.name(), path.trim_end_matches('/'))),
        },
        _                   => {
            // The one spelling, offered only where it is the same place without resolving a
            // `..` or guessing at a control character.
            let fix = normalise(path);
            let hint = match fault {
                Fault::Dot | Fault::EmptySegment | Fault::Backslash
                    if !fix.is_empty() && RelPath::is_canonical(&fix) =>
                    fmt!(" Write it as '{}'.", fix),
                _ => String::new(),
            };
            Some(fmt!("'{}' is not a workspace path as written: {}, so {} did nothing. Nothing \
                was read or changed. A path is written one way only: names from the workspace \
                root joined by single '/', with no '.', '..' or trailing '/'.{}",
                path, fault, tool.name(), hint))
        },
    }
}

/// `path` without its one trailing '/', where that is all that keeps it from being canonical.
pub(super) fn trailing_slash_stem(path: &str) -> Option<&str> {
    match path.strip_suffix('/') {
        Some(stem) if !stem.is_empty() && RelPath::is_canonical(stem) => Some(stem),
        _ => None,
    }
}

/// A listing call's `path` without its one trailing '/', which [`path_refusal`] lets through
/// (HATE-15), or `None` where there is nothing to drop.
pub(crate) fn trailing_slash_args(tool: &Tool, args: &str) -> Option<String> {
    match tool {
        Tool::FileList | Tool::FileSearch | Tool::FileGlob => (),
        _ => return None,
    }
    let path = match extract_json_string(args, "path") {
        Some(p) => p,
        None    => return None,
    };
    let stem = match trailing_slash_stem(&path) {
        Some(s) => s.to_string(),
        None    => return None,
    };
    match crate::profile::string_span(args, "path") {
        Some((from, to)) => Some(fmt!("{}\"{}\"{}", &args[..from], json_escape(&stem), &args[to..])),
        None             => None,
    }
}

/// The refusal for a path one of whose names starts or ends with whitespace, or `None`.
///
/// `" ../x.md"` was not refused and not trimmed: the consent asked to approve what read as a climb,
/// an allow wrote a literal `" .."` folder, and `capture`, which trimmed first, refused the same
/// spelling (CAPTURE-FENCE QA B F1, 2026-10-12).  One string is judged and acted on, and a padded
/// name in it is refused rather than mended, because it is almost always a slip and a quiet trim
/// would teach the model nothing.  A space INSIDE a name is an ordinary name.
pub(crate) fn padded_name_refusal(tool: &str, raw: &str) -> Option<String> {
    padded_name_refusal_said(tool, raw).map(|s| refusal_line(&s))
}

// The sentence alone; padded_name_refusal composes it as a refusal (TOOLROW-STATUS).
fn padded_name_refusal_said(tool: &str, raw: &str) -> Option<String> {
    raw.split(|c| c == '/' || c == '\\')
        .find(|seg| seg.trim() != *seg)
        .map(|seg| fmt!("'{}' has a name that starts or ends with a space or other blank ({:?}), \
            so {} did nothing. Nothing was read or changed. Names are not trimmed: write the path \
            again without the stray space.", raw, seg, tool))
}

/// The one sentence for a path with a `..` segment, whichever tool was asked (CAPTURE-FENCE QA B
/// F2, 2026-10-12).  It quotes `raw` as the model wrote it -- never a path derived from it -- and
/// says that nothing happened, so the model neither retries the same path nor hunts for a
/// permission it does not need.  Every `..` is refused, not only one that climbs above the root:
/// a resolved spelling is a second name for a place (PATHTYPE).
///
/// Where the `..` folds inside the workspace, the folded path is named as the one to write, as
/// the other bad-path refusals do (UNBLOCK-16 SETBACKS fix 5): w127 wrote
/// `diamonds/d/shots/../crystal.json` and had to find `diamonds/d/crystal.json` itself.  A path
/// that climbs above the root gets no such line, since there is no workspace path to offer.
pub(crate) fn dotdot_refusal(tool: &str, raw: &str) -> String {
    refusal_line(&dotdot_refusal_said(tool, raw))
}

// The sentence alone; dotdot_refusal composes it as a refusal (TOOLROW-STATUS).
fn dotdot_refusal_said(tool: &str, raw: &str) -> String {
    let hint = match dotdot_fold(raw) {
        Some(fix)   => fmt!(" Write it as '{}'.", fix),
        None        => fmt!(" Paths start at the workspace root, e.g. 'notes/a.md'."),
    };
    fmt!("'{}' uses '..', which no workspace path contains, so {} did nothing. Nothing was read \
        or changed.{}", raw, tool, hint)
}

/// The path `raw` names with its `..` folded, where every `..` stays inside the workspace and
/// the result is one canonical, non-empty path; else `None`.  A path from the home folder (`~`)
/// or a drive (`C:`) is no workspace path however its `..` fold (UNBLOCK-16 SETBACKS2).
pub(crate) fn dotdot_fold(raw: &str) -> Option<String> {
    let first = raw.split(|c| c == '/' || c == '\\').next().unwrap_or("");
    if first == "~" || first.ends_with(':') {
        return None;
    }
    let mut depth = 0usize;
    for seg in raw.split(|c| c == '/' || c == '\\') {
        match seg {
            "" | "."    => {},
            ".."        => depth = depth.checked_sub(1)?,
            _           => depth += 1,
        }
    }
    let fix = normalise(raw);
    if fix.is_empty() || !RelPath::is_canonical(&fix) {
        return None;
    }
    Some(fix)
}

/// The refusal `file_delete` gives before it touches anything, or `None` where the path may go on.
///
/// 2026-09-22: a daimon on a folder-mounted Diamond, its moves refused, called `file_delete` with
/// `recursive` and ~4,900 of the owner's files were gone before Syncthing had finished carrying
/// the first of them.  Deleting is the one file verb that cannot be taken back, so it removes ONE
/// file and says here, in words the model can act on, what it will not address: the workspace
/// root, a path that climbs out with `..`, or one from the machine's root.  The folder and the
/// symlink cases need the filesystem and are answered where each build reaches it.
///
/// # Arguments
/// * `raw` - The path as the model wrote it.
pub(super) fn delete_path_refusal(raw: &str) -> Option<String> {
    delete_path_refusal_said(raw).map(|s| refusal_line(&s))
}

// The sentence alone; delete_path_refusal composes it as a refusal (TOOLROW-STATUS).
fn delete_path_refusal_said(raw: &str) -> Option<String> {
    let t = raw;
    if t.starts_with('/') || t.starts_with('\\') || t.get(1..2) == Some(":") {
        return Some(fmt!(
            "'{}' is an absolute path, and file_delete takes one file named relative to the \
            workspace, e.g. 'notes/old.md'. Nothing was deleted.", raw));
    }
    // Defence in depth: the guard has answered this already, in the same words.
    if let Some(why) = path_refusal(&Tool::FileDelete, t) {
        return Some(why);
    }
    if normalise(t).is_empty() {
        return Some(fmt!(
            "'{}' names the workspace itself, which is a folder. {}", raw, DELETE_ASK));
    }
    None
}

/// What a refused delete tells the model to do instead, so that it stops rather than hunting
/// for a more destructive tool -- the shape of this incident and of the symlink one before it.
pub(super) const DELETE_ASK: &str = "file_delete removes one file at a time and never a folder, because a \
    folder can hold far more than it shows and its deletion cannot be undone. Nothing was deleted. \
    Do not look for another way to remove it -- not a move, not emptying it file by file, not a \
    command. If it should go, tell the user which folder and why, and let them delete it \
    themselves from the Files panel.";

/// The refusal for a `file_delete` whose target is a folder.
pub(super) fn delete_dir_refusal(raw: &str) -> String {
    refusal_line(&delete_dir_refusal_said(raw))
}

// The sentence alone; delete_dir_refusal composes it as a refusal (TOOLROW-STATUS).
fn delete_dir_refusal_said(raw: &str) -> String {
    fmt!("'{}' is a folder. {}", raw, DELETE_ASK)
}

/// The refusal for a turn's `file_delete` of a file larger than a version keeps: its bytes
/// could not be held, so the delete could not be put back.
pub(super) fn delete_size_refusal(raw: &str, bytes: u64) -> String {
    refusal_line(&delete_size_refusal_said(raw, bytes))
}

// The sentence alone; delete_size_refusal composes it as a refusal (TOOLROW-STATUS).
fn delete_size_refusal_said(raw: &str, bytes: u64) -> String {
    fmt!("'{}' is {} bytes, more than the {} bytes Daimond keeps a copy of, so deleting it could not be \
        undone. Nothing was deleted. Do not look for another way to remove it. If it should go, \
        tell the user which file and why, and let them delete it themselves from the Files panel.",
        raw, bytes, crate::diamond_versions::VERSION_FILE_MAX)
}

/// The refusal for a turn's `file_delete` of a file that is here and would not read, so no
/// copy of it could be kept.
pub(super) fn delete_unread_refusal(raw: &str) -> String {
    refusal_line(&delete_unread_refusal_said(raw))
}

// The sentence alone; delete_unread_refusal composes it as a refusal (TOOLROW-STATUS).
fn delete_unread_refusal_said(raw: &str) -> String {
    fmt!("'{}' is here but could not be read just now -- something else may be writing it -- so \
        no copy of it could be kept and deleting it could not be undone. Nothing was deleted. Do \
        not look for another way to remove it. If it should go, tell the user which file and why, \
        and let them delete it themselves from the Files panel.", raw)
}

/// The refusal for a `file_delete` of a file in a folder reached through the machine hand.
///
/// The hand has no delete verb (`FileOp` in `hand/src/wire.rs`), so no copy could be kept and
/// the file could not be removed. The sentence sends the model to the user, never to `run`.
pub(super) fn delete_machine_refusal(raw: &str) -> String {
    refusal_line(&delete_machine_refusal_said(raw))
}

// The sentence alone; delete_machine_refusal composes it as a refusal (TOOLROW-STATUS).
fn delete_machine_refusal_said(raw: &str) -> String {
    fmt!("'{}' is in a folder on this computer that Daimond reaches through the machine hand, and \
        the hand does not delete files, so file_delete cannot remove it. Nothing was deleted. Do \
        not look for another way to remove it -- not a move, not emptying it, not a command. If \
        it should go, tell the user which file and why, and let them delete it themselves.", raw)
}

/// The refusal for a turn's `file_delete` of a file held only in cloud storage.
///
/// Refused rather than fetched and kept: the forget reaches every device at once, and fetching
/// first would download a file the user chose to keep off this device -- on a phone, over a
/// metered connection -- only to delete it.  The user deletes it from the Files panel, where it
/// is their act.
pub(super) fn delete_cloud_refusal(raw: &str) -> String {
    refusal_line(&delete_cloud_refusal_said(raw))
}

// The sentence alone; delete_cloud_refusal composes it as a refusal (TOOLROW-STATUS).
fn delete_cloud_refusal_said(raw: &str) -> String {
    fmt!("'{}' is only in cloud storage, not on this device, so no copy of it could be kept here \
        and deleting it would remove it from every device at once. Nothing was deleted. If it \
        should go, tell the user which file and why, and let them delete it themselves from the \
        Files panel.", raw)
}

/// The refusal a turn's overwrite, delete or move of an existing file meets once the turn keeps
/// as many copies as one version holds rows.
///
/// **A bound tied to what can be put back, not to a guess at intent.**  A manifest keeps
/// [`crate::diamond_versions::TURN_FILES_MAX`] rows and counts the rest; past that, a change is
/// recorded as a number and cannot be restored.  The incident's own shape -- a batch of
/// destructive calls in one response -- is what this stops, file by file, before the store runs
/// out of room to keep what goes.  What it counts is copies, so every word of it is true where it
/// fires: files that were there before the turn changed, moved or deleted them, and never the
/// files the turn made ([`crate::diamond_versions::claim_room`]).
pub fn turn_cap_refusal(raw: &str) -> String {
    fmt!("Refused: this turn has already changed, moved or deleted {} existing files, which is as \
        many as Daimond keeps copies of in one turn, so '{}' was left as it is. Stop here and ask \
        the user before changing any more; if they say go on, the next turn starts a fresh count.",
        crate::diamond_versions::TURN_FILES_MAX, raw)
}

/// The refusal a turn's delete from the folder the user opened on this computer -- or a write
/// there that wipes a file ([`crate::diamond_versions::wipes`]) -- meets once the turn
/// has done as many as it may without asking, and the person did not let it go on: they said
/// stop, nobody answered, or there was no page to ask them on.
///
/// **The person was asked, not only the model told** (decision review of 2026-09-23, decision 2):
/// see [`crate::diamond_versions::OpenTally`].  The sentence is for the model after the fact, and
/// it sends the rest of the work to the user rather than to another tool -- and it names emptying
/// as well as deleting, because the re-check of that day emptied twelve files instead.
///
/// # Arguments
/// * `count` - The files the turn has deleted or wiped there so far.
/// * `limit` - How many a turn may do that to there before the person is asked; 0 where they
///   asked to be asked before every one.
pub fn open_delete_stopped_refusal(raw: &str, count: usize, limit: usize) -> String {
    // AT A LIMIT OF NONE THERE IS NO "AS MANY AS A TURN MAY WITHOUT ASKING": the user asks before
    // every file.  Decided by the setting and not by the count, since where each file is its own
    // question (lane-bc3's R7) a turn may stop at its third file with two let go by name.
    let done = if limit == 0 {
        fmt!("the user asks before every file a turn deletes or wipes in the folder they opened \
            on this computer -- wiped meaning written over with less than half of it left --")
    } else {
        fmt!("this turn has deleted or wiped {} file{} in the folder the user opened on this \
            computer -- wiped meaning written over with less than half of it left -- as many as a \
            turn may there without asking,", count, if count == 1 { "" } else { "s" })
    };
    fmt!("Refused: {} and the user did not let it go on -- they said stop, or could not be asked \
        -- so '{}' was left as it is. Stop deleting, emptying or replacing files there. Do not \
        look for another way to remove it. Tell the user which other files you meant to delete or \
        rewrite and why, and let them do it themselves from the Files panel.", done, raw)
}

/// The refusal a turn's act meets where the one copy it would keep passes
/// [`crate::diamond_versions::BODY_KEEP_MAX`]: refused before it lands, as a delete of a file too
/// large to keep is ([`delete_size_refusal`]).
///
/// # Arguments
/// * `raw`   - The path as the model wrote it.
/// * `bytes` - The length of the copy the act would keep: the file as it stands.
/// * `max`   - The cap on one copy, in bytes.
pub fn keep_size_refusal(raw: &str, bytes: u64, max: u64) -> String {
    refusal_line(&keep_size_refusal_said(raw, bytes, max))
}

// The sentence alone; keep_size_refusal composes it as a refusal (TOOLROW-STATUS).
fn keep_size_refusal_said(raw: &str, bytes: u64, max: u64) -> String {
    fmt!("'{}' is {} bytes, more than the {} bytes Daimond keeps a copy of, so changing it \
        could not be undone. Nothing was changed. Do not look for another way to change it. If it \
        should change, tell the user which file and why, and let them change it themselves from \
        the Files panel.", raw, bytes, max)
}

/// The refusal a turn's delete or overwrite meets once the copies it keeps would not fit in the
/// room the version store has left beside the deletions it is already holding.
///
/// A deletion's copy is held through [`crate::diamond_versions::DELETE_HOLD_MS`] whatever the
/// ceiling says, so the ceiling is kept at this door instead: the turn stops rather than the
/// store keeping a copy by letting its limit go, or letting an older deletion's copy go.
///
/// # Arguments
/// * `raw` - The path as the model wrote it.
/// * `room` - The bytes the store had left for this turn's copies.
pub fn turn_room_refusal(raw: &str, room: u64) -> String {
    fmt!("Refused: Daimond is holding copies of files deleted or wiped in the last {} days, and a \
        copy of '{}' as well would pass the version history limit ({} bytes were left for this \
        turn), so '{}' was left as it is. Stop here and ask the user: they can delete or change \
        it themselves from the Files panel, or raise the version history limit in Settings.",
        crate::diamond_versions::DELETE_HOLD_MS / (24 * 60 * 60 * 1000), raw, room, raw)
}

/// The refusal a turn's act meets on a file that something outside the turn has saved over, between
/// its acts, as many times as a turn may keep a version for ([`crate::diamond_versions::TURN_SEALS_MAX`]).
///
/// Every such save ends a run of the turn's changes, and the run is kept as a version of its own so
/// both copies have rows -- which spends one of the Diamond's versions each time (R2-4).  The file
/// is being written by something else: the user's editor, an autosave or a sync.  The sentence sends
/// the model to the person rather than to another write.
pub fn seal_cap_refusal(raw: &str) -> String {
    fmt!("Refused: '{}' keeps changing under this turn. Something outside it -- the user's editor, \
        an autosave or a sync -- has saved over files this turn was working on {} times, and Daimond \
        keeps a version each time, so '{}' was left as it is. Stop here and ask the user to close \
        or stop editing it; the next turn starts a fresh count.",
        raw, crate::diamond_versions::TURN_SEALS_MAX, raw)
}

/// The refusal for a turn's delete or overwrite whose copy could not be written into the store
/// before the act, so the act could not be undone.
pub(super) fn copy_unwritten_refusal(raw: &str, why: &str) -> String {
    fmt!("Refused: a copy of '{}' could not be written to Daimond's version store ({}), so \
        changing it could not be undone, and it was left as it is. Stop here and tell the user.",
        raw, why)
}

/// A turn's hold on the copy of one path it is about to replace or remove, taken by
/// [`Tool::hold`] before the act and given up by [`Tool::let_go`] where the act failed.
pub(super) struct Hold {
    pub(super) dia:      String,
    pub(super) key:      String,   // as the capture names it
    pub(super) kept:     bool,     // a path the store keeps, so a copy and its note are owed
    pub(super) reserved: bool,     // this hold reserved the slot, so a failed act releases it
    pub(super) noted:    bool,     // this hold wrote the note, so a failed act withdraws it
    pub(super) seen:     u64,      // `call::unknown_seen` as the hold was taken (QA1-C)
}

/// One file a turn's move carries, as the move read it before it went: where it is and where it
/// goes, each as the capture names it and as the model wrote it.
pub(super) struct MoveRead {
    pub(super) from:     String,
    pub(super) from_raw: String,
    pub(super) to:       String,
    pub(super) to_raw:   String,
    pub(super) read:     Result<Vec<u8>, (crate::diamond_versions::Body, String)>, // its bytes, or why not
}

/// What a turn's move captures once it lands, and the room it reserved ([`Tool::move_ends`]).
pub(super) struct MoveHold {
    pub(super) ends:     Vec<(String, crate::diamond_versions::Change)>, // (the path the model wrote, the capture)
    pub(super) reserved: Vec<String>,  // the paths this move reserved, which a move that fails gives back
}

/// A turn's claim on one write over a file that is there, taken by [`Tool::before_overwrite`]
/// before the write and given up by [`Tool::overwrite_failed`] where the write did not land.
pub(super) struct Overwrite {
    pub(super) held:    Option<Hold>,
    pub(super) counted: Option<(String, String)>,  // (keeper, file) the open folder's tally counted
    pub(super) wiped:   bool,                      // under half of the file left: a delete by another verb
    pub(super) copy:    Option<Vec<u8>>,           // a wipe's copy: the file as the turns found it
    pub(super) shown:   Option<crate::diamond_versions::Seen>, // the user's file as they were shown it: see `Tool::ask_first`
}

/// A restore's hold on the copy its act keeps: see `Tool::restore_hold`.
pub(super) struct RestoreHold {
    pub(super) ticket: u64,                    // the restore
    pub(super) key:    String,                 // as the store names the path
    pub(super) mark:   bool,                   // the person's file rather than the keeper's own
    pub(super) before: Option<Vec<u8>>,        // what the act found there; `None` where nothing stood
    pub(super) folder: Option<String>,         // the folder the act reached ([`crate::wasm::diamond::folder_of`])
}

/// The refusal a restore's act meets where its row was written in another folder than the one
/// its path reaches now: the file there is a different file of the same name (HR, 2026-09-25).
pub(super) fn restore_elsewhere_refusal(raw: &str) -> String {
    refusal_line(&fmt!("The kept copy of '{}' was written in a different folder from the one this \
        path reaches now, so the file here is another file of the same name. The restore left it \
        as it is. Nothing was changed.", raw))
}

/// The refusal a restore's put-back meets where it cannot be told whether the row's file is the
/// one its path reaches now, and different bytes stand there: the person decides, and the page
/// asks them before it puts the row back with `over`.  The page tells the two reasons apart by
/// these sentences (`UNPLACED` and `UNKNOWN` in `www/js/versions.js`).
pub(super) fn restore_unplaced_refusal(raw: &str, why: crate::diamond_versions::Unplaced) -> String {
    match why {
        crate::diamond_versions::Unplaced::Unrecorded => refusal_line(&fmt!("The kept copy of '{}' \
            was made before Daimond recorded which folder it came from, and a different file stands \
            at this path now. Nothing was changed; it goes back over that file only once the person \
            says so.", raw)),
        crate::diamond_versions::Unplaced::Unknown => refusal_line(&fmt!("The kept copy of '{}' was \
            recorded in a folder this device does not know -- one on another device, or one Daimond \
            no longer knows -- and a different file stands at this path now. Nothing was changed; it \
            goes back over that file only once the person says so.", raw)),
    }
}

/// What a restore's act says where the file already holds what it would leave: done, and nothing
/// written (hist-safe, 2026-10-12).  Not a refusal, so the page counts it as put back.
pub(super) fn restore_same_line(raw: &str) -> String {
    fmt!("'{}' already holds those bytes, so nothing was written.", raw)
}

/// The refusal a restore's act meets where its restore is not open -- none named, made up, closed,
/// or another Diamond's (hist-safe QA A F1, 2026-10-12).  Every act belongs to an open restore.
pub fn restore_ended_refusal(raw: &str) -> String {
    // An act with no path says so without one (hist-safe U3, QA B B4): it read "''".
    if raw.trim().is_empty() {
        return refusal_line("The restore this change belonged to has ended, so nothing was changed.");
    }
    refusal_line(&fmt!("The restore that '{}' belonged to has ended, so nothing was changed.", raw))
}

/// The refusal a restore's act meets at a file the person was asked about and has not said yes to
/// (hist-safe QA A F2, 2026-10-12): the engine holds his answer, not the page.
pub(super) fn restore_unanswered_refusal(raw: &str) -> String {
    refusal_line(&fmt!("'{}' is waiting for your answer to the restore's question, so the restore \
        did not write there. Nothing was changed.", raw))
}

/// The refusal an act under an open restore meets at a path the open never handed out: the
/// question named only what it handed out, so nothing else is written in the restore's name.
pub(super) fn restore_unasked_refusal(raw: &str) -> String {
    refusal_line(&fmt!("'{}' was not one of the files this restore was opened with, so it did not \
        write there. Nothing was changed.", raw))
}

/// The refusal a restore's act meets where the file changed since the person decided on it: at
/// the open, or when they were last asked about it (hist-safe R2, 2026-10-12).  The page tells it
/// apart by this sentence (`CHANGED` in `www/js/versions.js`) and asks once more, by name.
pub(super) fn restore_changed_refusal(raw: &str) -> String {
    refusal_line(&fmt!("'{}' changed since you were asked about it, so the restore did not write \
        over it. Nothing was changed.", raw))
}

/// The refusal a restore's act meets where what stands at the path is larger than a version keeps
/// a copy of, so replacing or removing it could not be undone.
pub(super) fn restore_size_refusal(raw: &str, bytes: u64) -> String {
    refusal_line(&fmt!("'{}' is {} bytes, more than the {} bytes Daimond keeps a copy of, so the \
        restore left it as it is rather than replace what it could not keep.",
        raw, bytes, crate::diamond_versions::VERSION_FILE_MAX))
}

/// The refusal a restore's put-back meets where the stored bytes are not text and the file is on
/// this computer: the machine hand's `write` carries text only, so the file is left as it stands.
pub(super) fn put_back_binary_refusal(raw: &str) -> String {
    refusal_line(&fmt!("The kept copy of '{}' is not text, and a file on this computer is written \
        through the machine hand, which carries text only. Written as text it would be corrupt, so \
        the restore left the file as it is.", raw))
}

/// The refusal a restore's put-back meets where the stored bytes are not on this device.
pub(super) fn put_back_absent_refusal(raw: &str) -> String {
    refusal_line(&fmt!("The kept copy of '{}' is not on this device, so the restore left the file \
        as it is. The next full sync from the device that made it brings it.", raw))
}

impl Overwrite {
    /// What the capture of a landed write records as the file's prior bytes, and whether the
    /// write wiped it: a wipe's own copy, the file as the turns found it -- else `before`, what
    /// the write replaced.
    pub(super) fn prior(over: &Option<Overwrite>, before: Option<Vec<u8>>) -> (Option<Vec<u8>>, bool) {
        match over {
            Some(Overwrite { wiped: true, copy: Some(c), .. }) => (Some(c.clone()), true),
            Some(Overwrite { wiped: true, .. })                => (before, true),
            _                                                  => (before, false),
        }
    }
}

/// What the person is asked about past the open folder's limit: the two ways a turn destroys a
/// file there (see [`crate::diamond_versions::OpenTally`]).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum OpenAct {
    Delete,
    Wipe,       // a write that leaves less than half of the file (`crate::diamond_versions::wipes`)
}

impl OpenAct {
    /// The word the page's question is chosen by.
    pub(super) fn wire(&self) -> &'static str {
        match self {
            Self::Delete => "delete",
            Self::Wipe   => "wipe",
        }
    }
}

/// The refusal for removing, moving or renaming a place this turn was given, or `None`.
///
/// **A mark's own path is the user's grant, not the turn's work.**  The write fence lets a turn
/// change what is INSIDE a marked folder, and `under(p, prefix)` is true of the prefix itself, so
/// the mark was inside its own allow-list: on 2026-09-22 the four folders a daimon removed were
/// its marks.  Deleting a marked file, or moving a marked folder -- or a folder that holds one --
/// is therefore refused, whatever else the bounds allow.  Emptying a marked folder one file at a
/// time is left to the per-turn bound ([`turn_cap_refusal`]), which stops it where the store can
/// no longer keep what goes.
///
/// **Compared folded as well as exact** (see [`fold`]).  A disk that folds case or Unicode --
/// macOS, Windows -- holds `vault/KEEP.md` and `vault/keep.md` as one file, so a mark compared
/// byte for byte could be deleted under another spelling of its own name (audit of 2026-09-23,
/// finding 7).  Folding only ever refuses more, which is the direction a refusal may err in.
///
/// # Arguments
/// * `tool` - The tool about to run; only `file_delete` and `file_move` are asked about.
/// * `args_json` - Its arguments, whose `path` is the file or folder that would go.
/// * `ctx` - The context, whose allow-lists are the places the turn was given.
pub(super) fn mark_root_refusal<H: Host>(tool: &Tool, args_json: &str, ctx: &ToolContext<H>) -> Option<String> {
    mark_root_refusal_said(tool, args_json, ctx).map(|s| refusal_line(&s))
}

// The sentence alone; mark_root_refusal composes it as a refusal (TOOLROW-STATUS).
fn mark_root_refusal_said<H: Host>(tool: &Tool, args_json: &str, ctx: &ToolContext<H>) -> Option<String> {
    let moving = match tool {
        Tool::FileDelete => false,
        Tool::FileMove   => true,
        _                => return None,
    };
    let raw = match extract_json_string(args_json, "path") {
        Some(p) => p,
        None    => return None,
    };
    let path = normalise(&raw);
    let folded = fold(&raw);
    for b in ctx.no_write.iter() {
        let (mark, fmark) = match b {
            Bound::OnlyWriteUnder(m) | Bound::OnlyUnder(m) => (normalise(m), fold(m)),
            _                                             => continue,
        };
        if mark.is_empty() {
            continue;
        }
        let same = mark == path || fmark == folded;
        // A move takes everything beneath its source with it, so a mark anywhere under it goes.
        let hit = if moving { under(&mark, &path) || under(&fmark, &folded) } else { same };
        if hit {
            return Some(fmt!(
                "'{}' {} one of the places this turn was given to work in, so no tool removes, \
                moves or renames it. Nothing was changed. If it should go or move, tell the user \
                which and why, and let them do it themselves from the Files panel.",
                raw, if same { "is" } else { "holds" }));
        }
    }
    None
}

/// Is a link with this `by` the user's own -- one they drew, or one written before a link said
/// who drew it?  A model's turn never removes one ([`user_link_refusal`]).
pub fn is_users_link(by: &str) -> bool {
    let b = by.trim();
    b.is_empty() || b == "user"
}

/// The refusal a model's `link_remove` of the user's own link meets.
///
/// **A link the user drew is theirs to take back.**  `link_remove` was unfenced for a daimon, so
/// "a grant is never removed by a tool" held in the description's words only (audit of
/// 2026-09-23, finding 7): a daimon could take the user's mark out of its own Diamond.  Less reach
/// is the safe direction for data, and it is still the user's decision rather than the model's.
/// A row with no `by` is refused as well: it predates the field, and it is the user's to confirm
/// or take out, not a model's to tidy away.
pub(super) fn user_link_refusal(id: &str) -> String {
    fmt!("Refused: link {} is the user's own -- they drew it, or it was written before links said \
        who drew them -- so no tool removes it. Nothing was removed. If it is wrong, tell the \
        user which link and why, and let them take it out themselves.", id)
}

/// Can this tool remove or replace a user's file?  The calls the lens classes by path.
pub fn is_destructive(name: &str) -> bool {
    matches!(name, "file_delete" | "file_move" | "file_write" | "file_edit" | "doc_edit"
        | "sheet_write")
}

/// What a destructive call's path was when the call met it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PathKind {
    File,
    Folder,
    Absent,     // nothing there: a write that creates, or a delete of what is not there
}

impl PathKind {
    pub fn wire(&self) -> &'static str {
        match self {
            Self::File      => "file",
            Self::Folder    => "folder",
            Self::Absent    => "none",
        }
    }
}

/// Where a destructive call's path sits, for the lens: its depth, whether it named a file or a
/// folder, and whether it was inside a folder the user opened on this computer -- and never a
/// character of the path.
///
/// **Written because the lens could not say what went.**  On 2026-09-22 the `tool` rows carried
/// the tool's name, its result's size and its outcome, and the four folders a daimon removed were
/// recovered from the byte counts of error messages.  Depth, kind and "on the user's disk" say
/// how bad a call was without saying what it named.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PathClass {
    pub depth: usize,       // segments below the workspace root; 1 is a top-level entry
    pub kind:  PathKind,
    pub open:  bool,        // inside a folder the user opened, rather than Daimond's storage
}

impl PathClass {

    /// The class as the event carries it, with whether the call was refused.
    pub fn wire(&self, refused: bool) -> String {
        fmt!(r#"{{"d":{},"k":"{}","open":{},"refused":{}}}"#,
            self.depth, self.kind.wire(), self.open, refused)
    }
}

/// The refusal for a `file_delete` or `file_move` whose path leaves the workspace through a link.
/// Native only: the File System Access API gives the browser no way to see a link at all.
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn link_escape_refusal(tool: &str, raw: &str) -> String {
    refusal_line(&link_escape_refusal_said(tool, raw))
}

// The sentence alone; link_escape_refusal composes it as a refusal (TOOLROW-STATUS).
fn link_escape_refusal_said(tool: &str, raw: &str) -> String {
    fmt!("'{}' passes through a link to a place outside the workspace, so {} will not act on it. \
        Nothing was changed. If it matters, tell the user what you wanted to do there.", raw, tool)
}

/// `raw` resolved for an act that follows links, or the refusal where a link carries it out of
/// the workspace: the one on-disk check every native read and write asks, as move and delete ask
/// `pin` (CAPTURE-FENCE QA B F4, 2026-10-12).
///
/// The fence is asked again of where the path REALLY is (QA1 F2, 17 Oct 2026): a link inside the
/// workspace that points into Daimond's own directory passes `resolve_followed`, which refuses
/// only links that leave the root, and the fence had judged the spelling alone.  See
/// [`real_admits`].
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn followed<H: Host>(ctx: &ToolContext<H>, tool: &str, raw: &str) -> Outcome<Result<std::path::PathBuf, String>> {
    let p = match res!(ctx.workspace.resolve_followed(raw)) {
        Some(p) => p,
        None    => return Ok(Err(refusal_line(&link_escape_refusal(tool, raw)))),
    };
    let writing = matches!(tool, "file_write" | "file_edit" | "doc_edit" | "sheet_write"
        | "dir_create");
    Ok(if real_admits(ctx, raw, &p, writing) {
        Ok(p)
    } else {
        Err(refusal_line(&link_inward_refusal(tool, raw)))
    })
}

/// The refusal for a path whose spelling is in bounds but which a link carries to a place this
/// turn may not reach.  It names the spelling only: where the link leads is the thing withheld.
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn link_inward_refusal(tool: &str, raw: &str) -> String {
    refusal_line(&link_inward_refusal_said(tool, raw))
}

// The sentence alone; link_inward_refusal composes it as a refusal (TOOLROW-STATUS).
fn link_inward_refusal_said(tool: &str, raw: &str) -> String {
    fmt!("'{}' passes through a link to a place this turn may not reach, so {} will not act on \
        it. Nothing was read or changed.", raw, tool)
}

/// The real, canonical `real` as a workspace-relative path, or `None` where it lies outside the
/// root.
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn real_rel(ws: &Workspace, real: &std::path::Path) -> Option<String> {
    let root = std::fs::canonicalize(ws.root()).ok()?;
    let r = real.strip_prefix(&root).ok()?;
    let s = r.to_string_lossy().replace('\\', "/");
    Some(if s.is_empty() { ".".to_string() } else { s })
}

/// THE REAL-PLACE RULE: where the on-disk `abs`, lexically under `ws`'s root, really is, every
/// link followed.  Where it exists it is canonicalised; where it does not yet (a write's target,
/// folders not made, a dangling link) [`Workspace::real_followed`] says where an act would land.
/// `None` where that place cannot be found or lies outside the root: nothing is admitted on its
/// spelling alone (U3a QC1 L2, 17 Oct 2026).  The one check a tool's fence ([`real_admits`]) and
/// the store's door ([`crate::store::door::DirLink`]) both ask, so a link in the person's folder
/// is judged by one rule wherever it is met (D1int).
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn real_place(ws: &Workspace, abs: &std::path::Path) -> Option<std::path::PathBuf> {
    let real = match std::fs::canonicalize(abs) {
        Ok(r)  => r,
        Err(_) => {
            let spelled = match abs.strip_prefix(ws.root()) {
                Ok(r)  => r.to_string_lossy().replace('\\', "/"),
                Err(_) => return None,
            };
            let spelled = if spelled.is_empty() { ".".to_string() } else { spelled };
            match ws.real_followed(&spelled) {
                Ok(Some(r)) => r,
                _           => return None,
            }
        },
    };
    match real_rel(ws, &real) {
        Some(_) => Some(real),
        None    => None,
    }
}

/// Does the fence admit the on-disk `abs`, spelled `rel`, by where it REALLY is as well as by its
/// spelling?  The one check every native door and walk asks of what it reaches (QA1 F2).
///
/// Where `abs` exists it is canonicalised; where it does not yet (a write's target, folders not
/// made, a dangling link) [`Workspace::real_followed`] says where the act would land.  Either way
/// the real place is judged, by [`admits_real`]; nothing is admitted on its spelling alone, and a
/// path whose real place cannot be found is refused (U3a QC1 L2, 17 Oct 2026).
///
/// # Arguments
/// * `rel` - The workspace-relative spelling the fence already judged.
/// * `abs` - The same path on disk, lexically under the workspace root.
/// * `writing` - Whether the act writes.
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn real_admits<H: Host>(ctx: &ToolContext<H>, rel: &str, abs: &std::path::Path, writing: bool) -> bool {
    match real_place(&ctx.workspace, abs) {
        Some(real)  => admits_real(ctx, rel, &real, writing),
        None        => false,
    }
}

/// Does the fence admit the real place `real` of a path spelled `rel`?  Where no link intervenes
/// the real place is the spelling and nothing more is asked.  Otherwise it is judged as the
/// spelling was: [`ToolContext::may_write`] for a write, [`ToolContext::may_list`] -- a file it
/// may read, a folder it may walk -- for anything else.  A place outside the root is refused.
///
/// `file_delete` and `file_move` ask it directly of their pinned paths, whose leaf is the link
/// and not its target, since they act on the link.
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn admits_real<H: Host>(ctx: &ToolContext<H>, rel: &str, real: &std::path::Path, writing: bool) -> bool {
    let real_rel = match real_rel(&ctx.workspace, real) {
        Some(r) => r,
        None    => return false,
    };
    if real_rel == normalise(rel) {
        return true;
    }
    if writing {
        ctx.may_write(&real_rel)
    } else {
        ctx.may_list(&real_rel, real.is_dir())
    }
}

/// The refusal for a `file_move` that would put a folder inside itself.
pub(super) fn move_into_itself_refusal(from: &str, to: &str) -> String {
    refusal_line(&move_into_itself_refusal_said(from, to))
}

// The sentence alone; move_into_itself_refusal composes it as a refusal (TOOLROW-STATUS).
fn move_into_itself_refusal_said(from: &str, to: &str) -> String {
    fmt!("'{}' is inside '{}', so this would move a folder into itself. Nothing was moved. \
        Choose a destination outside '{}'.", to, from, from)
}

/// The directory a `run` call NAMED, or `None` where it asked to work "here".
///
/// `.` is not a place, it is "wherever I am", and where a turn is is the folder the user marked
/// into it.  Taken literally it [`normalise`]s to the workspace ROOT, which a scoped turn may not
/// run in, so a daimon writing the most ordinary working directory there is met *"'.' is not in
/// this chat's workspace"* -- correct, useless, and one call spent every time.  Three live
/// self-development runs on 2026-08-24 were lost to exactly that.
///
/// So `.`, `./`, `""` and an absent `cwd` are ONE request, answered by
/// [`ToolContext::default_cwd`], and they cannot drift apart because they are the same branch.
/// [`crate::wasm::pty::pty_request`] has read a terminal's `cwd` this way since 2026-08-13.
///
/// **Nothing is widened.**  The fence is built from the turn's [`Bound`]s and never from the
/// working directory, so this only moves the start from a place the turn may not run in to one it
/// may -- and where a turn has nowhere on the machine at all, it now meets the sentence that says
/// so instead of a sentence about `.`.
///
/// **It says nothing about `.` as a SEARCH root**, which still means the whole workspace.  Those
/// are two different questions, and answering them alike would turn a write fence into a read
/// fence: see the note in [`walk_starts`], where three tests caught that within the hour.
///
/// An absolute `cwd` is passed through unchanged so that [`run_cwd_refusal`] still meets it.
///
/// # Arguments
/// * `args` - The raw tool arguments, read for an explicit `cwd`.
pub(super) fn asked_cwd(args: &str) -> Option<String> {
    extract_json_string(args, "cwd")
        .filter(|c| c.starts_with('/') || !normalise(c).is_empty())
}

/// The refusal a `run` call gets for an absolute `cwd`.
///
/// `run` is the one tool with a different convention on each side -- `argv` is the machine's,
/// `cwd` is the workspace's -- and an absolute `cwd` was joined onto the granted root and sent, so
/// the hand answered about `/home/u/proj/home/u/proj/src`.  The doubling is at least visible, but
/// the fix is not, and the fix is computable here: the granted root is known at this point, so
/// what the model should have written is the tail of the path it already wrote.
///
/// # Arguments
/// * `cwd` - The absolute directory the model asked for.
/// * `root` - The folder the hand granted, which is the workspace root on this machine.
pub(super) fn run_cwd_refusal(cwd: &str, root: &str) -> String {
    let root = root.trim_end_matches('/');
    // Where it would have been looked for, spelled out, because that is the sentence the model
    // will have seen come back from the hand.
    let doubled = fmt!("{}/{}", root, normalise(cwd));
    let inside = cwd.strip_prefix(root)
        .filter(|tail| tail.is_empty() || tail.starts_with('/'))
        .map(normalise);
    let fix = match inside {
        Some(rel) if rel.is_empty() =>
            fmt!("That folder IS the workspace root, so leave 'cwd' out."),
        Some(rel) =>
            fmt!("Pass '{}' instead.", rel),
        None =>
            fmt!("The workspace is '{}', and a command runs nowhere else, so name a directory \
                inside it.", root),
    };
    fmt!(
        "Refused: 'cwd' is relative to the workspace and '{}' is absolute, so it would be looked \
        for at '{}'. {} Only 'argv' takes the machine's own paths.",
        cwd, doubled, fix)
}
