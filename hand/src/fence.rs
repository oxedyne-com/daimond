//! What a command may touch, decided by the kernel rather than by this program.
//!
//! The app already has this rule.  [`crate::wire::FenceSpec`] arrives in the
//! shape `diamond_bounds` produces -- a set of roots the turn may read and
//! write, a set it may only read, and a deny of Daimond's own directory -- and
//! the whole of this module is that same rule enforced one layer down.  Nothing
//! new is being decided here.  What changes is *who* enforces it: in the page a
//! bound is checked at the tool dispatch door, and a command that ran outside
//! the page would simply walk past that door.  So the bound is handed to the
//! kernel, which has no door to walk past.
//!
//! # Landlock is an allow-list, and that is the hard part
//!
//! The mechanism on Linux is Landlock.  It is unprivileged, it is inherited
//! across `execve`, and it is expressed as a set of *grants*: a path, and the
//! access rights permitted at or beneath it.  There is no deny rule.  There is
//! no rule ordering.  Access to a file is decided by walking from the file
//! upwards and taking the union of every rule found on the way, so a narrower
//! rule placed deeper **cannot** subtract from a wider rule placed shallower.
//!
//! That was measured, not assumed.  On Linux 7.0 (Landlock ABI 8), granting
//! read+write on a workspace and then adding a read-only rule on a directory
//! inside it leaves that directory writable; the crate refuses an empty-access
//! rule outright ("empty access-right"), and even if it did not, an empty rule
//! deeper in the tree would be a no-op for the same reason.
//!
//! The consequence runs through everything below.  A `deny` of
//! `/home/u/ws/.daimond` inside an `rw` of `/home/u/ws` **cannot be expressed by
//! adding a rule**.  It can only be expressed by never granting `/home/u/ws`
//! at all, and instead granting each of its children *except* `.daimond`.  That
//! is what [`carve`] does, and it is the most important function in this file.
//! Its costs are real and are stated at [`Listing`] and in [`Plan::caveats`];
//! they are not hidden.
//!
//! The same reasoning applies to a `ro` path sitting inside an `rw` path, which
//! is easy to miss: `diamond_bounds` expresses a read-only attachment as an
//! allow plus a write fence, and if that attachment sits under a writable one
//! then the read-only half is not enforceable by adding a rule either.  It is
//! carved the same way.  A fence that quietly granted write there would be
//! telling the user something untrue.
//!
//! # What this module refuses to do
//!
//! It never claims a fence it did not apply.  [`Fence::detect`] asks the running
//! kernel what it supports; [`Plan::apply`] asks for exactly that and treats
//! anything short of full enforcement as a failure rather than as a degraded
//! success.  Where no fence is available the answer is a refusal with a sentence
//! in it, not a command that runs unfenced.  The opt-out exists -- see
//! [`Unfenced`] -- but it is a required argument at every call site rather than
//! a default somebody can forget.

use crate::wire::FenceSpec;

use oxedyne_fe2o3_core::prelude::*;

use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{
        Path,
        PathBuf,
    },
};

#[cfg(target_os = "linux")]
use landlock::{
    Access,
    AccessFs,
    AccessNet,
    BitFlags,
    PathBeneath,
    PathFd,
    RestrictSelf,
    RestrictSelfAttr,
    Ruleset,
    RulesetAttr,
    RulesetCreatedAttr,
    RulesetStatus,
    Scope,
    ABI,
};

// ┌───────────────────────────────────────────────────────────────┐
// │ The Landlock ABI                                               │
// └───────────────────────────────────────────────────────────────┘

/// Which Landlock ABI the running kernel offers.
///
/// A number rather than a boolean, because the answer is not "fenced or not":
/// each level adds a category of thing that can be restrained, and a fence
/// reporting only "on" would be claiming coverage it does not have on an older
/// kernel.  The page shows this level to the user, and [`Fence::holes`] turns it
/// into the list of what is *still* reachable, which is the honest half of the
/// same sentence.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum Abi {
    /// No Landlock: either not built into the kernel or not enabled at boot.
    None,
    /// Filesystem rules (Linux 5.13).
    V1,
    /// Adds `REFER`, which governs linking and renaming across directories (5.19).
    V2,
    /// Adds `TRUNCATE`, without which a file can be emptied but not written (6.2).
    V3,
    /// Adds TCP bind and connect: the first level at which `net: false` means
    /// anything at all (6.7).
    V4,
    /// Adds `IOCTL_DEV` (6.10).
    V5,
    /// Adds scoping: abstract unix sockets and signals (6.12).
    V6,
    /// Adds audit-log control (6.15).
    V7,
    /// Adds atomic enforcement across every thread of the process (7.0).
    V8,
    /// Adds `RESOLVE_UNIX`, which finally brings pathname unix sockets under the
    /// filesystem rules (7.1).
    V9,
    /// Newer than this build knows about.
    ///
    /// Reported verbatim rather than rounded down silently, because "your kernel
    /// is ahead of this build" and "your kernel is at the level this build tops
    /// out at" are different facts and the user is entitled to both.  The rights
    /// asked for are still capped at [`Abi::V9`].
    Newer(u32),
}

impl Abi {

    /// The numeric level, as the kernel reports it.
    pub fn level(&self) -> u32 {
        match self {
            Self::None		=> 0,
            Self::V1		=> 1,
            Self::V2		=> 2,
            Self::V3		=> 3,
            Self::V4		=> 4,
            Self::V5		=> 5,
            Self::V6		=> 6,
            Self::V7		=> 7,
            Self::V8		=> 8,
            Self::V9		=> 9,
            Self::Newer(n)	=> *n,
        }
    }

    /// The level for a number the kernel reported.
    ///
    /// # Arguments
    /// * `n` - What `landlock_create_ruleset` returned when asked for the version.
    pub fn of_level(n: u32) -> Self {
        match n {
            0	=> Self::None,
            1	=> Self::V1,
            2	=> Self::V2,
            3	=> Self::V3,
            4	=> Self::V4,
            5	=> Self::V5,
            6	=> Self::V6,
            7	=> Self::V7,
            8	=> Self::V8,
            9	=> Self::V9,
            n	=> Self::Newer(n),
        }
    }

    /// Whether the filesystem can be fenced at all.
    pub fn fences_files(&self) -> bool {
        self.level() >= 1
    }

    /// Whether `net: false` can be honoured.
    ///
    /// Below this a caller asking for no network must be refused, rather than
    /// given a fence that does not do what its name says.
    pub fn fences_tcp(&self) -> bool {
        self.level() >= 4
    }

    /// Whether abstract unix sockets and signals can be scoped to the sandbox.
    pub fn scopes(&self) -> bool {
        self.level() >= 6
    }

    /// Whether the restriction can be applied to every thread at once.
    pub fn all_threads(&self) -> bool {
        self.level() >= 8
    }

    /// Whether connecting to a *pathname* unix socket is governed by the
    /// filesystem rules.
    ///
    /// Below this it is not, and that is the largest hole in the Linux fence.
    /// See [`Fence::holes`].
    pub fn fences_unix_sockets(&self) -> bool {
        self.level() >= 9
    }

    /// The capability string the page shows, such as `landlock:abi-8`.
    pub fn cap(&self) -> String {
        match self {
            Self::None	=> fmt!("landlock:none"),
            other		=> fmt!("landlock:abi-{}", other.level()),
        }
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Levels and grants                                              │
// └───────────────────────────────────────────────────────────────┘

/// How much access a path carries, ordered so that "less" is unambiguous.
///
/// The ordering is the whole reason this is an enum with a derived `Ord`: the
/// carve decision is exactly "is this descendant's level *below* its
/// ancestor's", and a comparison that reads that way in the source is one fewer
/// place for the rule to be written backwards.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum Level {
    /// Nothing at all.  Not granted, and carved out of any ancestor that is.
    Deny,
    /// Read, list and execute.  Never write, create, delete or rename.
    Ro,
    /// Read and write.
    Rw,
}

impl Level {

    /// The word the report uses.
    pub fn word(&self) -> &'static str {
        match self {
            Self::Deny	=> "deny",
            Self::Ro	=> "ro",
            Self::Rw	=> "rw",
        }
    }
}

/// One resolved rule: a real directory or file, and what may be done there.
///
/// Paths here are canonical -- symbolic links resolved, `.` and `..` gone --
/// because path confusion is the classic way past a check of this kind, and
/// comparing two spellings of one place is how it happens.  `normalise` in the
/// app's `tools.rs` does the lexical half of this for workspace-relative names;
/// down here the paths are absolute and real, so the filesystem itself is asked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Grant {
    /// The canonical path.
    pub path:  PathBuf,
    /// What is permitted at and beneath it.
    pub level: Level,
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Two decisions the carve forces                                 │
// └───────────────────────────────────────────────────────────────┘

/// What happens to a directory that had to be carved rather than granted whole.
///
/// A carved directory is one holding a `deny` (or a narrower `ro`) and so cannot
/// itself be granted -- see the module documentation.  Its children are granted
/// individually and the directory itself is left with nothing.  That is airtight
/// and it costs something real: `ls <workspace>` fails, because listing a
/// directory needs `READ_DIR` *on that directory*.
///
/// The obvious repair is to grant `READ_DIR` on the carved directory alone.  It
/// works, and it leaks: a rule at `<workspace>` applies to everything beneath
/// it, including the denied subtree, so the command can then list the *names*
/// inside `.daimond` -- never the contents, since reading a file needs
/// `READ_FILE`, which is not granted.  Measured on ABI 8: with `READ_DIR` on the
/// parent, `readdir` of the denied directory succeeds and `read` of a file in it
/// is refused.
///
/// So this is a choice with no free answer, and it is spelled out rather than
/// made silently.  [`Listing::Sealed`] is the default, because a fence whose
/// guarantee has an undocumented exception is worse than a fence that is
/// inconvenient.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Listing {
    /// The carved directory cannot be listed.  Airtight; `ls` on it fails.
    Sealed,
    /// The carved directory can be listed, and so can the denied subtrees inside
    /// it -- entry *names* only.  Convenient; leaky.
    Names,
}

/// How much of the process the fence is applied to.
///
/// Landlock restricts the calling thread.  Since ABI 8 it can restrict every
/// thread of the process atomically instead, and that is what the launcher
/// wants: a launcher that had grown a thread and fenced only the one calling
/// [`Plan::apply`] would leave a sibling able to `fork` and `exec` outside the
/// fence, which is a hole with no warning attached to it.
///
/// [`Reach::Thread`] exists because a fence covering the whole process cannot be
/// tested from inside a test harness -- the first test to apply one would fence
/// every test after it, including the ones that had not run yet.  The rules are
/// identical either way; only the set of tasks they bind to differs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reach {
    /// Every thread of the process, where the kernel can do it atomically.
    Process,
    /// The calling thread only, which is all Landlock does by default.
    Thread,
}

/// Whether the fence adds the system paths a program needs in order to be a
/// program at all.
///
/// A [`crate::wire::FenceSpec`] names the workspace.  It does not name
/// `/usr/bin/cargo`, the dynamic linker, the locale data or `/dev/null` -- and a
/// fence granting only the workspace cannot run anything, because `execve` needs
/// `EXECUTE` on the binary and the loader needs `READ_FILE` on the shared
/// objects.  Measured: with only `/usr` and `/etc` granted read-only, spawning
/// `/bin/cat` fails with `EACCES`, because Rust's `Command` opens `/dev/null`
/// for the stdio it was not given.
///
/// So the Linux fence adds a base, the base is **read-only**, and it is written
/// out here rather than buried in a helper, since it is a deliberate widening of
/// what the caller asked for.  What it pointedly does *not* include:
///
/// * `/proc` -- because `/proc/<pid>/environ` of the user's *other* processes is
///   readable by the same uid, and the browser's own environment is exactly the
///   sort of thing a fenced command should not reach.  Measured: with `/proc`
///   left out, reading another process's environ is refused.  A caller needing
///   `/proc` must put it in `ro` explicitly and accept that.
/// * `/tmp` -- shared with every other process the user runs.  A command wanting
///   scratch space does not need it: [`crate::exec::Scratch`] gives every run a
///   private directory of its own, adds it to that run's `rw`, and points
///   `TMPDIR` at it.  That is not an optimisation -- with `/tmp` outside the
///   fence and nothing in its place, a fenced `cargo test` dies part-way through
///   with `couldn't create a temp dir: Permission denied`.
/// * `/home`, `/var`, `/run`, `/sys`, `/mnt`, `/media` -- the user's data, the
///   machine's state, and the sockets.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SysBase {
    /// Add the read-only system paths a program needs to start.
    Minimal,
    /// Add nothing.  Only what the spec named is reachable, which for most
    /// commands means they cannot run at all.  Useful when the caller has listed
    /// everything itself.
    Bare,
}

