//! The half of the compartment Landlock cannot express: which system calls the
//! command may make at all.
//!
//! [`crate::fence`] hands the kernel a set of paths and the access permitted at
//! each.  That is the whole of Landlock, and it is genuinely airtight for what
//! it covers -- but it covers *opening a file*, and a process does more to a
//! file than open it.  Two measured escapes follow directly from that, and
//! neither can be closed by any rule `fence.rs` could add:
//!
//! * **Metadata is ungoverned.**  Landlock's `AccessFs` has no right covering
//!   `chmod`, `chown`, `utimensat` or `setxattr`, so none of them is mediated.
//!   Under a full ABI-8 fence all four succeeded on a file outside every root,
//!   and `chmod 777` took a file *inside the denied subtree* from 600 to 777.
//!   The fence stops a command reading a secret; it does not stop the command
//!   stripping the permissions that were protecting that secret from everybody
//!   else.
//! * **The session bus is a way out.**  Landlock does not govern `connect()` to
//!   a pathname unix socket until ABI 9 (Linux 7.1), and this kernel is at
//!   ABI 8.  With `net:false` fully applied, `connect()` to `/run/user/1000/bus`
//!   succeeded and `systemd-run --user … /bin/cat <denied-file>` ran **outside
//!   the fence** and returned the contents.  That is arbitrary unfenced
//!   execution, not a leak at the edge.
//!
//! Seccomp closes both, because both go through a system call whose *number*, or
//! whose *integer argument*, is enough to decide on.  That last clause is the
//! whole shape of this module and its whole limitation: **a seccomp filter
//! cannot dereference a pointer.**  The kernel copies the filter's view of a
//! call from `struct seccomp_data`, which holds the syscall number, the
//! instruction pointer and the six argument registers -- and nothing they point
//! at.  There is no path here, no `sockaddr`, no mode string.  Every decision
//! below is therefore all-or-nothing across the whole filesystem, or it is made
//! on a plain integer.
//!
//! # Default-allow, and what that does not buy
//!
//! This filter names what is refused and permits everything else.  The opposite
//! -- name what is permitted and refuse everything else -- is strictly stronger,
//! and it is the wrong choice here.  A default-deny filter for "any command a
//! build might run" is a filter for `cargo`, `rustc`, `ld`, `node`, `python`,
//! `git`, every build script and every test binary, and the first syscall it
//! missed would be an incomprehensible `SIGSYS` in the middle of somebody's
//! build.  A filter that breaks builds is a filter that gets switched off, and a
//! filter that is switched off protects nothing.
//!
//! So the honest statement of what this achieves: **it removes named capabilities
//! from a command that is otherwise unrestricted at the syscall layer.**  It is
//! not a syscall sandbox.  A kernel bug reachable through an unnamed syscall is
//! reachable through this filter; a syscall added by a future kernel is permitted
//! by default; and anything the deny-list did not think of is allowed.  What it
//! *does* deliver is that the two escapes above, and the third one below, are
//! measurably gone -- and [`Seccomp::holes`] lists the rest.
//!
//! # Order: Landlock first, seccomp last, then `execve`
//!
//! Both restrictions are irreversible and both are inherited across `execve`, so
//! the order is not about undoing anything -- it is about what each still needs
//! to do after it is installed.
//!
//! Landlock's application **opens every granted path** (`PathFd`), so it has real
//! work left when its own rules take hold.  A seccomp filter installed before it
//! would sit underneath that work, and a deny-list that happened to name
//! something the `landlock` crate needed would break the fence rather than the
//! command -- the wrong failure, in the wrong layer, for a reason nobody could
//! read.  This filter needs nothing after itself except `execve`.  So: fence,
//! then filter, then exec.
//!
//! Both also require `no_new_privs`, and neither can be installed without it.
//! `fence.rs` already sets it and hard-errors when the kernel refuses -- and that
//! check is load-bearing here too, because the kernel rejects
//! `SECCOMP_SET_MODE_FILTER` outright for a process without `no_new_privs` and
//! without `CAP_SYS_ADMIN`.  Setting it twice is idempotent, so the two layers do
//! not interfere; [`Filter::apply`] sets it again rather than assuming.
//!
//! # Fails closed
//!
//! There is no waiver here and no degraded mode.  If the architecture is not one
//! this module has a syscall table for, if the filter cannot be compiled, or if
//! the kernel refuses to install it, [`Filter::apply`] returns an error and the
//! launcher must die before `execve`.  A weaker filter is never installed and
//! never reported as success -- the failure this whole file exists to avoid is a
//! compartment that says it is there when it is not.

use oxedyne_fe2o3_core::prelude::*;

use std::collections::BTreeMap;

#[cfg(target_os = "linux")]
use seccompiler::{
    BpfProgram,
    SeccompAction,
    SeccompCmpArgLen,
    SeccompCmpOp,
    SeccompCondition,
    SeccompFilter,
    SeccompRule,
    TargetArch,
};

// ┌───────────────────────────────────────────────────────────────┐
// │ Constants of the Linux ABI                                     │
// └───────────────────────────────────────────────────────────────┘

/// `EPERM`, the answer a refused call returns.
///
/// Written out rather than taken from `libc`, so that this module needs exactly
/// one line added to `Cargo.toml` rather than two.  `EPERM` is 1 on every Linux
/// architecture without exception, and this module refuses to run on an
/// architecture it does not have a table for anyway -- see [`Arch`].
///
/// `EPERM` rather than `ENOSYS` or a quiet success, because a refusal a program
/// can read is worth more than one it cannot.  `chmod: Operation not permitted`
/// tells whoever is looking at the build log what happened; a silent success
/// would leave a script that is not executable and an `exec` failing two steps
/// later for no visible reason.
const EPERM: u32 = 1;

/// `AF_UNIX`, the value of `socket(2)`'s first argument this filter matches on.
///
/// 1 on every Linux architecture.  The kernel reads that argument as an `int`,
/// so the comparison below is a 32-bit one; see [`Filter::compile`] for why that
/// matters rather than being a detail.
const AF_UNIX: u64 = 1;

/// The mode bits a refused `chmod` is refused for, under [`Meta::NoLoosening`].
///
/// Three bits, each of which *adds* reach to somebody who did not have it:
///
/// * `S_ISUID` (`0o4000`) and `S_ISGID` (`0o2000`) -- a program that runs as
///   somebody else.
/// * `S_IWOTH` (`0o0002`) -- world-writable, which is the `chmod 777` of the
///   review's reproduction and the shape of "world-write the home directory".
///
/// What is deliberately *not* here, and why, is at [`Meta::NoLoosening`].  The
/// bits are separate rather than one mask because seccomp's only masking
/// comparison is `(arg & mask) == value`, which cannot express "any of these
/// bits is set" in one condition -- so each bit becomes a rule of its own, and
/// the rules are or-bound.
const LOOSENING: [(u64, &str); 3] = [
    (0o4000,	"set-user-ID"),
    (0o2000,	"set-group-ID"),
    (0o0002,	"world-writable"),
];

// ┌───────────────────────────────────────────────────────────────┐
// │ The architecture, and the syscall table                        │
// └───────────────────────────────────────────────────────────────┘

/// Which syscall numbering this build is filtering.
///
/// An enum with two arms and no fallback, because a syscall filter built from
/// the wrong table is worse than no filter: it would refuse whichever calls
/// happened to share those numbers and permit the ones it meant to refuse, and
/// it would report success either way.  An architecture not listed here gets
/// [`Seccomp::None`] and a refusal, not a guess.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Arch {
    /// x86-64, whose table is its own.
    X86_64,
    /// aarch64, which uses the generic table in `asm-generic/unistd.h` and
    /// therefore has no `chmod`, `chown`, `lchown`, `utime`, `utimes` or
    /// `futimesat` at all -- those are the legacy names, and the generic ABI
    /// dropped them in favour of the `*at` forms.
    Aarch64,
}

impl Arch {

    /// This build's architecture, or `None` if there is no table for it.
    pub fn here() -> Option<Self> {
        if cfg!(target_arch = "x86_64") {
            Some(Self::X86_64)
        } else if cfg!(target_arch = "aarch64") {
            Some(Self::Aarch64)
        } else {
            None
        }
    }

    /// The name the capability strings use.
    pub fn name(&self) -> &'static str {
        match self {
            Self::X86_64	=> "x86_64",
            Self::Aarch64	=> "aarch64",
        }
    }
}

/// What a refused call belongs to, so the report can name a category rather
/// than twenty numbers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Group {
    /// The `chmod` family: permission bits.
    Mode,
    /// The `chown` family: owner and group.
    Owner,
    /// The `utime` family: access and modification timestamps.
    Times,
    /// The `setxattr` and `removexattr` families: extended attributes.
    Xattr,
    /// `file_setattr` and `open_tree_attr`: the inode attribute calls added in
    /// Linux 6.15 and 6.16, which reach the immutable and append-only flags.
    Attr,
    /// `socket(2)`, matched on its address family.
    Socket,
    /// `io_uring_setup`, which is a way of making syscalls that this filter
    /// cannot see.
    Ring,
    /// `ptrace` and the `process_vm_*` pair: reading and writing another
    /// process's memory.
    Poke,
}

impl Group {

    /// The word the capability strings use.
    pub fn word(&self) -> &'static str {
        match self {
            Self::Mode		=> "chmod",
            Self::Owner		=> "chown",
            Self::Times		=> "times",
            Self::Xattr		=> "xattr",
            Self::Attr		=> "fileattr",
            Self::Socket	=> "af-unix",
            Self::Ring		=> "io-uring",
            Self::Poke		=> "ptrace",
        }
    }
}

/// One system call this filter has an opinion about.
///
/// The numbers are written out per architecture rather than taken from
/// `libc::SYS_*`, and that is not stubbornness.  `libc 0.2.189` on
/// `x86_64-unknown-linux-gnu` has no constant for `setxattrat`, `removexattrat`,
/// `open_tree_attr` or `file_setattr` -- four calls that exist on this kernel and
/// three of which change file metadata.  A table built from what `libc` happens
/// to know would have four holes in it and would not say so.  The numbers here
/// are cross-checked against the kernel's own headers by
/// [`tests::the_table_agrees_with_the_kernel_headers`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Sys {
    /// The name, for the report and for the header cross-check.
    pub name:  &'static str,
    /// What it belongs to.
    pub group: Group,
    /// Its number on x86-64, where it exists there.
    pub x86:   Option<i64>,
    /// Its number on the generic ABI that aarch64 uses, where it exists there.
    pub arm:   Option<i64>,
    /// Which argument carries the mode, for the calls [`Meta::NoLoosening`]
    /// inspects.  `None` for everything else.
    pub mode:  Option<u8>,
}