impl SysBase {

    /// The paths this base contributes, read-only.
    ///
    /// Absent entries are skipped: `/lib64` does not exist everywhere, and
    /// skipping a path makes the fence tighter rather than looser, which is the
    /// safe direction for a decision made without asking.
    pub fn paths(&self) -> &'static [&'static str] {
        match self {
            Self::Bare => &[],
            Self::Minimal => &[
                "/usr",
                "/bin",
                "/sbin",
                "/lib",
                "/lib32",
                "/lib64",
                "/libx32",
                "/etc",
                "/opt",
                "/dev/zero",
                "/dev/random",
                "/dev/urandom",
            ],
        }
    }

    /// The paths this base contributes READ-WRITE, because a program that cannot
    /// write to them is a program that does not run.
    ///
    /// `/dev/null` is the whole of why this exists. It was in the read-only list,
    /// and every git command inside the fence died with `fatal: could not open
    /// '/dev/null' for reading and writing` -- git opens it for both, as does a
    /// large share of Unix tooling, because discarding output IS a write. A base
    /// described as "the system paths a program needs in order to be a program"
    /// was missing the one device every program uses, and no test caught it
    /// because nothing in the suite ran a program that writes to it.
    ///
    /// Writable is not a widening worth worrying about: writing to `/dev/null`
    /// discards, and writing to `/dev/full` fails with ENOSPC by design. Neither
    /// can carry a byte out of the compartment, which is what the fence is for.
    /// `/dev/zero`, `/dev/random` and `/dev/urandom` stay read-only, because
    /// nothing legitimate writes to them and a write there is a seeding attempt.
    pub fn write_paths(&self) -> &'static [&'static str] {
        match self {
            Self::Bare => &[],
            Self::Minimal => &["/dev/null", "/dev/full"],
        }
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The refusal, and the way past it                               │
// └───────────────────────────────────────────────────────────────┘

/// What to do when no fence can be applied.
///
/// A required argument to [`Fence::plan`] rather than a field with a default,
/// and that is the point.  A default is a thing somebody forgets; an argument is
/// a thing somebody has to write down.  Every call site therefore says, in the
/// source, what it wants to happen on a machine with no Landlock, and a reviewer
/// can find all of them with one search.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Unfenced {
    /// Refuse to run the command.  The hand's own answer, always.
    Refuse,
    /// Run it anyway, because the user was told what that means and said yes.
    ///
    /// The sentence they agreed to travels with the decision, so the journal
    /// records what was actually on screen rather than merely that a flag was
    /// set.
    Allow {
        /// What the user acknowledged, verbatim.
        acknowledged: String,
    },
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The fence                                                      │
// └───────────────────────────────────────────────────────────────┘

/// The compartment mechanism available on this machine.
///
/// An enum with one arm per platform, and the platforms that are not built yet
/// are here from the first day rather than left to be discovered.  The reason is
/// not tidiness: an abstraction guessed from one implementation is a rewrite
/// waiting for the second, and the second is macOS, whose sandbox is a *profile*
/// applied to a process rather than a set of path rules, and the third is
/// Windows, where the nearest equivalents are a Job Object and an AppContainer
/// SID and neither is shaped like Landlock at all.  Declaring them as arms that
/// return a named refusal keeps the shape honest, and keeps the page able to say
/// which guarantee it is offering on which machine.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Fence {
    /// Landlock, at the ABI level the running kernel reported.
    Linux {
        /// What the kernel supports.
        abi:     Abi,
        /// What happens to a directory that had to be carved.
        listing: Listing,
        /// Whether the read-only system base is added.
        base:    SysBase,
    },
    /// Declared, not built.
    MacOs,
    /// Declared, not built.
    Windows,
    /// No compartment is available, and this is why.
    None {
        /// The sentence explaining what is missing.
        why: String,
    },
}

impl Fence {

    /// Asks the running machine what it can actually do.
    ///
    /// On Linux this probes Landlock rather than reading a version number, and
    /// does so on a throwaway thread: `landlock_restrict_self` restricts the
    /// calling thread only, so a thread existing solely to ask "no rules, now
    /// tell me what you supported" leaves the hand's own threads untouched.
    /// Reading `/sys/kernel/security/lsm` would be cheaper and would be a guess:
    /// it says Landlock is compiled in, not which ABI it offers.
    pub fn detect() -> Self {
        Self::detect_with(Listing::Sealed, SysBase::Minimal)
    }

    /// As [`Fence::detect`], with the two carve decisions made explicitly.
    ///
    /// # Arguments
    /// * `listing` - What a carved directory may show.
    /// * `base` - Whether the read-only system base is added.
    pub fn detect_with(listing: Listing, base: SysBase) -> Self {
        #[cfg(target_os = "linux")]
        {
            let abi = probe_abi();
            if abi.fences_files() {
                return Self::Linux { abi, listing, base };
            }
            Self::None {
                why: fmt!(
                    "This kernel has no Landlock, so there is nothing to fence a \
                    command with. Landlock arrived in Linux 5.13 and must also be \
                    enabled at boot; check that \"landlock\" appears in \
                    /sys/kernel/security/lsm."),
            }
        }
        #[cfg(target_os = "macos")]
        {
            let _ = (listing, base);
            Self::MacOs
        }
        #[cfg(target_os = "windows")]
        {
            let _ = (listing, base);
            Self::Windows
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            let _ = (listing, base);
            Self::None {
                why: fmt!(
                    "This build is for a platform the hand has no fence for, so it \
                    cannot say what a command would be prevented from touching."),
            }
        }
    }

    /// The mechanisms actually in force, for [`crate::wire::Resp::Hello`].
    ///
    /// The product's claim is that the compartment can be checked rather than
    /// trusted, and a claim of that shape has to survive a machine where the
    /// answer is "nothing".  So on a kernel without Landlock this returns
    /// `fence:none` and not an empty list: silence would read as "no answer
    /// yet", and what the user needs to read is "no fence".
    pub fn caps(&self) -> Vec<String> {
        match self {
            Self::Linux { abi, listing, base } => {
                let mut out = vec![fmt!("fence:linux"), abi.cap()];
                if abi.fences_tcp() {
                    out.push(fmt!("landlock:net-tcp"));
                }
                if abi.scopes() {
                    out.push(fmt!("landlock:scope-unix-abstract"));
                    out.push(fmt!("landlock:scope-signal"));
                }
                if abi.fences_unix_sockets() {
                    out.push(fmt!("landlock:unix-pathname"));
                }
                if abi.all_threads() {
                    out.push(fmt!("landlock:all-threads"));
                }
                // Withheld from every writable grant; see `writable`.
                out.push(fmt!("landlock:no-make-sym"));
                out.push(match listing {
                    Listing::Sealed	=> fmt!("carve:sealed"),
                    Listing::Names	=> fmt!("carve:names-visible"),
                });
                out.push(match base {
                    SysBase::Minimal	=> fmt!("sysbase:minimal"),
                    SysBase::Bare		=> fmt!("sysbase:bare"),
                });
                out
            },
            Self::MacOs			=> vec![fmt!("fence:none"), fmt!("fence:macos-unimplemented")],
            Self::Windows		=> vec![fmt!("fence:none"), fmt!("fence:windows-unimplemented")],
            Self::None { .. }	=> vec![fmt!("fence:none")],
        }
    }

    /// What a command can still reach despite this fence.
    ///
    /// Written down because an undocumented hole is worse than a documented one:
    /// a user who knows the shape of the gap can decide whether it matters, and
    /// a user who does not has been misled.  Every entry here was measured on a
    /// running kernel, not inferred from documentation.
    ///
    /// # Why this takes the filter as an argument
    ///
    /// Two of Landlock's holes are closed by something that is not Landlock.
    /// `chmod`, `chown`, `utimensat` and `setxattr` have no access right, and
    /// `connect()` to a pathname unix socket is ungoverned below ABI 9 -- and
    /// [`crate::seccomp`] refuses all of them at the system-call layer instead.
    /// A `holes()` that could not see the filter would have to either overstate
    /// the compartment or understate it, and this list is what `--report` prints,
    /// so it must be neither.
    ///
    /// # What this is NOT
    ///
    /// It is not where the consent window's wording comes from, and this comment
    /// used to say it was.  That window's text is a fixed localised string --
    /// `grant_hand_body` in `ext/_locales/*/messages.json` -- and the only thing
    /// this end contributes to it is [`Fence::caps`], which `ext/grant.js` reads
    /// to choose between "this machine can contain a command" and "it cannot".
    /// Nothing in this function reaches a user's screen.
    ///
    /// That is deliberate rather than an omission waiting to be repaired.  These
    /// are paragraphs of kernel detail, and a consent window is the one dialog in
    /// the product that has to stay short enough to be read: burying the decision
    /// under six caveats is how a person learns to click through it.  A user who
    /// wants the whole account runs `--report`, which prints exactly this list.
    ///
    /// Passing `None` asks the honest question about Landlock alone, which is
    /// what a machine with no filter gets -- and on such a machine no command
    /// runs at all, because the filter is release gate 1's second half.
    ///
    /// # Arguments
    /// * `sys` - The filter that will be installed on top of this fence, if any.
    pub fn holes(&self, sys: Option<&crate::seccomp::Spec>) -> Vec<String> {
        use crate::seccomp::{Meta, Unix};
        let unix_shut = matches!(sys, Some(s) if s.unix == Unix::Refuse);
        let meta_shut = matches!(sys, Some(s) if s.meta != Meta::Allow);
        match self {
            Self::Linux { abi, listing, base } => {
                let mut out = Vec::new();
                if !abi.fences_unix_sockets() && !unix_shut {
                    out.push(fmt!(
                        "A fenced command can step out of the fence entirely, \
                        by way of a pathname unix socket. Landlock does not \
                        govern connect() to a socket file until ABI 9 (Linux \
                        7.1), and this kernel is at ABI {}. Measured: with the \
                        network refused and the whole fence in force, connect() \
                        to /run/user/<uid>/bus succeeds, and one command through \
                        the session bus -- systemd-run --user -- starts a \
                        process that is NOT fenced and reads a file this fence \
                        denies. The same socket reaches ssh-agent, which can \
                        sign with your keys without the key ever being read. \
                        This is not a leak at the edge of the compartment; on \
                        this kernel it is a way out of it.", abi.level()));
                }
                if !meta_shut {
                    out.push(fmt!(
                        "A command can change a file's metadata anywhere it can \
                        name, including inside a denied subtree. Landlock has no \
                        access right covering chmod, chown, utimensat or setxattr, \
                        so none of the four is mediated at all. Measured on ABI {}: \
                        all four succeeded on a file outside every root, and chmod \
                        took a file inside the denied subtree from 600 to 777 -- \
                        although reading that same file is refused. A command cannot \
                        read your secrets through the fence; it can strip the \
                        permissions that were protecting them from everything else.",
                        abi.level()));
                }
                out.push(fmt!(
                    "Existence and metadata leak where contents do not. stat on \
                    a path outside the fence still answers, so sizes, \
                    timestamps, ownership and the mere presence or absence of a \
                    file are readable. The fence governs opening a file, not \
                    asking about one."));
                if *base == SysBase::Minimal {
                    out.push(fmt!(
                        "The system base grants /usr, /etc and /opt read-only, \
                        and that is a wide grant. It is what makes a command \
                        able to run at all -- the interpreter, the linker, the \
                        shared objects -- but it also means every configuration \
                        file under /etc that is world-readable can be read, and \
                        every tool installed on this machine can be executed. \
                        /etc in particular is where a great deal of \
                        machine-identifying detail lives. SysBase::Bare removes \
                        this and leaves the caller to name what a command needs, \
                        which for most commands means naming the whole of a \
                        toolchain."));
                }
                out.push(fmt!(
                    "A path that is swapped for a symbolic link between the \
                    moment the rules are worked out and the moment they are \
                    opened would be granted as its target. The plan resolves \
                    every path and refuses any that is a link, and the open \
                    re-checks immediately before it acts, so the window is one \
                    statement wide rather than one turn wide -- but a fence \
                    built while another process is actively rearranging the \
                    workspace is not something this code can make safe."));
                out.push(fmt!(
                    "UDP and raw sockets are not governed. Landlock's network \
                    rules cover TCP bind and connect only, so with net:false a \
                    command can still send UDP to a fixed address. Name lookup \
                    itself fails, because /etc/resolv.conf sits outside the \
                    fence, but a program carrying its own resolver address does \
                    not need it."));
                if !abi.scopes() {
                    out.push(fmt!(
                        "Abstract unix sockets are reachable, and the command can \
                        signal processes outside the fence. Scoping arrived at \
                        ABI 6 (Linux 6.12) and this kernel is at ABI {}.",
                        abi.level()));
                }
                out.push(fmt!(
                    "File descriptors opened before the fence was applied keep \
                    working. Landlock checks the act of opening, not the use of \
                    something already open, so the fence must be applied before \
                    anything the command should not have is opened."));
                out.push(fmt!(
                    "Every command can write in one place the workspace did not \
                    name. The hand adds a private temporary directory to each \
                    run's fence and points TMPDIR at it, because /tmp is outside \
                    the fence and a build that cannot write a temporary file \
                    fails part-way through for a reason nobody can read. So \
                    \"only inside the folders the workspace allows\" has exactly \
                    one exception, and this is it. It sits under the hand's own \
                    data directory rather than in the user's folder, so a \
                    build's leavings are never mistaken for the user's work; it \
                    is removed when the run ends; and no other run can reach it, \
                    since the directory holding them all carries no rule in any \
                    fence and each name carries 128 bits nobody can guess. See \
                    `exec::Scratch`."));
                out.push(fmt!(
                    "A hard link made earlier is a second name for the same \
                    file. If a file inside a denied subtree already has a link \
                    inside a granted one, it is readable through that link. \
                    Landlock decides by the path walked; the command cannot \
                    create such a link, but it cannot undo one that exists."));
                // A cost rather than a hole, and it is here because this is the
                // list the consent window is drawn from and the one place a
                // reader looks to find out why a command was refused.
                out.push(fmt!(
                    "A command cannot create a SYMBOLIC link, anywhere, \
                    including in the folders it may write and in its own \
                    temporary directory. `ln -s` and `symlink(2)` answer \
                    \"Permission denied\". The right is withheld because a link \
                    is half of a leak: the command makes it, and whatever later \
                    follows it -- an archiver, a packager, a version control \
                    system recording the tree -- supplies the other half by \
                    reading a file the command itself could not open. Nothing \
                    else is narrowed by it."));
                if *listing == Listing::Names {
                    out.push(fmt!(
                        "Entry names inside denied subtrees are visible, because \
                        the carved parent was granted READ_DIR so that it could \
                        be listed. Contents are not readable. Listing::Sealed \
                        closes this."));
                }
                out
            },
            Self::MacOs | Self::Windows | Self::None { .. } => vec![fmt!(
                "Everything. There is no fence on this machine, and a command \
                run here can touch whatever the user running the browser can \
                touch.")],
        }
    }

    /// The sentence a refusal carries, in the voice the file tools already use.
    ///
    /// # Arguments
    /// * `what` - What was being attempted, named so the model can recover.
    pub fn refusal(&self, what: &str) -> String {
        match self {
            Self::Linux { .. } => fmt!(
                "{} was refused, although this machine can fence commands. That \
                is a bug: the fence should have been applied instead.", what),
            Self::MacOs => fmt!(
                "{} was refused because the hand cannot fence a command on macOS \
                yet. Doing it properly needs a sandbox profile applied through \
                sandbox_exec, or the App Sandbox entitlements if the hand ships \
                in a bundle; neither is built. Running the command unfenced \
                would give it everything you can reach, so it was not run.",
                what),
            Self::Windows => fmt!(
                "{} was refused because the hand cannot fence a command on \
                Windows yet. Doing it properly needs a Job Object to bound the \
                process tree and an AppContainer SID to bound what it may open; \
                neither is built. Running the command unfenced would give it \
                everything you can reach, so it was not run.", what),
            Self::None { why } => fmt!(
                "{} was refused because there is no fence on this machine. {} \
                Running it anyway would give the command everything you can \
                reach, so it was not run.", what, why),
        }
    }

    /// Works out exactly what would be granted, without changing anything.
    ///
    /// Separated from [`Plan::apply`] on purpose.  The plan is made in the
    /// hand's own process, where an error can still become a
    /// [`crate::wire::Resp::Refused`] the page can show; applying happens in the
    /// doomed little process that is about to become the command, where the only
    /// remaining move is to die.  A spec that cannot be honoured must fail on
    /// the near side of that line.
    ///
    /// # Arguments
    /// * `spec` - What the caller asked for.
    /// * `unfenced` - What to do if there is no fence.  Required, not defaulted.
    ///
    /// # Returns
    /// A plan, or an error naming the path or the capability that made the
    /// request impossible.
    pub fn plan(&self, spec: &FenceSpec, unfenced: &Unfenced) -> Outcome<Plan> {
        match self {
            Self::Linux { abi, listing, base } => {
                if !spec.net && !abi.fences_tcp() {
                    return Err(err!(
                        "The command asked to run with no network, and this \
                        kernel's Landlock (ABI {}) has no network rules; those \
                        arrived at ABI 4 in Linux 6.7. Granting a filesystem \
                        fence and calling it a network fence would be a lie, so \
                        the command was refused.", abi.level();
                        Unimplemented, Network, Security));
                }
                let r = res!(resolve(spec, *base));
                Ok(Plan {
                    abi:     *abi,
                    listing: *listing,
                    base:    *base,
                    reach:   Reach::Process,
                    grants:  r.grants,
                    sealed:  r.sealed,
                    dropped: r.dropped,
                    net:     spec.net,
                    waiver:  None,
                })
            },
            Self::MacOs | Self::Windows | Self::None { .. } => match unfenced {
                Unfenced::Refuse => Err(err!(
                    "{}", self.refusal("This command");
                    Unimplemented, Security, Unauthorised)),
                Unfenced::Allow { acknowledged } => Ok(Plan {
                    abi:     Abi::None,
                    listing: Listing::Sealed,
                    base:    SysBase::Bare,
                    reach:   Reach::Process,
                    grants:  Vec::new(),
                    sealed:  Vec::new(),
                    dropped: Vec::new(),
                    net:     true,
                    waiver:  Some(acknowledged.clone()),
                }),
            },
        }
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The plan                                                       │
// └───────────────────────────────────────────────────────────────┘

/// Everything the fence will do, resolved, before any of it is done.
///
/// Inspectable on purpose: the journal records it, the page can show it, and a
/// test can assert on it without needing a kernel.  A compartment nobody can
/// read is a compartment nobody can check.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Plan {
    /// The ABI the rules were built for.
    pub abi:     Abi,
    /// What a carved directory may show.
    pub listing: Listing,
    /// Which system base was added.
    pub base:    SysBase,
    /// How much of the process the fence binds to.
    pub reach:   Reach,
    /// The rules, canonical and de-duplicated.
    pub grants:  Vec<Grant>,
    /// Directories that had to be carved, and so carry no grant of their own.
    ///
    /// Reported because the user will notice: these are the directories a
    /// command cannot list and cannot create a file directly inside.
    pub sealed:  Vec<PathBuf>,
    /// Children of a carved directory that were refused a grant because they do
    /// not resolve to themselves.
    ///
    /// A symbolic link is the whole of this in practice.  See [`carve`] for why
    /// granting one is a complete escape from the fence rather than a nicety.
    pub dropped: Vec<PathBuf>,
    /// Whether the network is left alone.
    pub net:     bool,
    /// Set only where the user knowingly waived the fence, carrying what they
    /// were told.
    pub waiver:  Option<String>,
}

impl Plan {

    /// Whether this plan is a fence at all.
    pub fn is_fenced(&self) -> bool {
        self.waiver.is_none() && self.abi.fences_files()
    }

    /// What the caller should be told about the shape of what they asked for.
    ///
    /// Distinct from [`Fence::holes`], which is about the mechanism.  These are
    /// consequences of *this* spec: they exist because something had to be
    /// carved, and they would not exist for a spec with no `deny` in it.
    pub fn caveats(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(ack) = &self.waiver {
            out.push(fmt!(
                "This command is running with no fence at all, because that was \
                acknowledged: {}", ack));
            return out;
        }
        for dir in &self.sealed {
            match self.listing {
                Listing::Sealed => out.push(fmt!(
                    "{} cannot be listed, and a file cannot be created directly \
                    in it. It holds something the command may not touch, and \
                    Landlock has no way to grant a directory and withhold part \
                    of it, so its children were granted one by one and the \
                    directory itself was not.", dir.display())),
                Listing::Names => out.push(fmt!(
                    "{} can be listed but a file cannot be created directly in \
                    it, and the listing includes the names inside the parts the \
                    command may not read.", dir.display())),
            }
        }
        if !self.sealed.is_empty() {
            out.push(fmt!(
                "Anything created inside a carved directory after the command \
                started is invisible to it. The rules name the children that \
                existed when the fence was built, and a name appearing \
                afterwards has no rule."));
        }
        for p in &self.dropped {
            out.push(fmt!(
                "{} was not granted, because it is a symbolic link rather than \
                the thing it names. Granting it would grant whatever it points \
                at -- which is what a command inside the fence would use it for. \
                Reach the target by its own path, if that path is inside the \
                fence.", p.display()));
        }
        out
    }

    /// Whether this plan permits `want` at `path`.
    ///
    /// The same walk the kernel does -- from the path upwards, taking the union
    /// -- so a caller can check the working directory *before* spawning rather
    /// than watching the command fail obscurely.  A convenience, not the
    /// guarantee: the guarantee is the kernel's.
    ///
    /// # Arguments
    /// * `path` - An absolute path.  Lexically normalised rather than resolved
    ///   against the filesystem, since the caller may be asking about something
    ///   that does not exist yet.
    /// * `want` - The access being asked about.
    pub fn permits(&self, path: &Path, want: Level) -> bool {
        if self.waiver.is_some() {
            return true;
        }
        let p = lexical(path);
        let mut best = Level::Deny;
        for g in &self.grants {
            if p == g.path || p.starts_with(&g.path) {
                if g.level > best {
                    best = g.level;
                }
            }
        }
        best >= want
    }

    /// Applies the fence to **the current process**, then returns what took hold.
    ///
    /// # Where this must be called
    ///
    /// Landlock restricts the caller and is inherited across `execve`; there is
    /// no way to hand a ruleset to somebody else's child.  Rust's one hook for
    /// running code between fork and exec, `CommandExt::pre_exec`, is an
    /// `unsafe` function, and this project does not write `unsafe`.
    ///
    /// So the sequence is: the hand re-executes *itself* as a small launcher,
    /// the launcher calls this on itself while it is still single-threaded and
    /// has opened nothing, and then it `exec`s the real command --
    /// `CommandExt::exec` is safe, and the fence carries across.  Calling this
    /// in the hand's own process would fence the hand, which serves the page.
    ///
    /// # Returns
    /// What was actually enforced, or an error.  Anything short of full
    /// enforcement is an error rather than a quieter success: the rules asked
    /// for exactly what this kernel said it supports, so a partial result means
    /// something is wrong rather than merely old.
    pub fn apply(&self) -> Outcome<Applied> {
        if let Some(ack) = &self.waiver {
            return Ok(Applied {
                abi:    Abi::None,
                fenced: false,
                caps:   vec![fmt!("fence:none"), fmt!("fence:waived")],
                waiver: Some(ack.clone()),
            });
        }
        #[cfg(target_os = "linux")]
        {
            self.apply_linux()
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err(err!(
                "There is no fence to apply on this platform, and the plan was \
                not marked as knowingly unfenced. Nothing was run.";
                Unimplemented, Security))
        }
    }