impl Sys {

    /// This call's number on `arch`, or `None` where the architecture has no
    /// such call.
    ///
    /// # Arguments
    /// * `arch` - The numbering to look it up in.
    pub fn number(&self, arch: Arch) -> Option<i64> {
        match arch {
            Arch::X86_64	=> self.x86,
            Arch::Aarch64	=> self.arm,
        }
    }
}

/// Every call this module can refuse.
///
/// Ordered by group so a reader can check a group is complete, which is the
/// review's actual finding: the gap was never one missing number, it was a whole
/// category nobody had handled.
const TABLE: &[Sys] = &[
    // The chmod family. `fchmodat2` arrived in Linux 6.6 and is the one most
    // likely to be missed, because it is the newest and because glibc still
    // routes `chmod` through `fchmodat` on most paths.
    Sys { name: "chmod",			group: Group::Mode,		x86: Some(90),	arm: None,			mode: Some(1) },
    Sys { name: "fchmod",			group: Group::Mode,		x86: Some(91),	arm: Some(52),		mode: Some(1) },
    Sys { name: "fchmodat",			group: Group::Mode,		x86: Some(268),	arm: Some(53),		mode: Some(2) },
    Sys { name: "fchmodat2",		group: Group::Mode,		x86: Some(452),	arm: Some(452),		mode: Some(2) },

    // The chown family. Changing owner needs CAP_CHOWN, so the reachable half is
    // changing *group* to one the user belongs to -- which on a machine with
    // shared groups is exactly how a file becomes readable by a colleague.
    Sys { name: "chown",			group: Group::Owner,	x86: Some(92),	arm: None,			mode: None },
    Sys { name: "fchown",			group: Group::Owner,	x86: Some(93),	arm: Some(55),		mode: None },
    Sys { name: "lchown",			group: Group::Owner,	x86: Some(94),	arm: None,			mode: None },
    Sys { name: "fchownat",			group: Group::Owner,	x86: Some(260),	arm: Some(54),		mode: None },

    // The utime family. Refusing these breaks `cargo` -- see `Meta::Refuse`.
    Sys { name: "utime",			group: Group::Times,	x86: Some(132),	arm: None,			mode: None },
    Sys { name: "utimes",			group: Group::Times,	x86: Some(235),	arm: None,			mode: None },
    Sys { name: "futimesat",		group: Group::Times,	x86: Some(261),	arm: None,			mode: None },
    Sys { name: "utimensat",		group: Group::Times,	x86: Some(280),	arm: Some(88),		mode: None },

    // Extended attributes. `setxattrat` and `removexattrat` arrived in Linux
    // 6.13 and `libc` has no constants for either; leaving them out would leave
    // the group open through its newest members while the report claimed it was
    // shut.
    Sys { name: "setxattr",			group: Group::Xattr,	x86: Some(188),	arm: Some(5),		mode: None },
    Sys { name: "lsetxattr",		group: Group::Xattr,	x86: Some(189),	arm: Some(6),		mode: None },
    Sys { name: "fsetxattr",		group: Group::Xattr,	x86: Some(190),	arm: Some(7),		mode: None },
    Sys { name: "setxattrat",		group: Group::Xattr,	x86: Some(463),	arm: Some(463),		mode: None },
    Sys { name: "removexattr",		group: Group::Xattr,	x86: Some(197),	arm: Some(14),		mode: None },
    Sys { name: "lremovexattr",		group: Group::Xattr,	x86: Some(198),	arm: Some(15),		mode: None },
    Sys { name: "fremovexattr",		group: Group::Xattr,	x86: Some(199),	arm: Some(16),		mode: None },
    Sys { name: "removexattrat",	group: Group::Xattr,	x86: Some(466),	arm: Some(466),		mode: None },

    // The inode attribute calls. `file_setattr` reaches the immutable and
    // append-only flags, which are metadata by any reading of the word and are
    // newer than every list of "the metadata syscalls" written before 2026.
    Sys { name: "open_tree_attr",	group: Group::Attr,		x86: Some(467),	arm: Some(467),		mode: None },
    Sys { name: "file_setattr",		group: Group::Attr,		x86: Some(469),	arm: Some(469),		mode: None },

    // The socket, matched on its family rather than refused outright.
    Sys { name: "socket",			group: Group::Socket,	x86: Some(41),	arm: Some(198),		mode: None },

    // io_uring. Not metadata, and here for a sharper reason: an io_uring ring
    // performs operations -- including `IORING_OP_SETXATTR` and
    // `IORING_OP_FSETXATTR` since Linux 5.19 -- *without issuing the syscall*, so
    // every rule above is bypassable by a program willing to use a ring. Landlock
    // still applies, because io_uring goes through the same VFS path; seccomp does
    // not. Refusing the ring is the only way to make the rest of this file mean
    // what it says.
    Sys { name: "io_uring_setup",	group: Group::Ring,		x86: Some(425),	arm: Some(425),		mode: None },

    // Reading and writing another process's memory. Not in the review, and the
    // same class of defect as the session bus: a command that can write into a
    // process outside the fence has stepped out of the fence. Yama's
    // `ptrace_scope` already restricts this to descendants on a stock Ubuntu, but
    // that is a sysctl the user can change and not a guarantee this code makes.
    // Measured free: a from-scratch `cargo test` makes none of these three calls.
    Sys { name: "ptrace",			group: Group::Poke,		x86: Some(101),	arm: Some(117),		mode: None },
    Sys { name: "process_vm_readv",	group: Group::Poke,		x86: Some(310),	arm: Some(270),		mode: None },
    Sys { name: "process_vm_writev",group: Group::Poke,		x86: Some(311),	arm: Some(271),		mode: None },
];

// ┌───────────────────────────────────────────────────────────────┐
// │ The three decisions the filter forces                          │
// └───────────────────────────────────────────────────────────────┘

/// What happens to the calls that change a file's metadata.
///
/// Three arms rather than a boolean, because the honest answer is a trade and a
/// boolean would hide which side of it was taken.  All three were measured
/// against a from-scratch `cargo test`, a fresh registry unpack and a `git init`
/// / `commit` / `clone` cycle.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Meta {
    /// Refuse every call in [`Group::Mode`], [`Group::Owner`], [`Group::Times`],
    /// [`Group::Xattr`] and [`Group::Attr`].
    ///
    /// Airtight against the review's §1.2, and it **breaks `cargo`**.  Measured:
    /// unpacking a `.crate` from the registry fails with `failed to set mtime`
    /// (the `utime` family) and then, with the timestamps allowed, with `failed
    /// to set permissions to 644` (the `chmod` family).  `git init` fails at
    /// `could not set 'core.filemode'`.  Correct, and unusable for a command the
    /// user is watching -- offered for a caller who knows their command needs
    /// none of it.
    Refuse,
    /// Refuse the calls that *loosen* protection, and permit the rest.
    ///
    /// The default, and the only arm that is both a real answer to §1.2 and
    /// survives a build.  It rests on the one thing seccomp can genuinely
    /// inspect: `chmod`'s mode is a plain integer, so the filter can refuse a
    /// mode that sets set-user-ID, set-group-ID or the world-write bit and
    /// permit everything else.
    ///
    /// Measured: `chmod 777`, `chmod 666`, `chmod 4755`, `chmod 2755` and
    /// `chmod o+w` are refused; `chmod 755`, `644`, `664`, `775`, `700` and `400`
    /// are permitted, which is every mode a from-scratch `cargo test` and a `git`
    /// cycle ask for.  `chown`, the extended attributes and the inode attribute
    /// calls are still refused outright, because nothing a build does needs them.
    ///
    /// What it does **not** close, and this is the price:
    ///
    /// * The `utime` family is permitted, because `cargo` cannot unpack a crate
    ///   without it.  A command can therefore rewrite the timestamps of any file
    ///   it can name, anywhere on the machine.
    /// * `chmod 644` on a private key is permitted -- it adds no *write*, so the
    ///   filter has no grounds to refuse it, and refusing it would refuse the
    ///   mode `cargo` sets on every file it unpacks.  Making a secret readable to
    ///   other *local* accounts is still possible.
    /// * `chmod g+w` is permitted, for the same reason: `git` sets `0664` and
    ///   `0775` under a `umask` of `002`, which is the Ubuntu default.  On a
    ///   machine where the user's primary group has other members, that is a real
    ///   grant.
    NoLoosening,
    /// Leave the metadata calls alone.
    ///
    /// Here so that a caller who has hit the trade above can say so in the
    /// source, and so that the difference shows up in [`Filter::caps`] rather
    /// than being invisible.  §1.2 is wide open under this arm.
    Allow,
}

impl Meta {

    /// The word the capability strings use.
    pub fn word(&self) -> &'static str {
        match self {
            Self::Refuse		=> "refused",
            Self::NoLoosening	=> "no-loosening",
            Self::Allow			=> "allowed",
        }
    }
}

/// What happens to `socket(AF_UNIX, …)`.
///
/// The answer to the review's §1.3, and the reason it is a separate decision is
/// that it is only ever right when the fence has already refused the network.  A
/// command allowed to reach the internet gains nothing from being denied the
/// session bus, and denying it would break tools that legitimately use a local
/// socket to reach a daemon.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Unix {
    /// Refuse the creation of any `AF_UNIX` socket.
    ///
    /// **What this covers**: every `connect()` and `bind()` to a pathname or
    /// abstract unix socket made by the command or anything it starts, because
    /// all of them need a socket first and `socket(2)`'s first argument is a
    /// plain integer the filter can read.  Measured: `systemd-run --user --pipe
    /// --wait /bin/cat <file>` fails at "Failed to connect to user scope bus" and
    /// the file is not read.
    ///
    /// **What it does not cover**, and none of this is hypothetical:
    ///
    /// * `socketpair(2)` still works.  It is a different syscall, it makes an
    ///   *anonymous* connected pair with no name in any namespace, and it cannot
    ///   reach the bus or anything else.  It is also load-bearing: a from-scratch
    ///   `cargo test` makes six `socketpair(AF_UNIX, …)` calls, so refusing it
    ///   would break every build.
    /// * A file descriptor for an already-connected socket, inherited across
    ///   `execve` or received over `SCM_RIGHTS`, keeps working.  Seccomp governs
    ///   the act of creating a socket, not the use of one that exists -- the same
    ///   shape as Landlock governing `open` rather than `read`.  The launcher
    ///   passes the child three descriptors and no others, so the reachable
    ///   version of this is a command that was *given* a socket, which is a
    ///   decision made elsewhere.
    /// * `connect()` itself is untouched.  It has to be: the address is behind a
    ///   pointer, so a filter on `connect` could only refuse all of it, and TCP
    ///   is Landlock's job from ABI 4.
    Refuse,
    /// Leave `AF_UNIX` alone, and with it §1.3.
    ///
    /// Kept as an arm and chosen by nothing.  It is here so that an operator
    /// setting for "this machine's builds need the container daemon" has a shape
    /// to take, and so that the choice is visible in the type rather than
    /// implied by its absence.  [`Spec::for_command`] records why it is not the
    /// default and what was measured when it was.
    Allow,
}