    /// The Landlock half of [`Plan::apply`].
    #[cfg(target_os = "linux")]
    fn apply_linux(&self) -> Outcome<Applied> {
        let abi = ll_abi(self.abi);

        // Handle every filesystem right this ABI knows. Handling a right is what
        // switches it from "unrestricted" to "denied unless a rule grants it",
        // so anything left unhandled is a whole category of access the fence
        // would not be governing.
        let mut rs = res!(Ruleset::default().handle_access(AccessFs::from_all(abi)));

        // Network. Handling the rights and then adding no port rules is what
        // denies TCP outright; leaving them unhandled is what leaves the network
        // alone. There is no third state, which is why `net` is a boolean.
        if !self.net && self.abi.fences_tcp() {
            rs = res!(rs.handle_access(AccessNet::from_all(ABI::V4)));
        }

        // Scoping. Signals are scoped whatever the network setting, because a
        // command reaching out to signal the browser is a containment failure
        // and not a networking question. Abstract unix sockets are scoped only
        // when the network is refused, since scoping them breaks X11 and the
        // session bus for a command that was allowed to talk to the world
        // anyway.
        if self.abi.scopes() {
            let mut sc: BitFlags<Scope> = Scope::Signal.into();
            if !self.net {
                sc |= Scope::AbstractUnixSocket;
            }
            rs = res!(rs.scope(sc));
        }

        let mut created = res!(rs.create());

        // Each grant is opened here rather than through `path_beneath_rules`,
        // which silently drops a path it cannot open. Dropping fails in the safe
        // direction -- the path ends up denied -- but silently, and a fence that
        // quietly did less than it was told is the failure this file exists to
        // avoid.
        for g in &self.grants {
            let mut access = match g.level {
                Level::Rw	=> writable(abi),
                Level::Ro	=> AccessFs::from_read(abi),
                // A denied path carries no rule at all; it is absent from
                // `grants` by construction, and this arm is here so that adding
                // a level later cannot silently grant it.
                Level::Deny	=> continue,
            };
            // A regular file cannot carry the rights that only make sense for a
            // directory -- MAKE_REG, MAKE_DIR, REMOVE_FILE and the rest -- and
            // asking for them anyway is not merely useless: the ruleset comes
            // back PARTIALLY enforced, which this code correctly treats as a
            // failure, so a single granted file would refuse every command. The
            // carve makes granted files common rather than rare, since carving a
            // directory grants each of its children by name.
            if !g.path.is_dir() {
                access &= AccessFs::from_file(abi);
            }
            // `PathFd::new` follows symbolic links, so a rule is bound to
            // whatever the last component resolves to rather than to the path
            // that was planned. Every path in a plan is canonical by
            // construction, which means none of them is a link -- so if one is a
            // link now, the tree changed between the plan and this moment and
            // the fence is refused. The check does not close the race, since the
            // swap can happen between the lstat and the open; it shortens it
            // from "since the plan was made" to "within this statement", and
            // `Fence::holes` says the remainder out loud.
            res!(not_a_link(&g.path));
            let fd = match PathFd::new(&g.path) {
                Ok(fd) => fd,
                Err(e) => return Err(err!(
                    "The fence cannot be built: {} was to be granted {} access \
                    and could not be opened ({}). Nothing was applied.",
                    g.path.display(), g.level.word(), e;
                    IO, Path, Security)),
            };
            created = res!(created.add_rule(PathBeneath::new(fd, access)));
        }

        // A carved directory gets a listing right and nothing else, where that
        // was asked for. See `Listing` for what it costs.
        if self.listing == Listing::Names {
            for dir in &self.sealed {
                res!(not_a_link(dir));
                let fd = match PathFd::new(dir) {
                    Ok(fd) => fd,
                    Err(e) => return Err(err!(
                        "The fence cannot be built: the carved directory {} \
                        could not be opened ({}).", dir.display(), e;
                        IO, Path, Security)),
                };
                created = res!(created.add_rule(
                    PathBeneath::new(fd, BitFlags::from(AccessFs::ReadDir))));
            }
        }

        // Every thread, where that was asked for and the kernel can do it
        // atomically. See `Reach`.
        if self.reach == Reach::Process && self.abi.all_threads() {
            created = res!(created.all_threads(true));
        }

        let status = res!(created.restrict_self());
        match status.ruleset {
            RulesetStatus::FullyEnforced => (),
            RulesetStatus::PartiallyEnforced => return Err(err!(
                "The kernel applied only part of the fence. The rules were built \
                for Landlock ABI {}, which is what this kernel reported it \
                supports, so a partial result means the two disagree. The \
                command was not run, rather than run behind a fence of unknown \
                shape.", self.abi.level();
                Mismatch, Security, System)),
            RulesetStatus::NotEnforced => return Err(err!(
                "The kernel applied none of the fence, although it reported \
                Landlock ABI {}. The command was not run.", self.abi.level();
                Mismatch, Security, System)),
        }
        if !status.no_new_privs {
            return Err(err!(
                "no_new_privs could not be set, so a setuid program inside the \
                fence could still gain privileges the fence does not bound. The \
                command was not run.";
                Security, System));
        }

        let mut caps = vec![fmt!("fence:linux"), self.abi.cap()];
        if !self.net {
            caps.push(fmt!("net:denied-tcp"));
        }
        if self.abi.scopes() {
            caps.push(fmt!("scope:signal"));
            if !self.net {
                caps.push(fmt!("scope:unix-abstract"));
            }
        }
        if status.all_threads {
            caps.push(fmt!("landlock:all-threads"));
        }
        Ok(Applied {
            abi:    self.abi,
            fenced: true,
            caps,
            waiver: None,
        })
    }
}

/// What actually took hold, as opposed to what was asked for.
///
/// The two are kept apart because the difference is the only thing worth
/// reporting: a [`Plan`] is a wish and this is the answer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Applied {
    /// The ABI the rules were built for.
    pub abi:    Abi,
    /// Whether a fence is in force at all.
    pub fenced: bool,
    /// The capability strings for the journal and the page.
    pub caps:   Vec<String>,
    /// What the user acknowledged, where they waived the fence.
    pub waiver: Option<String>,
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Resolving a spec into rules                                    │
// └───────────────────────────────────────────────────────────────┘

/// What [`resolve`] worked out, before it becomes a [`Plan`].
///
/// Three lists rather than a tuple, because the third arrived later and a tuple
/// of three `Vec<PathBuf>`-shaped things is exactly where an argument gets
/// passed in the wrong order.
struct Resolved {
    /// The rules, canonical and de-duplicated.
    grants:  Vec<Grant>,
    /// Directories that had to be carved, and so carry no grant of their own.
    sealed:  Vec<PathBuf>,
    /// Children of a carved directory that were refused a grant because they do
    /// not resolve to themselves.
    dropped: Vec<PathBuf>,
}

/// Turns a spec into the grants that express it, carving where it must.
///
/// # Arguments
/// * `spec` - What the caller asked for.
/// * `base` - Whether the read-only system base is added.
///
/// # Returns
/// The grants, the directories that had to be carved and the children that were
/// refused, or an error naming the path that could not be resolved.
fn resolve(spec: &FenceSpec, base: SysBase) -> Outcome<Resolved> {
    // Every path in one canonical form first. Two spellings of one directory
    // would defeat the ancestor comparisons the whole carve rests on, and a
    // symbolic link left unresolved would grant its target rather than itself.
    let mut want: BTreeMap<PathBuf, Level> = BTreeMap::new();
    for (paths, level) in [
        (&spec.rw,   Level::Rw),
        (&spec.ro,   Level::Ro),
        (&spec.deny, Level::Deny),
    ] {
        for raw in paths.iter() {
            let p = res!(canonical(raw, level));
            // The most restrictive wins where a path is named twice. A caller
            // listing a path as both writable and denied has contradicted
            // itself, and the reading that cannot leak is the strict one.
            match want.get(&p) {
                Some(existing) if *existing <= level => (),
                _ => { want.insert(p, level); },
            }
        }
    }

    // The system base, added only where the caller did not speak about the path
    // itself. An explicit entry always wins: the base is a convenience and must
    // never quietly widen or narrow what was actually asked for.
    for raw in base.paths() {
        let real = match Path::new(raw).canonicalize() {
            Ok(r) => r,
            // Absent from this machine. Skipping tightens the fence, which is
            // the safe direction for something nobody asked for by name.
            Err(_) => continue,
        };
        want.entry(real).or_insert(Level::Ro);
    }
    // The writable half of the base, after the read-only half, so a device named
    // in both lists ends up writable. Same rule as above: an explicit entry from
    // the caller still wins, because `or_insert` does not overwrite one.
    for raw in base.write_paths() {
        let real = match Path::new(raw).canonicalize() {
            Ok(r) => r,
            Err(_) => continue,
        };
        want.entry(real).or_insert(Level::Rw);
    }

    // Which paths have to be cut out of which. A path is cut out of its nearest
    // named ancestor whenever it carries less access than that ancestor does,
    // because Landlock takes the union walking upwards and a narrower rule
    // deeper down would read as an addition rather than a subtraction.
    let mut cuts: BTreeMap<PathBuf, Vec<PathBuf>> = BTreeMap::new();
    for (p, level) in want.iter() {
        if let Some(owner) = nearest_owner(&want, p) {
            let owner_level = match want.get(&owner) {
                Some(l) => *l,
                None => return Err(err!(
                    "The fence's own bookkeeping lost {}.", owner.display(); Bug)),
            };
            if *level < owner_level {
                cuts.entry(owner).or_default().push(p.clone());
            }
        }
    }

    let mut grants: Vec<Grant> = Vec::new();
    let mut sealed: Vec<PathBuf> = Vec::new();
    let mut dropped: Vec<PathBuf> = Vec::new();
    let none: Vec<PathBuf> = Vec::new();
    for (p, level) in want.iter() {
        if *level == Level::Deny {
            continue; // A denied path is expressed by the absence of a rule.
        }
        let mine = match cuts.get(p) {
            Some(v) => v.as_slice(),
            None => none.as_slice(),
        };
        res!(carve(p, p, mine, *level, &mut grants, &mut sealed, &mut dropped));
    }

    // One rule per path, at the widest level anything asked for. The kernel
    // would union them anyway; doing it here makes the plan readable and keeps
    // the rule count down.
    let mut best: BTreeMap<PathBuf, Level> = BTreeMap::new();
    for g in grants {
        match best.get(&g.path) {
            Some(l) if *l >= g.level => (),
            _ => { best.insert(g.path, g.level); },
        }
    }
    let out = best.into_iter()
        .map(|(path, level)| Grant { path, level })
        .collect::<Vec<_>>();
    sealed.sort();
    sealed.dedup();
    dropped.sort();
    dropped.dedup();
    Ok(Resolved { grants: out, sealed, dropped })
}

/// Grants `root`, or -- where something inside it must be withheld -- grants its
/// children one at a time instead.
///
/// This is the answer to the problem the module documentation states: Landlock
/// cannot subtract, so a directory holding something the command may not touch
/// cannot be granted at all.  What can be granted is each of its children except
/// the one leading to the withheld thing, and then the same question again one
/// level down, until the withheld thing is reached.
///
/// # A carved child is never granted under the name it was found by
///
/// This is the single most dangerous line in the file, and it was wrong.  The
/// enumeration below finds *names*; `PathFd::new` in [`Plan::apply_linux`] then
/// **follows symbolic links** and binds the rule to the inode it lands on.  A
/// child called `escape` that is a link to `/home/u` therefore grants the whole
/// home directory, at whatever level the carved parent carries.
///
/// That is not a corner case.  Every real fence carves the workspace, because
/// the spec always denies `.daimond` inside it -- and the workspace is exactly
/// the directory a command is *allowed to write to*.  So a command need only
/// leave a symbolic link behind on one turn to be granted its target on the
/// next: deterministic, persistent, and chosen by the thing being fenced.
///
/// The rule here is therefore that a carved child is granted only if it resolves
/// to itself: `canonicalize` must return the same path it was given, and that
/// path must still lie under the root the carve started from.  Anything else is
/// dropped and reported through [`Plan::caveats`].  Dropping rather than
/// resolving is deliberate -- granting a link's *target* would be granting a
/// path the spec never named, which is the same escape wearing a tidier hat.
///
/// Four things it does not cover, all consequences of enumerating a directory
/// at one moment in time, and all reported through [`Plan::caveats`] rather than
/// left for the user to discover:
///
/// * A child created after the fence was built has no rule, so it is
///   unreachable -- including by the command that just tried to create it.
/// * The carved directory itself cannot be listed.  See [`Listing`].
/// * A file cannot be created directly in the carved directory, because creating
///   one needs `MAKE_REG` *on that directory*, and granting that would grant it
///   beneath the carved directory too -- which is exactly what the carve exists
///   to prevent.
/// * A child could be replaced by a symbolic link *between* this check and the
///   `PathFd::new` that opens it.  The window is narrowed at both ends -- the
///   open re-checks with `symlink_metadata` first -- but it is not closed, and
///   [`Fence::holes`] says so.
///
/// # Arguments
/// * `root` - The path to grant.
/// * `top` - The outermost root this carve descends from; nothing may be granted
///   outside it.
/// * `cuts` - Paths strictly beneath it that must be withheld from this grant.
/// * `level` - What to grant.
/// * `grants` - Where the rules accumulate.
/// * `sealed` - Where carved directories are recorded.
/// * `dropped` - Where children that do not resolve to themselves are recorded.
fn carve(
    root:    &Path,
    top:     &Path,
    cuts:    &[PathBuf],
    level:   Level,
    grants:  &mut Vec<Grant>,
    sealed:  &mut Vec<PathBuf>,
    dropped: &mut Vec<PathBuf>,
)
    -> Outcome<()>
{
    if cuts.is_empty() {
        grants.push(Grant { path: root.to_path_buf(), level });
        return Ok(());
    }
    if !root.is_dir() {
        return Err(err!(
            "{} must be carved around {} path(s) inside it, but it is not a \
            directory, so there is nothing inside it to carve.",
            root.display(), cuts.len();
            Invalid, Path, Bug));
    }
    sealed.push(root.to_path_buf());

    // Group the cuts by the child of `root` leading to each of them, so the walk
    // descends once per branch rather than once per cut.
    let mut branch: BTreeMap<OsString, Vec<PathBuf>> = BTreeMap::new();
    for c in cuts {
        let rel = match c.strip_prefix(root) {
            Ok(r) => r,
            Err(_) => return Err(err!(
                "{} was to be cut out of {}, which does not contain it.",
                c.display(), root.display();
                Bug, Path)),
        };
        let first = match rel.components().next() {
            Some(comp) => comp.as_os_str().to_os_string(),
            None => return Err(err!(
                "{} was to be cut out of itself.", root.display(); Bug, Path)),
        };
        branch.entry(first).or_default().push(c.clone());
    }

    let entries = match std::fs::read_dir(root) {
        Ok(it) => it,
        Err(e) => return Err(err!(
            "{} could not be listed while building the fence around it ({}). \
            Nothing was applied.", root.display(), e;
            IO, Path)),
    };
    for entry in entries {
        let entry = res!(entry);
        let name = entry.file_name();
        let child = root.join(&name);
        match branch.get(&name) {
            // Nothing withheld down here: grant the child whole, but only if
            // the child is itself and not a pointer at something else.
            None => {
                if resolves_to_itself(&child, top) {
                    grants.push(Grant { path: child, level });
                } else {
                    dropped.push(child);
                }
            },
            Some(sub) => {
                // The cut itself. It carries its own level, applied where the
                // caller's own entry for it is handled, so nothing is granted
                // here -- and for a deny, nothing is granted anywhere.
                if sub.iter().any(|c| c.as_path() == child.as_path()) {
                    continue;
                }
                // An intermediate directory on the way down. A cut is a
                // canonical path, so every component above it is already known
                // not to be a link; a failure here means the tree changed while
                // it was being read, and the fence is refused rather than built
                // around a guess.
                if !resolves_to_itself(&child, top) {
                    return Err(err!(
                        "{} lies on the way to something this fence must \
                        withhold, and it stopped resolving to itself while the \
                        rules were being built. Nothing was applied.",
                        child.display();
                        Conflict, Path, Security));
                }
                res!(carve(&child, top, sub, level, grants, sealed, dropped));
            },
        }
    }
    Ok(())
}

/// Whether `p` is the thing it names, and still lies under `top`.
///
/// The test is deliberately strict: `canonicalize` resolves every symbolic link
/// and every `..` in the path, so a path that comes back unchanged is one that
/// no link is involved in.  A link is the interesting case and the answer for it
/// is no; a path that has vanished since it was listed answers no as well, which
/// is the safe direction for something nobody can look at.
///
/// # Arguments
/// * `p` - The candidate, built by joining a canonical directory with one name.
/// * `top` - The root the carve started from.
fn resolves_to_itself(p: &Path, top: &Path) -> bool {
    match std::fs::canonicalize(p) {
        Ok(real) => real == p && real.starts_with(top),
        Err(_)   => false,
    }
}

/// The nearest strictly-enclosing path the spec named, if any.
///
/// "Nearest" and not "any", because the levels form a chain: a deny inside a
/// read-only attachment inside a writable workspace has to be cut out of the
/// read-only attachment, which is in turn cut out of the workspace.  Comparing
/// against the outermost only would carve the wrong directory.
///
/// # Arguments
/// * `want` - Every path the spec named, with its level.
/// * `p` - The path whose owner is wanted.
fn nearest_owner(want: &BTreeMap<PathBuf, Level>, p: &Path) -> Option<PathBuf> {
    let mut at = p.parent();
    while let Some(dir) = at {
        if want.contains_key(dir) {
            return Some(dir.to_path_buf());
        }
        at = dir.parent();
    }
    None
}

/// The canonical form of a path the caller named, or an error saying why not.
///
/// Symbolic links are resolved, so a granted path that is a link grants the
/// place it points at under the name it points at rather than under the name it
/// was written as -- which matters, because Landlock binds a rule to an inode
/// and comparing the written spellings would put the ancestor tests on the wrong
/// tree.
///
/// A missing path is an error for `rw` and `ro` and not for `deny`.  A grant of
/// something absent would silently narrow the fence and leave the command
/// failing for a reason nobody can see; a deny of something absent is simply
/// satisfied, and its parent is carved regardless, so a thing of that name
/// cannot be created there later either.
///
/// # Arguments
/// * `raw` - The path as the spec spelled it.
/// * `level` - What it was named for.
fn canonical(raw: &str, level: Level) -> Outcome<PathBuf> {
    let p = Path::new(raw);
    if !p.is_absolute() {
        return Err(err!(
            "The fence was given the path {:?}, which is not absolute. The hand \
            does not interpret workspace-relative spellings; whatever resolved \
            them should send the result.", raw;
            Invalid, Input, Path));
    }
    match p.canonicalize() {
        Ok(c) => Ok(c),
        Err(e) => match level {
            // Nothing to resolve, so the lexical form stands. Its parent is
            // still carved, which is what makes the deny hold.
            Level::Deny => Ok(lexical(p)),
            _ => Err(err!(
                "The fence was told to grant {} access to {:?}, which cannot be \
                resolved ({}). Granting nothing there would leave the command \
                failing for a reason nobody could see, so the fence was refused \
                instead.", level.word(), raw, e;
                Invalid, Input, Path, NotFound)),
        },
    }
}

/// A path with `.` dropped and `..` resolved against the text rather than the
/// filesystem.
///
/// Used only where the filesystem cannot answer: a path that does not exist, and
/// [`Plan::permits`] asking about one that may not exist yet.  The lexical rule
/// is the one the app's `normalise` uses, and it is here for the same reason --
/// without it, `ws/.daimond/../attached` reads as being under `.daimond` when it
/// is not, and `ws/attached/../.daimond` reads as not being under `.daimond`
/// when it is.
///
/// # Arguments
/// * `p` - The path to normalise.
fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::CurDir	=> (),
            std::path::Component::ParentDir	=> { out.pop(); },
            other							=> out.push(other.as_os_str()),
        }
    }
    out
}