impl Unix {

    /// The word the capability strings use.
    pub fn word(&self) -> &'static str {
        match self {
            Self::Refuse	=> "refused",
            Self::Allow		=> "allowed",
        }
    }
}

/// Whether the command may make syscalls the filter cannot see.
///
/// A ring submits operations that the kernel performs on its own worker's
/// behalf; seccomp never sees them.  `IORING_OP_SETXATTR` and
/// `IORING_OP_FSETXATTR` have existed since Linux 5.19, so a command with a ring
/// can do the very thing [`Meta`] refuses.  There is no partial answer: either
/// the ring is refused or every rule in this file is advisory.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Ring {
    /// Refuse `io_uring_setup`.
    ///
    /// `EPERM` like everything else here, rather than the `ENOSYS` that would
    /// read as "this kernel has no io_uring".  `ENOSYS` is the friendlier answer
    /// for a probe -- libuv calls `io_uring_setup` at start-up and falls back to
    /// its thread pool -- but it needs a second BPF program running on every
    /// syscall to say it, since a program carries one errno.  Measured that the
    /// friendlier answer is not needed: `node` v20 and a from-scratch `cargo
    /// test` are both unaffected by `EPERM`.
    Refuse,
    /// Permit it, and accept that [`Meta`] is then advisory.
    Allow,
}

/// Whether the command may read or write another process's memory.
///
/// The same class of defect as the session bus, and not in the review: writing
/// into a process outside the fence is a way out of the fence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Poke {
    /// Refuse `ptrace`, `process_vm_readv` and `process_vm_writev`.  Measured
    /// free: a from-scratch `cargo test` makes none of them.  Breaks `gdb`,
    /// `strace` and `rr` run *inside* a fenced command.
    Refuse,
    /// Permit them, and rely on Yama's `ptrace_scope` -- a sysctl, not a
    /// guarantee this code makes.
    Allow,
}

/// What the filter should refuse.
///
/// Four independent decisions rather than a level, because they are genuinely
/// independent: the network setting decides [`Unix`], the command decides
/// [`Meta`], and neither says anything about the other two.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Spec {
    /// What happens to the metadata calls.
    pub meta: Meta,
    /// What happens to `AF_UNIX` sockets.
    pub unix: Unix,
    /// What happens to `io_uring`.
    pub ring: Ring,
    /// What happens to `ptrace` and its relatives.
    pub poke: Poke,
}

impl Spec {

    /// The spec the hand uses for every command, with nothing to decide.
    ///
    /// # Why `AF_UNIX` is refused whatever the network decision was
    ///
    /// This took an argument once -- `net` -- and refused `AF_UNIX` only when the
    /// fence refused the network, on the reasoning that refusing the bus buys
    /// nothing from a command that may reach outward anyway.  That reasoning is
    /// wrong, and it was measured wrong: with `net:true`, the whole fence in
    /// force and the filter installed,
    /// `systemd-run --user --pipe --wait /bin/cat <denied file>` **returned the
    /// file's contents**.
    ///
    /// The escape is not a network escape.  It is a *filesystem* escape wearing a
    /// socket: the bus starts a process that Landlock never bound, and that
    /// process reads a path this fence denies.  Whether the command was allowed
    /// to fetch a crate has nothing to do with it.  The same socket reaches
    /// `ssh-agent`, which can sign with the user's keys without the key ever
    /// being read, and that is equally unrelated to the network decision.
    ///
    /// `fence.rs` scopes *abstract* unix sockets unconditionally from ABI 6, so
    /// refusing the pathname ones unconditionally is what makes the two layers
    /// agree rather than what makes them differ.
    ///
    /// The cost is real and is named in [`Unix::Refuse`] and in
    /// [`Filter::holes`]: a command that legitimately wants a local socket --
    /// a database, a container daemon, X11, an `ssh-agent`-authenticated fetch --
    /// cannot have one.  Measured against what commands actually do here: a
    /// from-scratch `cargo build` succeeds behind this spec, because `cargo`,
    /// `rustc` and `ld` use `socketpair`, which is a different call and is left
    /// alone.
    pub fn for_command() -> Self {
        Self {
            meta: Meta::NoLoosening,
            unix: Unix::Refuse,
            ring: Ring::Refuse,
            poke: Poke::Refuse,
        }
    }
}

impl Default for Spec {

    /// The strictest spec that still runs a build.
    fn default() -> Self {
        Self::for_command()
    }
}

/// How much of the process the filter binds to.
///
/// Mirrors [`crate::fence::Reach`] deliberately and is a separate type on
/// purpose: this module has no other dependency on `fence`, so it can be tested,
/// reviewed and replaced on its own.  If the two are ever merged, this is the
/// one to delete.
///
/// [`Reach::Thread`] exists for the same reason it does there -- a filter is
/// irreversible, so a test that installed one process-wide would filter every
/// test that had not run yet.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reach {
    /// Every thread of the process, through seccomp's `TSYNC` flag.  What the
    /// launcher uses.
    Process,
    /// The calling thread only.
    Thread,
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The mechanism                                                  │
// └───────────────────────────────────────────────────────────────┘

/// Whether this machine can filter system calls at all.
///
/// Shaped like [`crate::fence::Fence`], and for the same reason: the page shows
/// the user what is in force, and "no answer yet" and "no filter" must not look
/// alike.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Seccomp {
    /// Seccomp-BPF is available, and this is the syscall numbering in use.
    Linux {
        /// Which table the rules are built from.
        arch: Arch,
    },
    /// No filter is available, and this is why.
    None {
        /// The sentence explaining what is missing.
        why: String,
    },
}

impl Seccomp {

    /// Asks the running machine, rather than reading a version number.
    ///
    /// The probe is a real installation: a throwaway thread compiles a filter
    /// with no rules and an `Allow` default and installs it on itself.  If that
    /// succeeds, seccomp-BPF works here; if it does not, the reason is the
    /// kernel's own and is carried into [`Seccomp::None::why`].  A cheaper check
    /// -- reading `/proc/sys/kernel/seccomp/actions_avail` -- says the feature is
    /// compiled in, which is not the same as saying a filter will install.
    ///
    /// The thread dies immediately afterwards, taking the no-op filter with it.
    /// `no_new_privs` is set on that thread only; it is a per-thread flag.
    pub fn detect() -> Self {
        #[cfg(target_os = "linux")]
        {
            let arch = match Arch::here() {
                Some(a) => a,
                None => return Self::None {
                    why: fmt!(
                        "This build is for an architecture the hand has no \
                        syscall table for, so it cannot refuse a system call by \
                        number. A table built from the wrong architecture would \
                        refuse the wrong calls and report success, so none was \
                        guessed."),
                },
            };
            match std::thread::spawn(probe).join() {
                Ok(Ok(())) => Self::Linux { arch },
                Ok(Err(e)) => Self::None {
                    why: fmt!(
                        "This kernel refused to install a system-call filter: \
                        {}. Seccomp-BPF needs CONFIG_SECCOMP_FILTER, which has \
                        been standard since Linux 3.17.", e),
                },
                Err(_) => Self::None {
                    why: fmt!(
                        "The thread that was to probe for system-call filtering \
                        did not come back, so the hand cannot say whether a \
                        filter would install."),
                },
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            Self::None {
                why: fmt!(
                    "System-call filtering here is Linux's seccomp-BPF, and this \
                    is not Linux. The equivalents -- a sandbox profile on macOS, \
                    a Job Object and an AppContainer SID on Windows -- are the \
                    same ones `fence` has no arm for yet."),
            }
        }
    }

    /// The mechanisms actually available, for [`crate::wire::Resp::Hello`].
    ///
    /// `seccomp:none` rather than an empty list where there is nothing, for the
    /// reason [`crate::fence::Fence::caps`] gives: silence reads as "not asked".
    pub fn caps(&self) -> Vec<String> {
        match self {
            Self::Linux { arch } => vec![
                fmt!("seccomp:bpf"),
                fmt!("seccomp:arch-{}", arch.name()),
            ],
            Self::None { .. } => vec![fmt!("seccomp:none")],
        }
    }

    /// What a filter on this machine cannot cover, whatever the spec says.
    ///
    /// Distinct from [`Filter::holes`], which is about the spec that was chosen.
    /// These hold for every filter this module can build, and every one of them
    /// was measured rather than inferred.
    pub fn holes(&self) -> Vec<String> {
        match self {
            Self::Linux { arch } => vec![
                fmt!(
                    "This is a deny-list, so everything it does not name is \
                    permitted. It removes named capabilities from a command; it \
                    is not a syscall sandbox. A syscall added by a future kernel \
                    is permitted by default, and so is anything the list did not \
                    think of. The alternative -- naming what is allowed and \
                    refusing the rest -- is strictly stronger and would have to \
                    be right about every syscall cargo, rustc, ld, node, python \
                    and every build script make; the first one it missed would be \
                    a SIGSYS in the middle of a build, and a filter that breaks \
                    builds is a filter that gets turned off."),
                fmt!(
                    "A filter cannot follow a pointer. The kernel shows it the \
                    syscall number and the six argument registers and nothing \
                    they point at, so there is no path here, no sockaddr and no \
                    filename. Every rule is therefore all-or-nothing across the \
                    whole filesystem, or it is made on a plain integer. This is \
                    why a refused chmod is refused everywhere rather than only \
                    inside the denied subtree, and why the fence and the filter \
                    have to be two different mechanisms."),
                fmt!(
                    "The filter governs making a thing, not using one that \
                    exists. A socket connected before it was installed keeps \
                    working, and so does one received over SCM_RIGHTS. The same \
                    caveat Landlock carries about open file descriptors, for the \
                    same reason."),
                fmt!(
                    "The rules are built for {} only, and a program with a \
                    different personality is killed rather than filtered. The \
                    compiled filter checks seccomp_data.arch first and answers \
                    KILL_PROCESS on a mismatch, so a 32-bit binary run inside a \
                    fenced command dies with no output rather than escaping \
                    through the compatibility ABI, whose syscall numbers are \
                    different ones entirely. That fails closed, and it is a real \
                    behaviour: a build that execs a 32-bit helper will not work \
                    behind this filter.", arch.name()),
                fmt!(
                    "The mode a file is created with is not filtered. open(2) \
                    with O_CREAT, mkdir(2) and mknod(2) all carry a mode, and \
                    none is inspected -- the umask usually masks the loose bits \
                    off, but a command that sets its own umask to 0 can create a \
                    world-writable file. What is closed is changing the mode of a \
                    file that already exists, which is the escape that was \
                    measured; creating a loose file inside the fence is a smaller \
                    thing than loosening one outside it."),
            ],
            Self::None { .. } => vec![fmt!(
                "Everything a system call can do. There is no filter on this \
                machine, so the metadata calls are ungoverned and the session bus \
                is reachable -- which on a kernel below Landlock ABI 9 means the \
                fence can be stepped out of entirely.")],
        }
    }

    /// The sentence a refusal carries, in the voice the file tools already use.
    ///
    /// # Arguments
    /// * `what` - What was being attempted, named so the model can recover.
    pub fn refusal(&self, what: &str) -> String {
        match self {
            Self::Linux { .. } => fmt!(
                "{} was refused, although this machine can filter system calls. \
                That is a bug: the filter should have been installed instead.",
                what),
            Self::None { why } => fmt!(
                "{} was refused because the hand cannot filter system calls on \
                this machine. {} Without that filter a fenced command can change \
                the permissions of any file on this machine, including the ones \
                the fence exists to protect, and can reach the session bus, \
                through which it can start a process that is not fenced at all. \
                Running it anyway would mean the compartment was a claim rather \
                than a fact, so it was not run.", what, why),
        }
    }

    /// Compiles the filter, without installing anything.
    ///
    /// Separated from [`Filter::apply`] for the reason
    /// [`crate::fence::Fence::plan`] gives: a spec that cannot be honoured must
    /// fail in the hand's own process, where the answer can still become a
    /// [`crate::wire::Resp::Refused`] the page can show, rather than in the
    /// launcher, where the only remaining move is to die.
    ///
    /// # Arguments
    /// * `spec` - What to refuse.
    ///
    /// # Returns
    /// A compiled filter, or an error naming what made it impossible.  There is
    /// no waiver arm: a machine that cannot filter gets a refusal.
    pub fn plan(&self, spec: &Spec) -> Outcome<Filter> {
        match self {
            Self::Linux { arch } => {
                let refused = refusals(*arch, spec);
                if refused.is_empty() {
                    return Err(err!(
                        "The system-call filter would refuse nothing, so \
                        installing it would only add a claim. Either name \
                        something to refuse or do not ask for a filter.";
                        Invalid, Input, Security));
                }
                #[cfg(target_os = "linux")]
                {
                    let prog = res!(Filter::compile(*arch, spec, &refused));
                    Ok(Filter {
                        arch:  *arch,
                        spec:  *spec,
                        reach: Reach::Process,
                        refused,
                        prog,
                    })
                }
                // Unreachable rather than merely unlikely: `detect` only ever
                // builds `Linux` under this same cfg. Written out anyway, so the
                // arm compiles on the two platforms `fence::Fence` already has
                // declared-but-unbuilt arms for.
                #[cfg(not(target_os = "linux"))]
                {
                    Err(err!(
                        "System-call filtering here is Linux's seccomp-BPF, and \
                        this build is not for Linux, so the filter could not be \
                        compiled.";
                        Unimplemented, Security))
                }
            },
            Self::None { .. } => Err(err!(
                "{}", self.refusal("This command");
                Unimplemented, Security, Unauthorised)),
        }
    }
}

/// Which calls a spec refuses, in table order.
///
/// # Arguments
/// * `arch` - The numbering, so a call absent on this architecture is dropped.
/// * `spec` - What to refuse.
fn refusals(arch: Arch, spec: &Spec) -> Vec<&'static Sys> {
    TABLE.iter()
        .filter(|s| s.number(arch).is_some())
        .filter(|s| match s.group {
            Group::Mode => match spec.meta {
                Meta::Refuse		=> true,
                // Still listed: the rule is narrower, not absent.
                Meta::NoLoosening	=> true,
                Meta::Allow			=> false,
            },
            Group::Owner | Group::Times | Group::Xattr | Group::Attr => match spec.meta {
                Meta::Refuse		=> true,
                // The timestamps are the one group that has to survive, because
                // `cargo` cannot unpack a crate without them. See `Meta`.
                Meta::NoLoosening	=> s.group != Group::Times,
                Meta::Allow			=> false,
            },
            Group::Socket	=> spec.unix == Unix::Refuse,
            Group::Ring		=> spec.ring == Ring::Refuse,
            Group::Poke		=> spec.poke == Poke::Refuse,
        })
        .collect()
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The compiled filter                                            │
// └───────────────────────────────────────────────────────────────┘

/// A compiled BPF program and everything that went into it.
///
/// Inspectable before it is installed, for the reason [`crate::fence::Plan`] is:
/// the journal records it, the page can show it, and a test can assert on it.
#[derive(Clone, Debug)]
pub struct Filter {
    /// The numbering the rules were built for.
    pub arch:    Arch,
    /// What was asked for.
    pub spec:    Spec,
    /// How much of the process it will bind to.
    pub reach:   Reach,
    /// The calls it refuses, in table order.
    pub refused: Vec<&'static Sys>,
    /// The compiled program.
    #[cfg(target_os = "linux")]
    prog:        BpfProgram,
    /// A placeholder so the struct exists off Linux, where nothing can build one.
    #[cfg(not(target_os = "linux"))]
    prog:        (),
}

impl Filter {

    /// How many BPF instructions the kernel will run per system call.
    ///
    /// Worth reporting: this program runs on **every** syscall the command
    /// makes, and the kernel's ceiling is 4096 instructions.  A build that got
    /// slower after a rule was added would want this number to look at.
    pub fn instructions(&self) -> usize {
        #[cfg(target_os = "linux")]
        {
            self.prog.len()
        }
        #[cfg(not(target_os = "linux"))]
        {
            0
        }
    }

    /// The capability strings for the journal and the page.
    ///
    /// Named by group rather than by syscall, because twenty numbers is not a
    /// thing a user can check and "chown is refused" is.
    pub fn caps(&self) -> Vec<String> {
        let mut out = vec![
            fmt!("seccomp:bpf"),
            fmt!("seccomp:arch-{}", self.arch.name()),
        ];
        for g in [
            Group::Mode,
            Group::Owner,
            Group::Times,
            Group::Xattr,
            Group::Attr,
            Group::Socket,
            Group::Ring,
            Group::Poke,
        ] {
            if !self.refused.iter().any(|s| s.group == g) {
                continue;
            }
            match g {
                Group::Mode => out.push(match self.spec.meta {
                    Meta::NoLoosening	=> fmt!("seccomp:chmod-no-loosening"),
                    _					=> fmt!("seccomp:no-chmod"),
                }),
                other => out.push(fmt!("seccomp:no-{}", other.word())),
            }
        }
        out
    }

    /// What this spec leaves open, as opposed to what the mechanism cannot do.
    ///
    /// The counterpart of [`crate::fence::Plan::caveats`]: these exist because of
    /// the choices in *this* [`Spec`], and a different spec would have different
    /// ones.
    pub fn holes(&self) -> Vec<String> {
        let mut out = Vec::new();
        match self.spec.meta {
            Meta::NoLoosening => {
                out.push(fmt!(
                    "A command can still change a file's permissions anywhere it \
                    can name, as long as the new mode grants no world write and \
                    no set-user-ID or set-group-ID. chmod 777 is refused; chmod \
                    644 on a private key is not, because it adds no write and \
                    because 644 is the mode cargo sets on every file it unpacks. \
                    chmod g+w is not refused either, since git writes 0664 and \
                    0775 under the default Ubuntu umask -- so on a machine whose \
                    users share a primary group, that is a real grant."));
                out.push(fmt!(
                    "A command can still rewrite any file's timestamps, anywhere \
                    on the machine. The utime family is permitted because cargo \
                    cannot unpack a crate from the registry without it -- \
                    measured: the unpack fails with \"failed to set mtime\". This \
                    is the clearest place where keeping builds working cost \
                    coverage."));
            },
            Meta::Allow => out.push(fmt!(
                "The metadata calls are not filtered at all under this spec, so \
                a command can chmod, chown, retime and relabel any file it can \
                name -- including files inside the subtree the fence denies, \
                which Landlock does not mediate either. This is the state the \
                review measured.")),
            Meta::Refuse => out.push(fmt!(
                "The metadata calls are refused outright, which is airtight and \
                breaks cargo: unpacking a crate from the registry fails at \
                \"failed to set mtime\" and then at \"failed to set permissions \
                to 644\", and git init fails at \"could not set \
                'core.filemode'\".")),
        }
        if self.spec.unix == Unix::Allow {
            out.push(fmt!(
                "AF_UNIX sockets are permitted under this spec, so the session \
                bus is reachable. On a kernel below Landlock ABI 9 that is a way \
                out of the fence entirely, not a leak at its edge: systemd-run \
                --user starts a process the fence does not apply to. This is \
                correct only where the command may reach the network anyway."));
        }
        if self.spec.ring == Ring::Allow {
            out.push(fmt!(
                "io_uring is permitted under this spec, which makes every rule \
                above advisory. A ring performs operations without issuing the \
                syscall, and IORING_OP_SETXATTR and IORING_OP_FSETXATTR have \
                existed since Linux 5.19, so a command with a ring can do what \
                the metadata rules refuse. Landlock still applies to a ring; this \
                filter does not."));
        }
        if self.spec.poke == Poke::Allow {
            out.push(fmt!(
                "ptrace and the process_vm_ pair are permitted under this spec, \
                so a command can read and write the memory of another process \
                running as the same user -- which is a way out of the fence, in \
                the same class as the session bus. Yama's ptrace_scope limits it \
                to descendants on a stock Ubuntu, but that is a sysctl and not a \
                guarantee."));
        }
        out
    }