/// Refuses a path that is a symbolic link, immediately before it is opened.
///
/// `symlink_metadata` is the `lstat` half of the pair: it describes the link
/// rather than what it points at, which is the whole question here.
///
/// # Arguments
/// * `p` - The path about to be opened for a rule.
#[cfg(target_os = "linux")]
fn not_a_link(p: &Path) -> Outcome<()> {
    let md = match std::fs::symlink_metadata(p) {
        Ok(md) => md,
        Err(e) => return Err(err!(
            "The fence cannot be built: {} could not be examined ({}) \
            immediately before it was to be opened. Nothing was applied.",
            p.display(), e;
            IO, Path, Security)),
    };
    if md.file_type().is_symlink() {
        return Err(err!(
            "The fence cannot be built: {} is a symbolic link, and a rule opened \
            through a link would be bound to whatever it points at rather than \
            to the path the fence planned. Every path in a plan is canonical, so \
            this one changed after the plan was made. Nothing was applied.",
            p.display();
            Conflict, Path, Security));
    }
    Ok(())
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Talking to Landlock                                            │
// └───────────────────────────────────────────────────────────────┘

/// Asks the kernel which Landlock ABI it offers, restricting nothing.
///
/// `RestrictSelf` with no flags set makes no `landlock_restrict_self` call at
/// all -- it carries the answer from the version query the kernel was asked when
/// the builder was made -- so this is a question and not a change.
///
/// The throwaway thread is for the one side effect that remains.  The builder
/// sets `PR_SET_NO_NEW_PRIVS`, which is per-thread and inherited by anything
/// forked from that thread, and setting it on the hand's own thread would leave
/// every later child unable to gain privileges through a setuid program -- which
/// would silently break `sudo` for a command that had every right to use it.  On
/// a thread that exists for the length of one question, it changes nothing.
///
/// The first draft of this probe built a real ruleset and applied it with
/// `no_new_privs(false)`, reasoning that a probe should not change what it
/// probes.  The kernel refuses that outright with `EPERM`: Landlock will not
/// restrict a thread that has not set `no_new_privs` first.  Every test that
/// needed a kernel then skipped, loudly, which is the only reason it was found.
#[cfg(target_os = "linux")]
fn probe_abi() -> Abi {
    let probe = std::thread::spawn(|| -> Abi {
        let status = match RestrictSelf::default().apply() {
            Ok(s) => s,
            Err(_) => return Abi::None,
        };
        match status.landlock {
            landlock::LandlockStatus::Available { effective_abi, kernel_abi } =>
                Abi::of_level(match kernel_abi {
                    // The kernel is ahead of the crate; report its own number.
                    Some(v) if v > 0	=> v as u32,
                    _					=> effective_abi as u32,
                }),
            // Landlock is either absent or switched off; both mean no fence.
            _ => Abi::None,
        }
    });
    match probe.join() {
        Ok(abi)	=> abi,
        // A probe that could not finish is reported as no Landlock, which makes
        // the hand refuse. Guessing upwards here would be guessing in the one
        // direction that lets a command run unfenced.
        Err(_)	=> Abi::None,
    }
}

// ── A writable grant does not include the right to make a symbolic link ─────
//
// A link is half of a leak, and a fenced command supplies exactly that half.  It
// costs one call inside a folder the command may write, and the other half is
// supplied by whatever later reads the link -- an archiver, a packager, an
// uploader, a version control system.  Ore is the case that was measured: it
// absorbs the CONTENT of a link that leaves the working copy, under the link's
// own path, into a signed history with no forget, and a global `post-commit`
// hook runs it from outside the fence on the owner's key.  `ln -s
// ../../../outside/private.txt leak.txt` was enough, and the daimon needed no
// access to Ore at all.
//
// The obvious repair is to check what a link points at, and it is weaker twice
// over.  It races a repoint between the check and the read, and it cannot see a
// `symlink(2)` a compiler makes rather than an `ln` a model runs.  Withholding
// the capability has neither weakness, because there is no call left to make.
//
// The right is still HANDLED at the ruleset -- `AccessFs::from_all` covers it --
// which is what turns it from unrestricted into denied-unless-granted.  What
// changes here is that no grant carries it, so `symlink(2)` answers
// `EACCES` everywhere, including in the command's own scratch directory.
//
// Nothing else narrows: reading, writing, creating, removing, renaming, hard
// linking and truncating are all as they were.  The cost is stated in
// `Fence::holes`, because a command meeting "Permission denied" from `ln -s`
// deserves to find out why somewhere other than here.

/// The rights a writable grant carries.
///
/// # Arguments
/// * `abi` - The ABI the rules are being built for.
#[cfg(target_os = "linux")]
fn writable(abi: ABI) -> BitFlags<AccessFs> {
    AccessFs::from_all(abi) & !BitFlags::from(AccessFs::MakeSym)
}

/// The crate's ABI constant for a detected level, capped at what it knows.
///
/// A kernel newer than this build is asked only for the rights this build
/// understands.  Asking for a right by a number nobody has checked is how a
/// fence acquires behaviour nobody intended.
///
/// # Arguments
/// * `abi` - The detected level.
#[cfg(target_os = "linux")]
fn ll_abi(abi: Abi) -> ABI {
    match abi {
        Abi::None		=> ABI::Unsupported,
        Abi::V1			=> ABI::V1,
        Abi::V2			=> ABI::V2,
        Abi::V3			=> ABI::V3,
        Abi::V4			=> ABI::V4,
        Abi::V5			=> ABI::V5,
        Abi::V6			=> ABI::V6,
        Abi::V7			=> ABI::V7,
        Abi::V8			=> ABI::V8,
        Abi::V9			=> ABI::V9,
        Abi::Newer(_)	=> ABI::V9,
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘
//
// Every kernel test does the forbidden thing FIRST, unfenced, and asserts that
// it worked. Only then is the fence applied, in the same thread, on the same
// file, and the same attempt asserted to fail. A test showing only the refusal
// would pass just as well against a path that never existed, a permission bit
// nobody set, or a fence that refuses everything -- which is to say it would
// prove nothing.
//
// Each kernel test runs its body on a thread it spawns itself, because
// `landlock_restrict_self` restricts the calling thread and there is no way to
// take a restriction off again. libtest gives a test its own thread only while
// it is running tests concurrently; under `--test-threads=1` it runs them on the
// main thread, where the first fence applied would silently be inherited by
// every test after it. Owning the thread makes the tests mean the same thing
// however the harness is invoked.

#[cfg(test)]
mod tests {
    use super::*;

    use std::{
        fs,
        net::{
            TcpListener,
            TcpStream,
        },
    };

    /// Where the fixtures go.
    ///
    /// Under the home cache and never `/tmp`: that is a tmpfs here, its pages
    /// are charged to whoever wrote them, and filling it has taken this machine
    /// down before.
    fn root() -> Outcome<PathBuf> {
        let home = match std::env::var("HOME") {
            Ok(h) => h,
            Err(e) => return Err(err!(
                "The fence tests need HOME to know where to put fixtures: {}", e;
                Test, Configuration)),
        };
        Ok(PathBuf::from(home).join(".cache/daimond-hand-fence-tests"))
    }

    /// A fresh workspace: an `rw` root, a `deny` subtree inside it, an `ro`
    /// attachment, and a directory outside the fence entirely.
    ///
    /// # Arguments
    /// * `name` - A name unique to the calling test, so tests do not share state.
    fn fixture(name: &str) -> Outcome<PathBuf> {
        let base = res!(root()).join(name);
        let _ = fs::remove_dir_all(&base);
        res!(fs::create_dir_all(base.join("ws/.daimond")));
        res!(fs::create_dir_all(base.join("ws/sub/deep")));
        res!(fs::create_dir_all(base.join("ws/refs")));
        res!(fs::create_dir_all(base.join("outside")));
        res!(fs::write(base.join("ws/ok.txt"), "ok"));
        res!(fs::write(base.join("ws/.daimond/secret.txt"), "secret"));
        res!(fs::write(base.join("ws/sub/deep/x.txt"), "deep"));
        res!(fs::write(base.join("ws/refs/note.md"), "note"));
        res!(fs::write(base.join("outside/other.txt"), "other"));
        Ok(base)
    }

    /// The spec the fixture is built for: workspace writable, `refs` read-only,
    /// `.daimond` denied, no network.
    ///
    /// # Arguments
    /// * `base` - The fixture root.
    fn spec(base: &Path) -> FenceSpec {
        FenceSpec {
            rw:   vec![fmt!("{}", base.join("ws").display())],
            ro:   vec![fmt!("{}", base.join("ws/refs").display())],
            deny: vec![fmt!("{}", base.join("ws/.daimond").display())],
            net:  false,
        }
    }

    /// A Linux fence at a stated ABI, for the tests that decide rules rather
    /// than apply them.
    ///
    /// # Arguments
    /// * `abi` - The level to pretend to.
    fn planner(abi: Abi) -> Fence {
        Fence::Linux {
            abi,
            listing: Listing::Sealed,
            base:    SysBase::Bare,
        }
    }

    /// The real fence, or `None` with a printed reason where this kernel cannot
    /// run the test.
    ///
    /// Loud rather than silent: a kernel test that quietly passes on a machine
    /// that never ran it is a test that will quietly pass forever.
    ///
    /// # Arguments
    /// * `what` - The test's name, for the message.
    fn kernel_fence(what: &str) -> Option<Fence> {
        let f = Fence::detect();
        match &f {
            Fence::Linux { abi, .. } => {
                println!("[{}] running against {}", what, abi.cap());
                Some(f)
            },
            other => {
                println!(
                    "[{}] SKIPPED: this machine has no fence to test. The hand \
                    reports caps {:?}. Run this on Linux 5.13 or later with \
                    Landlock enabled.", what, other.caps());
                None
            },
        }
    }

    /// Runs a test body on a thread of its own, so the fence it applies dies
    /// with it.
    ///
    /// A panic inside becomes an error rather than a lost thread, so a failed
    /// assertion still fails the test it belongs to.
    ///
    /// # Arguments
    /// * `what` - The test's name, for the error.
    /// * `body` - The unfenced half, the fence, and the fenced half.
    fn own_thread<F>(what: &'static str, body: F) -> Outcome<()>
    where
        F: FnOnce() -> Outcome<()> + Send + 'static,
    {
        match std::thread::spawn(body).join() {
            Ok(result) => result,
            Err(panic) => {
                let msg = match panic.downcast_ref::<&str>() {
                    Some(s) => s.to_string(),
                    None => match panic.downcast_ref::<String>() {
                        Some(s) => s.clone(),
                        None => fmt!("(the panic carried no message)"),
                    },
                };
                Err(err!("{}: {}", what, msg; Test))
            },
        }
    }

    /// Applies the spec to this thread, failing loudly rather than continuing
    /// unfenced.
    ///
    /// # Arguments
    /// * `f` - The fence.
    /// * `s` - What to apply.
    fn engage(f: &Fence, s: &FenceSpec) -> Outcome<Applied> {
        let mut plan = res!(f.plan(s, &Unfenced::Refuse));
        // The rules are exactly the production ones; only their reach is
        // narrowed. `Reach::Process` is what the launcher uses and it is
        // untestable from inside a harness -- the first test to apply it would
        // fence every test that had not run yet, including this one's siblings.
        plan.reach = Reach::Thread;
        let applied = res!(plan.apply());
        if !applied.fenced {
            return Err(err!(
                "The fence reported that it was not applied, so the rest of this \
                test would prove nothing."; Test, Security));
        }
        Ok(applied)
    }

    // ── The carve, decided without a kernel ─────────────────────────

    /// A deny inside an `rw` root becomes an absence of a rule on the parent and
    /// a rule on each of its other children.
    ///
    /// This is the shape the whole file exists for, so it is asserted directly
    /// rather than only through its effects.
    #[test]
    fn deny_inside_rw_carves_the_parent() -> Outcome<()> {
        let base = res!(fixture("carve-shape"));
        let ws = res!(base.join("ws").canonicalize());
        let plan = res!(planner(Abi::V5).plan(&spec(&base), &Unfenced::Refuse));

        // The workspace itself must NOT be granted. Granting it and then adding
        // a narrower rule underneath is the mistake this file is about.
        assert!(
            !plan.grants.iter().any(|g| g.path == ws),
            "the carved parent was granted whole: {:?}", plan.grants);
        assert!(plan.sealed.contains(&ws), "the carved parent was not reported");

        // Its children are granted one by one, except the denied one.
        let granted = |rel: &str| -> bool {
            plan.grants.iter().any(|g| g.path == ws.join(rel))
        };
        assert!(granted("ok.txt"), "{:?}", plan.grants);
        assert!(granted("sub"), "{:?}", plan.grants);
        assert!(granted("refs"), "{:?}", plan.grants);
        assert!(!granted(".daimond"), "the denied subtree was granted");

        // And nothing anywhere grants anything inside the denied subtree.
        let deny = ws.join(".daimond");
        assert!(
            !plan.grants.iter().any(|g| g.path.starts_with(&deny)),
            "a rule reaches inside the denied subtree: {:?}", plan.grants);
        Ok(())
    }

    /// A read-only path inside a writable one is carved too.
    ///
    /// The easy bug: `diamond_bounds` expresses a read-only attachment as an
    /// allow plus a write fence, and if that attachment sits inside a writable
    /// one then adding a read-only rule achieves nothing, because Landlock takes
    /// the union walking upwards. The read-only half would silently not hold.
    #[test]
    fn ro_inside_rw_is_carved_not_merely_added() -> Outcome<()> {
        let base = res!(fixture("carve-ro"));
        let ws = res!(base.join("ws").canonicalize());
        let refs = ws.join("refs");
        let plan = res!(planner(Abi::V5).plan(&spec(&base), &Unfenced::Refuse));

        // `refs` is granted, and only read-only.
        let g = match plan.grants.iter().find(|g| g.path == refs) {
            Some(g) => g,
            None => return Err(err!("refs was not granted at all"; Test)),
        };
        assert_eq!(Level::Ro, g.level);

        // No rule above it grants write over it. That is the property; the rule
        // on `refs` alone would not deliver it.
        for other in &plan.grants {
            if other.path != refs && refs.starts_with(&other.path) {
                assert!(
                    other.level < Level::Rw,
                    "{} grants {} over the read-only {}",
                    other.path.display(), other.level.word(), refs.display());
            }
        }
        Ok(())
    }

    /// A relative path, and a grant of something absent, are refused rather than
    /// quietly dropped.
    #[test]
    fn bad_specs_are_refused() -> Outcome<()> {
        let f = planner(Abi::V5);
        let relative = FenceSpec {
            rw: vec![fmt!("ws")],
            ..Default::default()
        };
        assert!(f.plan(&relative, &Unfenced::Refuse).is_err(),
            "a relative path was accepted");

        let missing = FenceSpec {
            rw: vec![fmt!("/nowhere/at/all/{}", 0)],
            ..Default::default()
        };
        assert!(f.plan(&missing, &Unfenced::Refuse).is_err(),
            "a grant of a path that does not exist was accepted");

        // A deny of something absent is fine: there is nothing to resolve, and
        // the carve of its parent is what makes it hold.
        let base = res!(fixture("absent-deny"));
        let absent = FenceSpec {
            rw:   vec![fmt!("{}", base.join("ws").display())],
            deny: vec![fmt!("{}", base.join("ws/never-made").display())],
            ..Default::default()
        };
        let plan = res!(f.plan(&absent, &Unfenced::Refuse));
        let ws = res!(base.join("ws").canonicalize());
        assert!(plan.sealed.contains(&ws),
            "a deny of an absent path did not carve its parent");
        Ok(())
    }

    /// No fence means no command, and the way past it has to be written down.
    #[test]
    fn no_fence_refuses_by_default() -> Outcome<()> {
        let s = FenceSpec { net: true, ..Default::default() };
        for f in [
            Fence::None { why: fmt!("Nothing here.") },
            Fence::MacOs,
            Fence::Windows,
        ] {
            assert!(f.plan(&s, &Unfenced::Refuse).is_err(),
                "{:?} ran a command with no fence", f);

            // The refusal names what is missing, so the sentence is usable.
            let words = f.refusal("A build");
            assert!(words.contains("A build"), "{}", words);
            match f {
                Fence::MacOs => assert!(words.contains("sandbox_exec"), "{}", words),
                Fence::Windows => assert!(
                    words.contains("Job Object") && words.contains("AppContainer"),
                    "{}", words),
                _ => (),
            }

            // And the opt-out works, carries what the user agreed to, and says
            // plainly that nothing is fenced.
            let plan = res!(f.plan(&s, &Unfenced::Allow {
                acknowledged: fmt!("I know this runs unfenced."),
            }));
            assert!(!plan.is_fenced());
            let applied = res!(plan.apply());
            assert!(!applied.fenced);
            assert!(applied.caps.contains(&fmt!("fence:none")));
            assert!(plan.caveats().iter().any(|c| c.contains("no fence at all")));
        }
        Ok(())
    }

    /// Asking for no network on a kernel too old for network rules is refused,
    /// rather than answered with a filesystem fence wearing the wrong label.
    #[test]
    fn no_net_on_an_old_abi_is_refused() -> Outcome<()> {
        let base = res!(fixture("old-abi"));
        let f = planner(Abi::V3); // no network rules before ABI 4
        assert!(f.plan(&spec(&base), &Unfenced::Refuse).is_err(),
            "net:false was accepted on an ABI that cannot honour it");

        // The same kernel is fine for a command that wanted the network anyway.
        let open = FenceSpec { net: true, ..spec(&base) };
        assert!(f.plan(&open, &Unfenced::Refuse).is_ok());
        Ok(())
    }

    /// The capability report says "no fence" out loud rather than saying nothing.
    #[test]
    fn caps_never_stay_silent() -> Outcome<()> {
        for f in [
            Fence::None { why: fmt!("x") },
            Fence::MacOs,
            Fence::Windows,
        ] {
            let caps = f.caps();
            assert!(caps.contains(&fmt!("fence:none")), "{:?}", caps);
            assert!(!f.holes(None).is_empty(), "{:?}", f);
        }
        let linux = Fence::Linux {
            abi:     Abi::V8,
            listing: Listing::Sealed,
            base:    SysBase::Minimal,
        };
        assert!(linux.caps().contains(&fmt!("landlock:abi-8")));

        // Each of these is a measured hole, and each was missing from the list
        // at some point while the list was being believed. Naming them
        // individually is the point: `holes()` is the honest half of `caps()`,
        // and a hole nobody wrote down is indistinguishable from a hole nobody
        // has.
        let holes = linux.holes(None);
        let said = |needle: &str| -> bool {
            holes.iter().any(|h| h.contains(needle))
        };
        assert!(said("pathname unix socket"), "{:?}", holes);
        // And it must say what that actually costs, not merely that it exists.
        assert!(said("systemd-run"), "the unix-socket hole is understated: {:?}", holes);
        assert!(said("ssh-agent"), "{:?}", holes);
        assert!(said("chmod"), "metadata syscalls are not mentioned: {:?}", holes);
        assert!(said("setxattr"), "{:?}", holes);
        assert!(said("stat"), "metadata reads are not mentioned: {:?}", holes);
        assert!(said("/etc"), "the breadth of the system base is not stated: {:?}", holes);
        assert!(said("symbolic link"), "the open-time race is not stated: {:?}", holes);

        // The two the filter closes must STOP being claimed once it is installed,
        // and only those two. A list that goes on describing a shut hole is as
        // dishonest as one that leaves an open one out, and this list is what the
        // consent window's wording is drawn from.
        let shut = linux.holes(Some(&crate::seccomp::Spec::for_command()));
        let now  = |needle: &str| -> bool {
            shut.iter().any(|h| h.contains(needle))
        };
        assert!(!now("systemd-run"),
            "the session bus is refused and holes() still claims it: {:?}", shut);
        assert!(!now("chmod"),
            "the metadata calls are refused and holes() still claims them: {:?}", shut);
        // Everything the filter does NOT close is still said, in the same words.
        assert!(now("stat"), "metadata READS are not the filter's to close: {:?}", shut);
        assert!(now("/etc"), "{:?}", shut);
        assert!(now("symbolic link"), "{:?}", shut);
        assert!(now("UDP"), "{:?}", shut);
        assert!(now("File descriptors opened before"), "{:?}", shut);
        assert_eq!(holes.len(), shut.len() + 2,
            "exactly two entries should have gone: {:?} -> {:?}", holes, shut);

        // A spec that refuses nothing closes nothing, so the list is the full one
        // again. The filter's presence is not what matters; what it refuses is.
        let idle = crate::seccomp::Spec {
            meta: crate::seccomp::Meta::Allow,
            unix: crate::seccomp::Unix::Allow,
            ring: crate::seccomp::Ring::Refuse,
            poke: crate::seccomp::Poke::Refuse,
        };
        assert_eq!(holes.len(), linux.holes(Some(&idle)).len(),
            "a filter that refuses neither still shortened the list");
        Ok(())
    }

    // ── The symlink escape ──────────────────────────────────────────

    /// A symbolic link in a carved directory must not be granted.
    ///
    /// The escape this proves, in the order it happens on a real machine: the
    /// spec always denies `.daimond` inside the workspace, so the workspace is
    /// always carved and its children granted one by one. The workspace is also
    /// the one place a command may write. So a command drops a link there on one
    /// turn -- `ln -s /home/you ws/escape` -- and on the next turn the carve
    /// enumerates it, `PathFd::new` follows it, and the rule binds to the home
    /// directory's inode at the workspace's own level. Read and write, on
    /// everything, chosen by the thing being fenced.
    ///
    /// Asserted at both ends. The plan must not carry the link, and the kernel
    /// must refuse the target -- because a plan that looks right and a fence that
    /// is wrong is the failure mode the whole file is written against.
    #[test]
    fn a_symlink_in_a_carved_directory_is_not_granted() -> Outcome<()> {
        let base = res!(fixture("symlink-carve"));
        let ws = res!(base.join("ws").canonicalize());
        let outside = res!(base.join("outside").canonicalize());

        // The link a command could leave behind on any turn it can write.
        let link = base.join("ws/escape");
        res!(std::os::unix::fs::symlink(&outside, &link));

        let plan = res!(planner(Abi::V5).plan(&spec(&base), &Unfenced::Refuse));

        // Nothing is granted under the name of the link.
        assert!(
            !plan.grants.iter().any(|g| g.path == ws.join("escape")),
            "the link itself was granted: {:?}", plan.grants);
        // And nothing is granted at what it points at, which is the form the
        // bug actually took: the rule is bound to the target's inode.
        assert!(
            !plan.grants.iter().any(|g| g.path == outside || outside.starts_with(&g.path)),
            "the link's target was granted: {:?}", plan.grants);
        // The user is told, rather than left to wonder why the link is dead.
        assert!(plan.dropped.contains(&ws.join("escape")),
            "the dropped link was not reported: {:?}", plan.dropped);
        assert!(plan.caveats().iter().any(|c| c.contains("escape")),
            "the caveat did not name the link: {:?}", plan.caveats());
        Ok(())
    }

    /// The same escape, refused by the kernel rather than by the plan.
    #[test]
    fn a_symlink_escape_is_refused_by_the_kernel() -> Outcome<()> {
        let f = match kernel_fence("a_symlink_escape_is_refused_by_the_kernel") {
            Some(f) => f,
            None => return Ok(()),
        };
        own_thread("a_symlink_escape_is_refused_by_the_kernel", move || {
            let base = res!(fixture("symlink-kernel"));
            let outside = res!(base.join("outside").canonicalize());
            let link = base.join("ws/escape");
            res!(std::os::unix::fs::symlink(&outside, &link));

            let direct = base.join("outside/other.txt");
            let through = link.join("other.txt");

            // Broken first: unfenced, the file reads both ways round. Without
            // this half the test would pass against a link that never worked.
            assert_eq!("other", res!(fs::read_to_string(&direct)));
            assert_eq!("other", res!(fs::read_to_string(&through)));

            res!(engage(&f, &spec(&base)));

            assert!(fs::read_to_string(&through).is_err(),
                "a symbolic link in the workspace still reached outside the \
                fence: this is the escape, and it is open");
            assert!(fs::read_to_string(&direct).is_err(),
                "the link's target was granted under its own name");
            assert!(fs::write(link.join("planted.txt"), "x").is_err(),
                "a symbolic link in the workspace granted write outside the fence");

            // The rest of the workspace still works, so the refusals above are
            // the fence holding rather than the fence refusing everything.
            assert_eq!("ok", res!(fs::read_to_string(base.join("ws/ok.txt"))));
            Ok(())
        })
    }

    /// A link is dropped even when it points somewhere the fence already allows.
    ///
    /// The safe direction, and it costs something: the target is reachable by
    /// its own path and not by the link's. Asserted so that a later change
    /// "fixing" the inconvenience has to argue with a test rather than with a
    /// comment.
    #[test]
    fn a_link_pointing_inside_the_fence_is_dropped_too() -> Outcome<()> {
        let base = res!(fixture("symlink-inward"));
        let ws = res!(base.join("ws").canonicalize());
        res!(std::os::unix::fs::symlink(ws.join("sub"), base.join("ws/shortcut")));

        let plan = res!(planner(Abi::V5).plan(&spec(&base), &Unfenced::Refuse));
        assert!(!plan.grants.iter().any(|g| g.path == ws.join("shortcut")),
            "an inward link was granted: {:?}", plan.grants);
        assert!(plan.dropped.contains(&ws.join("shortcut")));
        // The target keeps its own grant, so nothing real was lost.
        assert!(plan.grants.iter().any(|g| g.path == ws.join("sub")),
            "the link's target lost its own grant: {:?}", plan.grants);
        Ok(())
    }

    /// An uncarved root that *is* a link is resolved, not dropped.
    ///
    /// The distinction matters and is easy to collapse. A path the *spec* named
    /// goes through `canonical`, which resolves it, because the user chose it. A
    /// path found by *enumerating* a carved directory was chosen by whatever
    /// could write there, which is the command. Same mechanism, opposite
    /// answers.
    #[test]
    fn a_spec_named_link_is_still_resolved() -> Outcome<()> {
        let base = res!(fixture("symlink-spec"));
        let real = res!(base.join("ws/sub").canonicalize());
        let named = base.join("link-to-sub");
        res!(std::os::unix::fs::symlink(&real, &named));

        let s = FenceSpec {
            rw:   vec![fmt!("{}", named.display())],
            ..Default::default()
        };
        let plan = res!(planner(Abi::V5).plan(&s, &Unfenced::Refuse));
        assert!(plan.grants.iter().any(|g| g.path == real && g.level == Level::Rw),
            "a spec-named link was not resolved to its target: {:?}", plan.grants);
        assert!(plan.dropped.is_empty(), "{:?}", plan.dropped);
        Ok(())
    }

    // ── The same rules, proved against the kernel ───────────────────

    /// A file outside the fence: readable now, refused once fenced.
    #[test]
    fn outside_the_fence_becomes_unreadable() -> Outcome<()> {
        let f = match kernel_fence("outside_the_fence_becomes_unreadable") {
            Some(f) => f,
            None => return Ok(()),
        };
        own_thread("outside_the_fence_becomes_unreadable", move || {
            let base = res!(fixture("outside"));
            let target = base.join("outside/other.txt");

            // Broken first: unfenced, this works.
            assert_eq!("other", res!(fs::read_to_string(&target)));

            res!(engage(&f, &spec(&base)));
            assert!(fs::read_to_string(&target).is_err(),
                "a file outside every root was still readable");
            Ok(())
        })
    }

    /// A read-only root: writable now, refused once fenced, still readable.
    #[test]
    fn a_read_only_root_stops_accepting_writes() -> Outcome<()> {
        let f = match kernel_fence("a_read_only_root_stops_accepting_writes") {
            Some(f) => f,
            None => return Ok(()),
        };
        own_thread("a_read_only_root_stops_accepting_writes", move || {
            let base = res!(fixture("read-only"));
            let target = base.join("ws/refs/note.md");

            // Broken first.
            res!(fs::write(&target, "written before the fence"));

            res!(engage(&f, &spec(&base)));
            assert!(fs::write(&target, "written after").is_err(),
                "a read-only root accepted a write");
            // And it is genuinely read-only rather than simply unreachable,
            // which is the difference between a fence and a mistake.
            assert!(fs::read_to_string(&target).is_ok(),
                "a read-only root stopped being readable");
            Ok(())
        })
    }

    /// The one most likely to be quietly broken: a denied subtree inside a
    /// writable parent.
    ///
    /// Landlock cannot subtract, so this holds only if the parent was never
    /// granted. Both directions are asserted -- the denied subtree is refused
    /// and the rest of the same parent still works -- because a fence that
    /// refused everything would pass the first half on its own.
    #[test]
    fn a_denied_subtree_inside_a_writable_parent_is_refused() -> Outcome<()> {
        let f = match kernel_fence(
            "a_denied_subtree_inside_a_writable_parent_is_refused") {
            Some(f) => f,
            None => return Ok(()),
        };
        own_thread("a_denied_subtree_inside_a_writable_parent_is_refused", move || {
            let base = res!(fixture("deny-in-rw"));
            let secret = base.join("ws/.daimond/secret.txt");
            let ok = base.join("ws/ok.txt");
            let deep = base.join("ws/sub/deep/x.txt");

            // Broken first: unfenced, the denied file reads and writes.
            assert_eq!("secret", res!(fs::read_to_string(&secret)));
            res!(fs::write(&secret, "secret"));

            res!(engage(&f, &spec(&base)));
            assert!(fs::read_to_string(&secret).is_err(),
                "the denied subtree was still readable inside a writable parent");
            assert!(fs::write(&secret, "z").is_err(),
                "the denied subtree was still writable inside a writable parent");
            assert!(fs::read_dir(base.join("ws/.daimond")).is_err(),
                "the denied subtree could still be listed");

            // The rest of the workspace is untouched, so the refusals above are
            // the fence working rather than the fence breaking.
            assert_eq!("ok", res!(fs::read_to_string(&ok)));
            res!(fs::write(&ok, "ok"));
            assert_eq!("deep", res!(fs::read_to_string(&deep)));
            Ok(())
        })
    }

    /// A read-only attachment inside a writable workspace really is read-only.
    ///
    /// Proving the carve rather than the rule: adding a read-only rule under a
    /// writable one does nothing, so a fence taking the easy route would fail
    /// here and nowhere else.
    #[test]
    fn a_read_only_attachment_inside_a_writable_workspace_holds() -> Outcome<()> {
        let f = match kernel_fence(
            "a_read_only_attachment_inside_a_writable_workspace_holds") {
            Some(f) => f,
            None => return Ok(()),
        };
        own_thread("a_read_only_attachment_inside_a_writable_workspace_holds", move || {
            let base = res!(fixture("ro-in-rw"));
            let note = base.join("ws/refs/note.md");

            // Broken first.
            res!(fs::write(&note, "note"));

            res!(engage(&f, &spec(&base)));
            assert!(fs::write(&note, "changed").is_err(),
                "a read-only attachment inside a writable workspace accepted a \
                write");
            assert_eq!("note", res!(fs::read_to_string(&note)));
            Ok(())
        })
    }

    /// A carved directory cannot be listed, and nothing can be made in it.
    ///
    /// Asserted rather than merely documented, because these are the costs of
    /// the carve, and a change quietly removing them would have quietly opened
    /// the denied subtree.
    #[test]
    fn a_carved_directory_is_sealed() -> Outcome<()> {
        let f = match kernel_fence("a_carved_directory_is_sealed") {
            Some(f) => f,
            None => return Ok(()),
        };
        own_thread("a_carved_directory_is_sealed", move || {
            let base = res!(fixture("sealed"));
            let ws = base.join("ws");

            // Broken first.
            assert!(res!(fs::read_dir(&ws)).count() > 0);
            res!(fs::write(ws.join("made-before.txt"), "x"));

            let mut plan = res!(f.plan(&spec(&base), &Unfenced::Refuse));
            plan.reach = Reach::Thread; // see `engage`
            let caveats = plan.caveats();
            assert!(caveats.iter().any(|c| c.contains("cannot be listed")),
                "the cost of the carve was not reported: {:?}", caveats);
            assert!(caveats.iter().any(|c| c.contains("invisible")),
                "the after-the-fact child caveat was not reported: {:?}", caveats);
            let applied = res!(plan.apply());
            assert!(applied.fenced);

            assert!(fs::read_dir(&ws).is_err(),
                "a carved directory could still be listed");
            assert!(fs::write(ws.join("made-after.txt"), "x").is_err(),
                "a file could be created directly in a carved directory");
            // A child that existed when the fence was built is still fine.
            assert_eq!("x", res!(fs::read_to_string(ws.join("made-before.txt"))));
            Ok(())
        })
    }

    /// With `net: false`, a TCP connection that worked a moment ago is refused.
    ///
    /// Loopback, and to a listener this test owns, so the result does not depend
    /// on the machine having a route to anywhere.
    #[test]
    fn net_false_stops_tcp() -> Outcome<()> {
        let f = match kernel_fence("net_false_stops_tcp") {
            Some(f) => f,
            None => return Ok(()),
        };
        if let Fence::Linux { abi, .. } = &f {
            if !abi.fences_tcp() {
                println!(
                    "[net_false_stops_tcp] SKIPPED: Landlock ABI {} has no \
                    network rules; they arrived at ABI 4 in Linux 6.7.",
                    abi.level());
                return Ok(());
            }
        }
        own_thread("net_false_stops_tcp", move || {
            let base = res!(fixture("net"));
            // The listener lives on another thread, unfenced, so that what is
            // being tested is the fenced thread's ability to reach it.
            let listener = res!(TcpListener::bind("127.0.0.1:0"));
            let port = res!(listener.local_addr()).port();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    drop(stream);
                }
            });

            // Broken first: unfenced, the connection is made.
            let first = TcpStream::connect(("127.0.0.1", port));
            assert!(first.is_ok(),
                "the test's own listener was unreachable: {:?}", first);
            drop(first);

            res!(engage(&f, &spec(&base)));
            assert!(TcpStream::connect(("127.0.0.1", port)).is_err(),
                "a fenced command with net:false still opened a TCP connection");
            assert!(TcpListener::bind("127.0.0.1:0").is_err(),
                "a fenced command with net:false still bound a TCP port");
            Ok(())
        })
    }

    /// The fence survives `execve`, which is the whole reason it can be applied
    /// by a launcher that then becomes the command.
    #[test]
    fn the_fence_is_inherited_by_a_real_program() -> Outcome<()> {
        let f = match kernel_fence("the_fence_is_inherited_by_a_real_program") {
            Some(f) => f,
            None => return Ok(()),
        };
        let cat = Path::new("/bin/cat");
        if !cat.exists() {
            println!(
                "[the_fence_is_inherited_by_a_real_program] SKIPPED: no \
                /bin/cat on this machine to run inside the fence.");
            return Ok(());
        }
        own_thread("the_fence_is_inherited_by_a_real_program", move || {
            let base = res!(fixture("exec"));
            let inside = base.join("ws/ok.txt");
            let secret = base.join("ws/.daimond/secret.txt");
            let outside = base.join("outside/other.txt");

            // Broken first: unfenced, `cat` reads all three.
            for p in [&inside, &secret, &outside] {
                let out = res!(std::process::Command::new("/bin/cat").arg(p).output());
                assert!(out.status.success(),
                    "cat {} failed before the fence", p.display());
            }

            // The system base is what makes there be a program to run at all.
            let fenced = Fence::Linux {
                abi:     match &f {
                    Fence::Linux { abi, .. }	=> *abi,
                    _							=> Abi::None,
                },
                listing: Listing::Sealed,
                base:    SysBase::Minimal,
            };
            res!(engage(&fenced, &spec(&base)));

            let out = res!(std::process::Command::new("/bin/cat").arg(&inside).output());
            assert!(out.status.success(),
                "the fenced command could not read a file it was granted: {}",
                String::from_utf8_lossy(&out.stderr));
            assert_eq!("ok", String::from_utf8_lossy(&out.stdout));

            for p in [&secret, &outside] {
                let out = res!(std::process::Command::new("/bin/cat").arg(p).output());
                assert!(!out.status.success(),
                    "an exec'd program read {}, so the fence was not inherited",
                    p.display());
            }
            Ok(())
        })
    }

    /// A plan built for a newer ABI than the kernel has is refused, not quietly
    /// applied with the unsupported parts dropped.
    ///
    /// This is the "never silently degrade" rule, and it is the one property
    /// here that cannot be reached by any correct spec: the fence always asks
    /// for exactly what the kernel reported. Asking for more is therefore the
    /// only way to make the kernel answer `PartiallyEnforced` and see what this
    /// code does with that answer. Without this test, a change accepting a
    /// partial result would break nothing else in the suite.
    #[test]
    fn a_partly_applied_fence_is_an_error() -> Outcome<()> {
        let f = match kernel_fence("a_partly_applied_fence_is_an_error") {
            Some(f) => f,
            None => return Ok(()),
        };
        let abi = match &f {
            Fence::Linux { abi, .. } => *abi,
            _ => return Ok(()),
        };
        if abi >= Abi::V9 {
            println!(
                "[a_partly_applied_fence_is_an_error] SKIPPED: this kernel is at \
                ABI {}, which is everything this build knows how to ask for, so \
                there is no way to ask for more and see it refused.",
                abi.level());
            return Ok(());
        }
        own_thread("a_partly_applied_fence_is_an_error", move || {
            let base = res!(fixture("partial"));
            let mut plan = res!(f.plan(&spec(&base), &Unfenced::Refuse));
            plan.reach = Reach::Thread; // see `engage`

            // Broken first: as planned, against the ABI the kernel reported, it
            // applies cleanly. So the refusal below is about the ABI and not
            // about the spec.
            let honest = res!(plan.clone().apply());
            assert!(honest.fenced);

            // Now ask for rights this kernel does not have. Landlock's
            // best-effort mode will drop them and report a partial result, and a
            // partial result must not read as a fence.
            let mut ahead = plan.clone();
            ahead.abi = Abi::V9;
            match ahead.apply() {
                Ok(applied) => return Err(err!(
                    "A fence built for ABI 9 on an ABI {} kernel reported \
                    success ({:?}). Landlock dropped what it could not do, and \
                    this code called the remainder a fence.", abi.level(), applied;
                    Test, Security)),
                Err(e) => {
                    let said = e.msgs().join(" ");
                    assert!(said.contains("only part of the fence"),
                        "the refusal did not say what went wrong: {}", said);
                },
            }
            Ok(())
        })
    }

    /// `permits` agrees with the rules about the interesting places.
    ///
    /// It is only a pre-flight check, so the point is that it does not tell the
    /// caller something the kernel will contradict a moment later.
    #[test]
    fn permits_agrees_with_the_rules() -> Outcome<()> {
        let base = res!(fixture("permits"));
        let plan = res!(planner(Abi::V5).plan(&spec(&base), &Unfenced::Refuse));
        let ws = res!(base.join("ws").canonicalize());

        assert!(plan.permits(&ws.join("ok.txt"), Level::Rw));
        assert!(plan.permits(&ws.join("sub/deep/x.txt"), Level::Rw));
        assert!(plan.permits(&ws.join("refs/note.md"), Level::Ro));
        assert!(!plan.permits(&ws.join("refs/note.md"), Level::Rw));
        assert!(!plan.permits(&ws.join(".daimond/secret.txt"), Level::Ro));
        assert!(!plan.permits(&base.join("outside/other.txt"), Level::Ro));

        // The `..` route into the denied subtree is the classic one, and it is
        // resolved before the comparison rather than after.
        assert!(!plan.permits(&ws.join("sub/../.daimond/secret.txt"), Level::Ro),
            "a `..` path walked into the denied subtree");
        Ok(())
    }
    /// `/dev/null` must be WRITABLE, or nothing that discards output runs.
    ///
    /// This is the shape the whole file exists to catch and did not: the base is
    /// described as "the system paths a program needs in order to be a program",
    /// and it granted the one device every program uses read-only. Every git
    /// command inside the fence died with `fatal: could not open '/dev/null' for
    /// reading and writing`. Nothing in the suite ran a program that WRITES to
    /// it, so a base that could not run git passed every test it had.
    ///
    /// It runs real `git` where there is one, because a write to `/dev/null` by
    /// hand proves the device and the fence agree while the failure this is
    /// written against was a whole tool refusing to start.
    #[test]
    fn a_fenced_command_can_discard_its_output() -> Outcome<()> {
        let f = match kernel_fence("a_fenced_command_can_discard_its_output") {
            Some(f) => f,
            None => return Ok(()),
        };
        own_thread("a_fenced_command_can_discard_its_output", move || {
            let base = res!(fixture("devnull"));
            res!(engage(&f, &spec(&base)));

            // The device itself, opened the way a shell redirection opens it.
            res!(fs::OpenOptions::new().write(true).open("/dev/null")
                .map_err(|e| err!("/dev/null is not writable behind the fence: {}", e;
                    IO, Write)));
            // And read-write, which is what git asks for and what failed.
            res!(fs::OpenOptions::new().read(true).write(true).open("/dev/null")
                .map_err(|e| err!("/dev/null could not be opened read-write: {}", e;
                    IO, Write)));

            // Reading it still works, so the fix did not trade one direction for
            // the other.
            assert_eq!("", res!(fs::read_to_string("/dev/null")));

            // Seeding the random devices stays refused: nothing legitimate writes
            // there, and a write is an attempt to make randomness predictable.
            assert!(fs::OpenOptions::new().write(true).open("/dev/urandom").is_err(),
                "/dev/urandom was writable: the base promoted more than it needed");

            // The tool that could not start. Skipped rather than faked where git
            // is absent, because a claimed proof is worse than an honest gap.
            if let Ok(out) = std::process::Command::new("git")
                .args(["--version"]).output()
            {
                assert!(out.status.success(),
                    "git could not run behind the fence: {}",
                    String::from_utf8_lossy(&out.stderr));
            }
            Ok(())
        })
    }

}