    /// What the caller should be told about the shape of what they asked for.
    ///
    /// The costs, rather than the gaps: things that will visibly not work.
    pub fn caveats(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.spec.meta == Meta::Refuse {
            out.push(fmt!(
                "This command cannot change any file's permissions, owner, \
                timestamps or extended attributes. A build that unpacks an \
                archive, or that runs cargo against a registry it has not already \
                unpacked, will fail part-way through with \"Operation not \
                permitted\"."));
        }
        if self.spec.meta == Meta::NoLoosening {
            out.push(fmt!(
                "chmod works for ordinary modes and is refused for a mode that \
                would make a file world-writable, set-user-ID or set-group-ID. A \
                build doing that on purpose -- some install steps do -- will fail \
                with \"Operation not permitted\" at that step and nowhere else."));
        }
        if self.spec.unix == Unix::Refuse {
            out.push(fmt!(
                "This command cannot open a unix socket, so it cannot reach the \
                session bus, ssh-agent, a running database on a local socket, or \
                the display server. socketpair still works, which is what builds \
                actually use. Name resolution through systemd-resolved's socket \
                does not, although the fence has already refused the network in \
                every case where this setting applies."));
        }
        if self.spec.poke == Poke::Refuse {
            out.push(fmt!(
                "This command cannot use ptrace, so gdb, strace and rr will not \
                run inside it."));
        }
        out.push(fmt!(
            "The filter is built for {} and kills anything with a different \
            personality, so a 32-bit helper binary will not run inside this \
            command.", self.arch.name()));
        out
    }

    /// Installs the filter on **the current process**, then reports what took
    /// hold.
    ///
    /// # Where this must be called
    ///
    /// In the launcher, after [`crate::fence::Plan::apply`] and immediately
    /// before `execve`.  A seccomp filter is inherited across `execve` and cannot
    /// be removed, so the launcher is the only place it can go -- and it goes
    /// *after* Landlock because Landlock still has to open every granted path
    /// after its own rules take hold, whereas this has nothing left to do.  See
    /// the module documentation.
    ///
    /// # Returns
    /// What was installed, or an error.  There is no partial success to report:
    /// the kernel either takes the whole program or none of it.
    pub fn apply(&self) -> Outcome<Enforced> {
        #[cfg(target_os = "linux")]
        {
            let outcome = match self.reach {
                Reach::Process	=> seccompiler::apply_filter_all_threads(&self.prog),
                Reach::Thread	=> seccompiler::apply_filter(&self.prog),
            };
            if let Err(e) = outcome {
                return Err(err!(
                    "The kernel refused to install the system-call filter ({}), \
                    so the two things Landlock cannot refuse -- changing a file's \
                    permissions anywhere on this machine, and reaching the \
                    session bus to start a process outside the fence -- would \
                    both have been available. The command was not run. Note that \
                    a filter needs no_new_privs, which the fence sets and \
                    hard-errors on; if that failed, this is where it shows.", e;
                    Security, System));
            }
            Ok(Enforced {
                arch:     self.arch,
                filtered: true,
                caps:     self.caps(),
                refused:  self.refused.iter().map(|s| fmt!("{}", s.name)).collect(),
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err(err!(
                "There is no system-call filter to install on this platform, and \
                a fence without one is not a compartment on any kernel below \
                Landlock ABI 9. Nothing was run.";
                Unimplemented, Security))
        }
    }

    /// Turns the spec into a BPF program.
    ///
    /// The filter is default-allow: `mismatch_action` is `Allow`, so a syscall
    /// not named here is permitted, and `match_action` is `Errno(EPERM)`.  A
    /// syscall in the map with an empty rule vector always matches, which is how
    /// a whole call is refused; a syscall with rules matches only if one of them
    /// does, which is how [`Meta::NoLoosening`] and [`Unix::Refuse`] refuse a
    /// call for some arguments and permit it for others.
    ///
    /// # Arguments
    /// * `arch` - The numbering.
    /// * `spec` - What to refuse.
    /// * `refused` - The calls, already filtered to this architecture.
    #[cfg(target_os = "linux")]
    fn compile(arch: Arch, spec: &Spec, refused: &[&'static Sys]) -> Outcome<BpfProgram> {
        let target = match arch {
            Arch::X86_64	=> TargetArch::x86_64,
            Arch::Aarch64	=> TargetArch::aarch64,
        };

        // One program, one errno. A program carries a single `match_action`, so
        // every refusal here answers `EPERM`; see `Ring::Refuse` for the one
        // place a different errno would have been kinder and why it is not worth
        // a second program running on every syscall the command makes.
        let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();

        for sys in refused {
            let n = match sys.number(arch) {
                Some(n) => n,
                // Unreachable: `refusals` filtered on exactly this. Kept as a
                // refusal rather than an unwrap, because a table edit that
                // introduced it must not become a panic in a launcher.
                None => return Err(err!(
                    "The system-call table has no number for {} on {}, although \
                    it was selected for refusal.", sys.name, arch.name();
                    Bug, Mismatch)),
            };
            match (sys.group, spec.meta, sys.mode) {
                // The narrow chmod rule: refuse only a mode that loosens.
                (Group::Mode, Meta::NoLoosening, Some(idx)) => {
                    let mut chain = Vec::with_capacity(LOOSENING.len());
                    for (bit, _) in LOOSENING {
                        // Dword, not Qword. The kernel reads `mode` as a
                        // `umode_t` and every bit of interest is below 32, so the
                        // low word is exactly what it acts on; comparing the full
                        // register would be no stronger and would cost two more
                        // instructions per condition.
                        let cond = match SeccompCondition::new(
                            idx,
                            SeccompCmpArgLen::Dword,
                            SeccompCmpOp::MaskedEq(bit),
                            bit,
                        ) {
                            Ok(c) => c,
                            Err(e) => return Err(err!(
                                "The mode condition for {} could not be built: \
                                {}", sys.name, e; Bug, Invalid)),
                        };
                        match SeccompRule::new(vec![cond]) {
                            Ok(r) => chain.push(r),
                            Err(e) => return Err(err!(
                                "The mode rule for {} could not be built: {}",
                                sys.name, e; Bug, Invalid)),
                        }
                    }
                    rules.insert(n, chain);
                },
                // The socket rule: refuse only `AF_UNIX`.
                (Group::Socket, _, _) => {
                    // Dword here is not an optimisation, it is the correct
                    // comparison and a Qword one would be a hole. `socket(2)`
                    // takes an `int`, so the kernel looks at the low 32 bits of
                    // the register and ignores the rest; a 64-bit equality test
                    // against 1 would fail to match a caller passing
                    // 0x1_0000_0001, which the kernel would still read as
                    // AF_UNIX.
                    let cond = match SeccompCondition::new(
                        0,
                        SeccompCmpArgLen::Dword,
                        SeccompCmpOp::Eq,
                        AF_UNIX,
                    ) {
                        Ok(c) => c,
                        Err(e) => return Err(err!(
                            "The AF_UNIX condition could not be built: {}", e;
                            Bug, Invalid)),
                    };
                    match SeccompRule::new(vec![cond]) {
                        Ok(r) => { rules.insert(n, vec![r]); },
                        Err(e) => return Err(err!(
                            "The AF_UNIX rule could not be built: {}", e;
                            Bug, Invalid)),
                    }
                },
                // Everything else: the whole call, whatever its arguments.
                _ => { rules.insert(n, Vec::new()); },
            }
        }

        let filter = match SeccompFilter::new(
            rules,
            SeccompAction::Allow,
            SeccompAction::Errno(EPERM),
            target,
        ) {
            Ok(f) => f,
            Err(e) => return Err(err!(
                "The system-call filter could not be assembled: {}", e;
                Bug, Invalid, Security)),
        };
        match BpfProgram::try_from(filter) {
            Ok(p) => Ok(p),
            Err(e) => Err(err!(
                "The system-call filter could not be compiled to BPF: {}. The \
                kernel's ceiling is 4096 instructions.", e;
                Bug, Invalid, Security)),
        }
    }
}

/// What actually took hold, as opposed to what was asked for.
///
/// Kept apart from [`Filter`] for the reason [`crate::fence::Applied`] is: a
/// filter is a wish and this is the answer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Enforced {
    /// The numbering the rules were built for.
    pub arch:     Arch,
    /// Whether a filter is in force at all.  Never false on a success.
    pub filtered: bool,
    /// The capability strings for the journal and the page.
    pub caps:     Vec<String>,
    /// The calls refused, by name, for the journal.
    pub refused:  Vec<String>,
}

/// Installs a no-op filter on the calling thread, to find out whether one can be.
///
/// A program with no rules compiles to the architecture guard and a single
/// `Allow`, which is four instructions and refuses nothing.  Installing it is the
/// only honest way to answer "would a filter install here", and it is why
/// [`Seccomp::detect`] runs this on a thread that is about to die.
#[cfg(target_os = "linux")]
fn probe() -> Outcome<()> {
    let arch = match Arch::here() {
        Some(Arch::X86_64)	=> TargetArch::x86_64,
        Some(Arch::Aarch64)	=> TargetArch::aarch64,
        None => return Err(err!(
            "No syscall table for this architecture."; Unimplemented)),
    };
    // `Allow` as the default and `Trap` as the on-match, because seccompiler
    // refuses a filter whose two actions are the same. With no rules, nothing
    // ever matches, so `Trap` is unreachable.
    let filter = match SeccompFilter::new(
        BTreeMap::new(),
        SeccompAction::Allow,
        SeccompAction::Trap,
        arch,
    ) {
        Ok(f) => f,
        Err(e) => return Err(err!("{}", e; Bug, Invalid)),
    };
    let prog = match BpfProgram::try_from(filter) {
        Ok(p) => p,
        Err(e) => return Err(err!("{}", e; Bug, Invalid)),
    };
    match seccompiler::apply_filter(&prog) {
        Ok(()) => Ok(()),
        Err(e) => Err(err!("{}", e; System, Security)),
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
mod tests {
    use super::*;

    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        process::Command,
    };

    /// Where the fixtures go.
    ///
    /// Under the home cache and never `/tmp`: that is a tmpfs here, its pages are
    /// charged to whoever wrote them, and filling it has taken this machine down
    /// before.
    fn root() -> Outcome<PathBuf> {
        let home = match std::env::var("HOME") {
            Ok(h) => h,
            Err(e) => return Err(err!(
                "The seccomp tests need HOME to know where to put fixtures: {}", e;
                Test, Configuration)),
        };
        Ok(PathBuf::from(home).join(".cache/daimond-hand-seccomp-tests"))
    }

    /// A fresh directory with one 600 file in it, standing in for the denied
    /// subtree the review's reproduction used.
    ///
    /// # Arguments
    /// * `name` - A name unique to the calling test, so tests do not share state.
    fn fixture(name: &str) -> Outcome<PathBuf> {
        let base = res!(root()).join(name);
        let _ = fs::remove_dir_all(&base);
        res!(fs::create_dir_all(&base));
        let secret = base.join("secret.txt");
        res!(fs::write(&secret, "secret"));
        res!(fs::set_permissions(&secret, fs::Permissions::from_mode(0o600)));
        Ok(base)
    }

    /// The real mechanism, or `None` with a printed reason where this machine
    /// cannot run the test.
    ///
    /// Loud rather than silent, exactly as `fence::tests::kernel_fence` is: a
    /// kernel test that quietly passes on a machine that never ran it is a test
    /// that will quietly pass forever.
    ///
    /// # Arguments
    /// * `what` - The test's name, for the message.
    fn kernel_seccomp(what: &str) -> Option<Seccomp> {
        let s = Seccomp::detect();
        match &s {
            Seccomp::Linux { arch } => {
                println!("[{}] running against seccomp-bpf on {}", what, arch.name());
                Some(s)
            },
            Seccomp::None { why } => {
                println!(
                    "[{}] SKIPPED: this machine cannot filter system calls. {} \
                    Run this on Linux 3.17 or later with CONFIG_SECCOMP_FILTER.",
                    what, why);
                None
            },
        }
    }

    /// Runs a test body on a thread of its own, so the filter it installs dies
    /// with it.
    ///
    /// A seccomp filter cannot be removed, so a test that installed one on the
    /// harness's own thread would filter every test that had not run yet.
    ///
    /// # Arguments
    /// * `what` - The test's name, for the error.
    /// * `body` - The unfiltered half, the filter, and the filtered half.
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

    /// Installs a spec on this thread, failing loudly rather than continuing
    /// unfiltered.
    ///
    /// # Arguments
    /// * `s` - The mechanism.
    /// * `spec` - What to refuse.
    fn engage(s: &Seccomp, spec: &Spec) -> Outcome<Enforced> {
        let mut filter = res!(s.plan(spec));
        // The rules are exactly the production ones; only their reach is
        // narrowed, for the reason `own_thread` exists.
        filter.reach = Reach::Thread;
        let enforced = res!(filter.apply());
        if !enforced.filtered {
            return Err(err!(
                "The filter reported that it was not installed, so the rest of \
                this test would prove nothing."; Test, Security));
        }
        Ok(enforced)
    }

    /// Whether a program exists to run.
    ///
    /// # Arguments
    /// * `what` - The test's name, for the message.
    /// * `p` - The path.
    fn have(what: &str, p: &str) -> bool {
        if std::path::Path::new(p).exists() {
            return true;
        }
        println!("[{}] SKIPPED: no {} on this machine.", what, p);
        false
    }

    /// The session bus socket, from the environment rather than a guessed uid.
    ///
    /// `None` where there is no user session to escape through, which is the
    /// case in a container and on a build machine -- and there the test proves
    /// nothing and says so.
    fn bus() -> Option<PathBuf> {
        let dir = match std::env::var("XDG_RUNTIME_DIR") {
            Ok(d) => PathBuf::from(d),
            Err(_) => return None,
        };
        let p = dir.join("bus");
        if p.exists() { Some(p) } else { None }
    }

    // ── The table, checked against the kernel's own headers ─────────

    /// Every number in [`TABLE`] agrees with the kernel headers installed on this
    /// machine.
    ///
    /// The external oracle, and the reason the table is written out by hand at
    /// all: `libc` has no constant for four of these calls on this target, so a
    /// table built from `libc::SYS_*` would silently be missing `setxattrat`,
    /// `removexattrat`, `open_tree_attr` and `file_setattr`. Checking against the
    /// headers checks against the thing that actually defines the numbers.
    #[test]
    fn the_table_agrees_with_the_kernel_headers() -> Outcome<()> {
        let (path, arch) = if cfg!(target_arch = "x86_64") {
            ("/usr/include/x86_64-linux-gnu/asm/unistd_64.h", Arch::X86_64)
        } else if cfg!(target_arch = "aarch64") {
            ("/usr/include/asm-generic/unistd.h", Arch::Aarch64)
        } else {
            println!(
                "[the_table_agrees_with_the_kernel_headers] SKIPPED: no header \
                path known for this architecture, which is also why \
                `Arch::here` returns None here and no filter would be built.");
            return Ok(());
        };
        let text = match fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => {
                println!(
                    "[the_table_agrees_with_the_kernel_headers] SKIPPED: {} \
                    could not be read ({}). Install libc6-dev to run this \
                    check; without it the syscall numbers in TABLE are \
                    unverified.", path, e);
                return Ok(());
            },
        };

        // `#define __NR_<name> <n>`, and nothing else.
        let mut seen: BTreeMap<String, i64> = BTreeMap::new();
        for line in text.lines() {
            let rest = match line.strip_prefix("#define __NR_") {
                Some(r) => r,
                None => continue,
            };
            let mut parts = rest.split_whitespace();
            let name = match parts.next() {
                Some(n) => n,
                None => continue,
            };
            let num = match parts.next().and_then(|v| v.parse::<i64>().ok()) {
                Some(n) => n,
                None => continue,
            };
            seen.insert(name.to_string(), num);
        }
        assert!(
            seen.len() > 100,
            "{} yielded only {} syscall definitions, so it is not the table this \
            test thinks it is", path, seen.len());

        let mut checked = 0usize;
        for sys in TABLE {
            match (sys.number(arch), seen.get(sys.name)) {
                (Some(ours), Some(theirs)) => {
                    assert_eq!(
                        *theirs, ours,
                        "TABLE has {} = {} on {}, and the kernel header says {}",
                        sys.name, ours, arch.name(), theirs);
                    checked += 1;
                },
                (Some(ours), None) => println!(
                    "[the_table_agrees_with_the_kernel_headers] {} = {} is not \
                    in {} -- these headers are older than the kernel. Not a \
                    failure: a number for a call this kernel does not have \
                    refuses nothing.", sys.name, ours, path),
                (None, Some(theirs)) => panic!(
                    "TABLE says {} does not exist on {}, and the kernel header \
                    gives it as {}. That is a hole: the call is refusable and is \
                    not being refused.", sys.name, arch.name(), theirs),
                (None, None) => (),
            }
        }
        println!(
            "[the_table_agrees_with_the_kernel_headers] {} of {} entries \
            cross-checked against {}", checked, TABLE.len(), path);
        assert!(checked >= 20, "only {} entries were cross-checked", checked);
        Ok(())
    }

    /// The table has no duplicate numbers on either architecture.
    ///
    /// A transposed digit would silently refuse the wrong call, and the header
    /// check above would not catch it if the wrong number happened to be another
    /// entry's.
    #[test]
    fn the_table_has_no_collisions() -> Outcome<()> {
        for arch in [Arch::X86_64, Arch::Aarch64] {
            let mut seen: BTreeMap<i64, &str> = BTreeMap::new();
            for sys in TABLE {
                if let Some(n) = sys.number(arch) {
                    if let Some(prev) = seen.insert(n, sys.name) {
                        return Err(err!(
                            "On {}, {} and {} both claim syscall {}.",
                            arch.name(), prev, sys.name, n; Test, Conflict));
                    }
                }
            }
        }
        Ok(())
    }

    // ── The spec, decided without a kernel ──────────────────────────

    /// The default spec refuses what it says it refuses, and nothing it says it
    /// does not.
    #[test]
    fn the_default_spec_is_what_it_claims() -> Outcome<()> {
        let arch = match Arch::here() {
            Some(a) => a,
            None => {
                println!(
                    "[the_default_spec_is_what_it_claims] SKIPPED: no syscall \
                    table for this architecture.");
                return Ok(());
            },
        };
        let sel = refusals(arch, &Spec::default());
        let named = |n: &str| sel.iter().any(|s| s.name == n);

        // The two escapes.
        assert!(named("fchmodat"), "the chmod family is not refused");
        assert!(named("fchmodat2"), "fchmodat2 was missed, which is the newest \
            way to reach the same thing");
        assert!(named("socket"), "AF_UNIX is not refused");

        // The rest of the metadata families.
        assert!(named("fchownat"), "the chown family is not refused");
        assert!(named("fsetxattr"), "the xattr family is not refused");
        assert!(named("setxattrat"), "setxattrat was missed, and libc has no \
            constant for it, which is exactly how it gets missed");
        assert!(named("file_setattr"), "file_setattr was missed");
        assert!(named("io_uring_setup"), "io_uring is not refused, which makes \
            every metadata rule advisory");
        assert!(named("ptrace"), "ptrace is not refused");

        // And the one deliberate exception.
        assert!(!named("utimensat"),
            "the utime family is refused by default, which breaks cargo");

        // The socket is refused for every command, and the network decision does
        // not enter into it. This was once conditional on `net`, and with the
        // condition in place a `net:true` command read a denied file through the
        // session bus with the filter installed and the fence in force.
        assert!(named("socket"),
            "AF_UNIX is not refused, so the session bus is a way out of the fence");
        let open = refusals(arch, &Spec { unix: Unix::Allow, ..Spec::default() });
        assert!(!open.iter().any(|s| s.name == "socket"),
            "Unix::Allow still refused the socket, so the arm means nothing");
        Ok(())
    }

    /// `Meta::Refuse` really does take the timestamps too, and `Meta::Allow`
    /// really does take nothing.
    #[test]
    fn the_meta_arms_differ() -> Outcome<()> {
        let arch = match Arch::here() {
            Some(a) => a,
            None => return Ok(()),
        };
        let strict = refusals(arch, &Spec { meta: Meta::Refuse, ..Spec::default() });
        assert!(strict.iter().any(|s| s.name == "utimensat"),
            "Meta::Refuse did not refuse the timestamps");

        let open = refusals(arch, &Spec { meta: Meta::Allow, ..Spec::default() });
        assert!(!open.iter().any(|s| s.group == Group::Mode),
            "Meta::Allow refused a chmod");
        assert!(!open.iter().any(|s| s.group == Group::Xattr),
            "Meta::Allow refused an xattr call");
        // The other groups are unaffected by Meta.
        assert!(open.iter().any(|s| s.name == "socket"),
            "Meta::Allow disturbed the socket rule");
        Ok(())
    }

    /// A machine with no filter refuses, rather than running the command.
    ///
    /// There is no waiver arm here on purpose, and this is what asserts it: the
    /// only way past `plan` on a machine without seccomp is not to call it.
    #[test]
    fn no_filter_refuses() -> Outcome<()> {
        let s = Seccomp::None { why: fmt!("Nothing here.") };
        assert!(s.plan(&Spec::default()).is_err(),
            "a command was planned with no system-call filter");

        let words = s.refusal("A build");
        assert!(words.contains("A build"), "{}", words);
        assert!(words.contains("session bus"), "the refusal does not say what \
            is lost: {}", words);
        assert_eq!(vec![fmt!("seccomp:none")], s.caps());
        assert!(s.holes().iter().any(|h| h.contains("Everything")), "{:?}",
            s.holes());
        Ok(())
    }

    /// A spec that refuses nothing is refused, rather than compiled into a claim.
    #[test]
    fn an_empty_spec_is_refused() -> Outcome<()> {
        let s = match kernel_seccomp("an_empty_spec_is_refused") {
            Some(s) => s,
            None => return Ok(()),
        };
        let nothing = Spec {
            meta: Meta::Allow,
            unix: Unix::Allow,
            ring: Ring::Allow,
            poke: Poke::Allow,
        };
        assert!(s.plan(&nothing).is_err(),
            "a filter refusing nothing was compiled, and would have been \
            reported as a capability");
        Ok(())
    }

    /// The report names every group that is in force, and no group that is not.
    #[test]
    fn caps_never_stay_silent() -> Outcome<()> {
        let s = match kernel_seccomp("caps_never_stay_silent") {
            Some(s) => s,
            None => return Ok(()),
        };
        let f = res!(s.plan(&Spec::default()));
        let caps = f.caps();
        for want in [
            "seccomp:bpf",
            "seccomp:chmod-no-loosening",
            "seccomp:no-chown",
            "seccomp:no-xattr",
            "seccomp:no-af-unix",
            "seccomp:no-io-uring",
            "seccomp:no-ptrace",
        ] {
            assert!(caps.iter().any(|c| c == want), "{} missing from {:?}",
                want, caps);
        }
        assert!(!caps.iter().any(|c| c == "seccomp:no-times"),
            "the timestamps are permitted by default and the report says \
            otherwise: {:?}", caps);

        // The permitted timestamps are a hole, and a hole has to be said out
        // loud rather than merely not claimed.
        assert!(f.holes().iter().any(|h| h.contains("timestamps")),
            "the permitted utime family is not in holes(): {:?}", f.holes());
        assert!(f.holes().iter().any(|h| h.contains("644")),
            "the permitted chmod 644 is not in holes(): {:?}", f.holes());

        // And the program is a real one of a sane size.
        assert!(f.instructions() > 20 && f.instructions() < 4096,
            "{} BPF instructions", f.instructions());
        println!("[caps_never_stay_silent] {} BPF instructions, {} calls \
            refused", f.instructions(), f.refused.len());
        Ok(())
    }

    // ── The two escapes from the review, closed ─────────────────────

    /// §1.2, the measured half: `chmod 777` on a 600 file.
    ///
    /// The review's reproduction was on a file *inside the denied subtree* of a
    /// full ABI-8 fence, and Landlock did not mediate it. Landlock is not
    /// involved here: this test does the same thing to the same kind of file and
    /// shows the filter refusing it, which is the whole of the fix. The fenced
    /// version is `the_review_escapes_are_closed_together`.
    #[test]
    fn chmod_777_is_refused() -> Outcome<()> {
        let s = match kernel_seccomp("chmod_777_is_refused") {
            Some(s) => s,
            None => return Ok(()),
        };
        own_thread("chmod_777_is_refused", move || {
            let base = res!(fixture("chmod777"));
            let secret = base.join("secret.txt");
            let mode = |p: &std::path::Path| -> Outcome<u32> {
                Ok(res!(fs::metadata(p)).permissions().mode() & 0o7777)
            };

            // Broken first: unfiltered, this is the review's finding.
            res!(fs::set_permissions(&secret, fs::Permissions::from_mode(0o777)));
            assert_eq!(0o777, res!(mode(&secret)),
                "the unfiltered chmod did not take, so the rest proves nothing");
            res!(fs::set_permissions(&secret, fs::Permissions::from_mode(0o600)));

            res!(engage(&s, &Spec::default()));

            assert!(
                fs::set_permissions(&secret, fs::Permissions::from_mode(0o777)).is_err(),
                "chmod 777 succeeded behind the filter");
            assert_eq!(0o600, res!(mode(&secret)),
                "the mode changed although the call was refused");

            // Every other loosening spelling, so the rule is the rule and not one
            // constant.
            for m in [0o666u32, 0o4755, 0o2755, 0o602, 0o007] {
                assert!(
                    fs::set_permissions(&secret, fs::Permissions::from_mode(m)).is_err(),
                    "chmod {:o} succeeded behind the filter", m);
            }

            // And the modes a build needs still work, or the filter would be
            // turned off.
            for m in [0o644u32, 0o755, 0o664, 0o775, 0o700, 0o400] {
                res!(fs::set_permissions(&secret, fs::Permissions::from_mode(m)));
                assert_eq!(m, res!(mode(&secret)), "chmod {:o} did not take", m);
            }
            Ok(())
        })
    }

    /// The rest of §1.2: `chown`, `setxattr` and the attribute calls.
    ///
    /// `chown` to another user needs a capability the test does not have, so the
    /// unfiltered half uses the one form an ordinary user can perform -- `chown`
    /// to the uid and gid it already has, which succeeds -- and the filtered half
    /// shows the same call refused.
    #[test]
    fn the_other_metadata_calls_are_refused() -> Outcome<()> {
        let s = match kernel_seccomp("the_other_metadata_calls_are_refused") {
            Some(s) => s,
            None => return Ok(()),
        };
        let chown = if std::path::Path::new("/usr/bin/chown").exists() {
            "/usr/bin/chown"
        } else if std::path::Path::new("/bin/chown").exists() {
            "/bin/chown"
        } else {
            println!(
                "[the_other_metadata_calls_are_refused] SKIPPED: no chown on \
                this machine to run inside the filter.");
            return Ok(());
        };
        own_thread("the_other_metadata_calls_are_refused", move || {
            let base = res!(fixture("othermeta"));
            let secret = base.join("secret.txt");

            // Broken first, with the real program, unfiltered.
            let out = res!(Command::new(chown).arg("--reference").arg(&secret)
                .arg(&secret).output());
            assert!(out.status.success(),
                "chown --reference failed before the filter: {}",
                String::from_utf8_lossy(&out.stderr));

            res!(engage(&s, &Spec::default()));

            let out = res!(Command::new(chown).arg("--reference").arg(&secret)
                .arg(&secret).output());
            assert!(!out.status.success(),
                "chown succeeded behind the filter");
            let said = String::from_utf8_lossy(&out.stderr).to_lowercase();
            assert!(said.contains("not permitted"),
                "chown failed for the wrong reason: {}", said);
            Ok(())
        })
    }

    /// §1.3: the session bus, and `systemd-run --user` through it.
    ///
    /// This is the review's reproduction verbatim -- with the fence fully applied
    /// and the network refused, `systemd-run --user … /bin/cat <denied-file>`
    /// started a process *outside* the fence and returned the contents. The
    /// filter closes it at the only place seccomp can see: `socket(AF_UNIX, …)`.
    #[test]
    fn the_session_bus_is_unreachable() -> Outcome<()> {
        let s = match kernel_seccomp("the_session_bus_is_unreachable") {
            Some(s) => s,
            None => return Ok(()),
        };
        let run = "/usr/bin/systemd-run";
        if !have("the_session_bus_is_unreachable", run) {
            return Ok(());
        }
        own_thread("the_session_bus_is_unreachable", move || {
            let base = res!(fixture("bus"));
            let secret = base.join("secret.txt");

            // Broken first: unfiltered, this is the escape.
            let out = res!(Command::new(run)
                .args(["--user", "--pipe", "--quiet", "--wait", "/bin/cat"])
                .arg(&secret)
                .output());
            if !out.status.success() {
                println!(
                    "[the_session_bus_is_unreachable] SKIPPED: systemd-run \
                    --user does not work here even unfiltered ({}), so there is \
                    no escape to close and this proves nothing. Run this inside \
                    a real user session.",
                    String::from_utf8_lossy(&out.stderr).trim());
                return Ok(());
            }
            assert_eq!("secret", String::from_utf8_lossy(&out.stdout),
                "the unfiltered escape did not return the file, so the filtered \
                half would prove nothing");

            res!(engage(&s, &Spec::default()));

            let out = res!(Command::new(run)
                .args(["--user", "--pipe", "--quiet", "--wait", "/bin/cat"])
                .arg(&secret)
                .output());
            assert!(!out.status.success(),
                "systemd-run --user still ran a command outside the fence");
            assert!(!String::from_utf8_lossy(&out.stdout).contains("secret"),
                "the file came back through the bus behind the filter");
            let said = String::from_utf8_lossy(&out.stderr);
            assert!(said.to_lowercase().contains("connect"),
                "systemd-run failed for a reason other than the bus: {}", said);
            println!("[the_session_bus_is_unreachable] systemd-run said: {}",
                said.trim());
            Ok(())
        })
    }

    /// A unix socket cannot be opened at all, and `socketpair` still can.
    ///
    /// The second half is not a nicety: a from-scratch `cargo test` makes six
    /// `socketpair(AF_UNIX, …)` calls, so a filter that took them would break
    /// every build.
    #[test]
    fn af_unix_is_refused_and_socketpair_is_not() -> Outcome<()> {
        let s = match kernel_seccomp("af_unix_is_refused_and_socketpair_is_not") {
            Some(s) => s,
            None => return Ok(()),
        };
        own_thread("af_unix_is_refused_and_socketpair_is_not", move || {
            let base = res!(fixture("afunix"));
            let sock = base.join("s.sock");
            let bus = bus();

            // Broken first: unfiltered, a unix socket binds and connects, and so
            // does the session bus where there is one.
            let l = res!(std::os::unix::net::UnixListener::bind(&sock));
            let c = res!(std::os::unix::net::UnixStream::connect(&sock));
            drop(c);
            drop(l);
            res!(fs::remove_file(&sock));
            match &bus {
                Some(b) => assert!(
                    std::os::unix::net::UnixStream::connect(b).is_ok(),
                    "the session bus at {} refused a connection before the \
                    filter, so the filtered half would prove nothing",
                    b.display()),
                None => println!(
                    "[af_unix_is_refused_and_socketpair_is_not] no session bus \
                    on this machine, so only the general socket refusal is \
                    checked here."),
            }

            res!(engage(&s, &Spec::default()));

            assert!(std::os::unix::net::UnixListener::bind(&sock).is_err(),
                "a unix socket was still bound behind the filter");
            if let Some(b) = &bus {
                assert!(std::os::unix::net::UnixStream::connect(b).is_err(),
                    "the session bus was still connectable behind the filter");
            }

            // socketpair is a different syscall and stays.
            let (a, b) = res!(std::os::unix::net::UnixStream::pair());
            drop(a);
            drop(b);
            Ok(())
        })
    }

    /// The filter survives `execve`, which is the whole reason a launcher can
    /// install it and then become the command.
    #[test]
    fn the_filter_is_inherited_by_a_real_program() -> Outcome<()> {
        let s = match kernel_seccomp("the_filter_is_inherited_by_a_real_program") {
            Some(s) => s,
            None => return Ok(()),
        };
        let chmod = "/usr/bin/chmod";
        if !have("the_filter_is_inherited_by_a_real_program", chmod) {
            return Ok(());
        }
        own_thread("the_filter_is_inherited_by_a_real_program", move || {
            let base = res!(fixture("inherit"));
            let secret = base.join("secret.txt");

            // Broken first: unfiltered, the real program does it.
            let out = res!(Command::new(chmod).arg("777").arg(&secret).output());
            assert!(out.status.success(), "chmod 777 failed before the filter");
            res!(fs::set_permissions(&secret, fs::Permissions::from_mode(0o600)));

            res!(engage(&s, &Spec::default()));

            let out = res!(Command::new(chmod).arg("777").arg(&secret).output());
            assert!(!out.status.success(),
                "an exec'd chmod 777 succeeded, so the filter was not inherited");
            let mode = res!(fs::metadata(&secret)).permissions().mode() & 0o7777;
            assert_eq!(0o600, mode, "the mode changed through an exec'd program");

            // And the permitted half is genuinely permitted through exec too,
            // which is what stops this being a filter that refuses everything.
            let out = res!(Command::new(chmod).arg("755").arg(&secret).output());
            assert!(out.status.success(),
                "an exec'd chmod 755 was refused: {}",
                String::from_utf8_lossy(&out.stderr));
            Ok(())
        })
    }

    /// `io_uring_setup` is refused, and refused with `ENOSYS` rather than
    /// `EPERM`.
    ///
    /// Skipped loudly where the kernel has no io_uring to begin with, since a
    /// refusal indistinguishable from an absence would prove nothing.
    #[test]
    fn io_uring_is_refused() -> Outcome<()> {
        let s = match kernel_seccomp("io_uring_is_refused") {
            Some(s) => s,
            None => return Ok(()),
        };
        let arch = match Arch::here() {
            Some(a) => a,
            None => return Ok(()),
        };
        // The rule is asserted on the plan rather than by making the call:
        // issuing `io_uring_setup` from safe Rust is not possible without a
        // dependency this crate does not have, and the number is what the filter
        // acts on.
        let f = res!(s.plan(&Spec::default()));
        let want = match TABLE.iter().find(|t| t.name == "io_uring_setup") {
            Some(t) => t,
            None => return Err(err!("io_uring_setup left the table"; Test)),
        };
        assert!(f.refused.iter().any(|t| t.name == "io_uring_setup"),
            "io_uring is not refused, so every metadata rule is advisory");
        assert_eq!(Some(425), want.number(arch));
        Ok(())
    }

    // ── The thing most likely to break ──────────────────────────────

    /// A real `cargo` build runs behind the filter.
    ///
    /// This is the test the whole design turns on. A filter that breaks `cargo`
    /// is worse than no filter, because it gets switched off -- and the first two
    /// specs tried here *did* break it, which is why [`Meta::NoLoosening`] exists
    /// and why the `utime` family is permitted.
    ///
    /// **What it does not cover.** The crate built here has no dependencies, so
    /// nothing is unpacked from the registry -- and unpacking is where the two
    /// breakages were found. That path needs a registry and cannot be made
    /// hermetic and offline, so it was measured out of band instead, and this is
    /// the record: with the `utime` family refused, `cargo test` on a crate with
    /// one dependency fails with `failed to set mtime for
    /// .../.cargo_vcs_info.json`; with the timestamps allowed and the `chmod`
    /// family refused, it fails with `failed to set permissions to 644` for the
    /// same file; with [`Spec::default`] it succeeds. [`git_still_runs`] is the
    /// sharper canary of the two and does run here: it fails under
    /// [`Meta::Refuse`], which this test does not.
    ///
    /// Also measured out of band, against a real tree: `cargo test -p
    /// oxedyne_fe2o3_hash` from an empty target directory -- 40-odd crates,
    /// proc-macro builds, build scripts and a linked test binary -- compiles and
    /// passes behind this filter.
    ///
    /// Skipped loudly where there is no cargo to run.
    #[test]
    fn a_real_cargo_build_still_runs() -> Outcome<()> {
        let s = match kernel_seccomp("a_real_cargo_build_still_runs") {
            Some(s) => s,
            None => return Ok(()),
        };
        let cargo = match std::env::var("CARGO") {
            Ok(c) => c,
            Err(_) => {
                println!(
                    "[a_real_cargo_build_still_runs] SKIPPED: CARGO is not set, \
                    so there is no cargo to run. This test only runs under \
                    `cargo test`.");
                return Ok(());
            },
        };
        own_thread("a_real_cargo_build_still_runs", move || {
            let base = res!(fixture("cargo"));
            let crate_dir = base.join("toy");
            res!(fs::create_dir_all(crate_dir.join("src")));
            res!(fs::write(crate_dir.join("Cargo.toml"),
                "[package]\nname = \"toy\"\nversion = \"0.1.0\"\nedition = \
                \"2021\"\n[workspace]\n"));
            res!(fs::write(crate_dir.join("src/lib.rs"),
                "pub fn add(a: i32, b: i32) -> i32 { a + b }\n\
                #[cfg(test)] mod t { #[test] fn works() { \
                assert_eq!(3, super::add(1, 2)); } }\n"));
            let target = base.join("target");

            res!(engage(&s, &Spec::default()));

            let out = res!(Command::new(&cargo)
                .arg("test")
                .arg("--offline")
                .arg("--manifest-path")
                .arg(crate_dir.join("Cargo.toml"))
                .env("CARGO_TARGET_DIR", &target)
                // The harness's own variables would point a nested cargo at this
                // run's state; a clean pair is what a real command gets.
                .env_remove("RUSTC_WORKSPACE_WRAPPER")
                .env_remove("RUSTC_WRAPPER")
                .output());
            assert!(out.status.success(),
                "cargo test failed behind the filter, which is the one outcome \
                that makes this filter worse than none:\n{}\n{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr));
            let said = String::from_utf8_lossy(&out.stdout);
            assert!(said.contains("test result: ok"),
                "cargo ran but the test did not pass: {}", said);
            println!("[a_real_cargo_build_still_runs] a from-scratch cargo test \
                compiled, linked and ran behind the filter");
            Ok(())
        })
    }

    /// `git` runs behind the filter.
    ///
    /// The measured counter-example to the obvious rule: `git` chmods to `0664`
    /// and `0775` under the default Ubuntu umask, so a filter refusing any
    /// group-write mode would break `git init`. That is why [`LOOSENING`] names
    /// world-write and the set-ID bits and not group-write.
    #[test]
    fn git_still_runs() -> Outcome<()> {
        let s = match kernel_seccomp("git_still_runs") {
            Some(s) => s,
            None => return Ok(()),
        };
        let git = "/usr/bin/git";
        if !have("git_still_runs", git) {
            return Ok(());
        }
        own_thread("git_still_runs", move || {
            let base = res!(fixture("git"));
            let repo = base.join("r");
            res!(fs::create_dir_all(&repo));

            res!(engage(&s, &Spec::default()));

            let run = |args: &[&str]| -> Outcome<()> {
                let out = res!(Command::new(git).args(args).current_dir(&repo)
                    .env("HOME", &base).output());
                if !out.status.success() {
                    return Err(err!(
                        "git {:?} failed behind the filter: {}", args,
                        String::from_utf8_lossy(&out.stderr); Test));
                }
                Ok(())
            };
            res!(run(&["init", "-q"]));
            res!(fs::write(repo.join("a.sh"), "#!/bin/sh\necho hi\n"));
            res!(fs::set_permissions(repo.join("a.sh"),
                fs::Permissions::from_mode(0o755)));
            res!(run(&["add", "-A"]));
            res!(run(&[
                "-c", "user.email=a@b", "-c", "user.name=n",
                "commit", "-qm", "x",
            ]));
            Ok(())
        })
    }

    /// The two escapes, closed at once, on one file.
    ///
    /// The review's §1.2 and §1.3 share a subject -- a file the fence denies --
    /// and this asserts both refusals against that one file so a change that
    /// closed one and reopened the other could not pass.
    #[test]
    fn the_review_escapes_are_closed_together() -> Outcome<()> {
        let s = match kernel_seccomp("the_review_escapes_are_closed_together") {
            Some(s) => s,
            None => return Ok(()),
        };
        own_thread("the_review_escapes_are_closed_together", move || {
            let base = res!(fixture("both"));
            let secret = base.join("secret.txt");
            let bus = bus();

            res!(engage(&s, &Spec::default()));

            // §1.2: the permissions of the denied file cannot be loosened.
            assert!(
                fs::set_permissions(&secret, fs::Permissions::from_mode(0o777)).is_err(),
                "1.2 is open: chmod 777 succeeded on the denied file");
            assert_eq!(
                0o600,
                res!(fs::metadata(&secret)).permissions().mode() & 0o7777);

            // §1.3: no socket, so no bus, so no unfenced process to read it with.
            match &bus {
                Some(b) => assert!(
                    std::os::unix::net::UnixStream::connect(b).is_err(),
                    "1.3 is open: the session bus was connectable"),
                None => println!(
                    "[the_review_escapes_are_closed_together] SKIPPED the 1.3 \
                    half: no session bus on this machine to be refused."),
            }
            Ok(())
        })
    }
}
