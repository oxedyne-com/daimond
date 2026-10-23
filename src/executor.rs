//! Command execution backend for the agent's shell tool.
//!
//! `Executor` is a pluggable boundary (plan D4): the `Local` variant
//! runs commands directly under the Daimond process's user, in a given
//! working directory, with a timeout.  It is a *run location*, not a
//! security sandbox — appropriate for the trusted, self-hosted
//! environment (plan D0).  A future `Remote` variant can offload
//! execution to another host without changing callers.

use oxedyne_fe2o3_core::prelude::*;

use std::path::Path;
#[cfg(not(target_arch = "wasm32"))]
use std::time::Duration;


/// Where and how the agent runs shell commands.
#[derive(Clone, Debug)]
pub enum Executor {
    /// Run locally under the Daimond process's user, capped by `timeout`.
    #[cfg(not(target_arch = "wasm32"))]
    Local { timeout: Duration },
    /// Run inside the browser (wasm32).  In-browser shell execution is
    /// not yet wired up, so a command escalates rather than running.
    // TODO(wasm-exec): route shell commands to an in-browser sandbox or
    // a server round-trip once the browser tool surface is built.
    #[cfg(target_arch = "wasm32")]
    Wasm,
}

/// The captured result of a command.
#[derive(Clone, Debug)]
pub struct CommandOutput {
    pub stdout:    String,
    pub stderr:    String,
    pub exit_code: i32,
    pub timed_out: bool,
}

impl Executor {

    /// A local executor with a sensible default timeout.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn local_default() -> Self {
        Self::Local { timeout: Duration::from_secs(120) }
    }

    /// Run `command` via `sh -c` in `cwd`, capturing stdout/stderr.
    ///
    /// On Unix the child leads its own process group, and on timeout or when this future is
    /// dropped (a Stop) the whole group is killed, so a backgrounded grandchild does not
    /// outlive the tool.  Elsewhere only the direct child is killed (via `kill_on_drop`).  A
    /// timeout returns a `timed_out` result rather than an error.  On wasm32
    /// there is no local process backend, so this escalates.
    pub async fn run(&self, command: &str, cwd: &Path) -> Outcome<CommandOutput> {
        match self {
            #[cfg(not(target_arch = "wasm32"))]
            Self::Local { timeout } => {
                use tokio::process::Command;
                let mut cmd = Command::new("sh");
                cmd.arg("-c").arg(command)
                    .current_dir(cwd)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .kill_on_drop(true);
                #[cfg(unix)]
                cmd.process_group(0);
                let child = res!(cmd.spawn()
                    .map_err(|e| err!(e, "Executor: failed to spawn command."; IO, Init)));
                #[cfg(target_os = "linux")]
                let mut group = GroupKill { pgid: child.id() };
                let result = tokio::time::timeout(*timeout, child.wait_with_output()).await;
                #[cfg(target_os = "linux")]
                if let Ok(Ok(_)) = result {
                    // A clean finish: leave alone anything the command deliberately detached.
                    group.pgid = None;
                }
                match result {
                    Ok(Ok(out)) => Ok(CommandOutput {
                        stdout:    String::from_utf8_lossy(&out.stdout).to_string(),
                        stderr:    String::from_utf8_lossy(&out.stderr).to_string(),
                        exit_code: out.status.code().unwrap_or(-1),
                        timed_out: false,
                    }),
                    Ok(Err(e)) => Err(err!(e, "Executor: waiting on command failed."; IO)),
                    Err(_) => Ok(CommandOutput {
                        stdout:    String::new(),
                        stderr:    fmt!("Command timed out after {} seconds.", timeout.as_secs()),
                        exit_code: -1,
                        timed_out: true,
                    }),
                }
            }
            #[cfg(target_arch = "wasm32")]
            Self::Wasm => {
                // In-browser shell execution is not yet available; the
                // caller must escalate this to a server round-trip.
                let _ = (command, cwd);
                Err(err!(
                    "Executor: in-browser shell execution is not yet \
                     supported; escalation required.";
                    Unimplemented))
            }
        }
    }
}

/// Kills a child's whole process group when dropped, unless disarmed by clearing `pgid`.
///
/// The group id is the leader's pid (`process_group(0)`).  It cannot be reused while any member
/// of the group, the leader's zombie included, still exists, so the signal reaches only the
/// command's own processes.  The signal is `fe2o3_sys::signal::to_group`, `killpg` over `nix`.
#[cfg(target_os = "linux")]
struct GroupKill {
    pgid: Option<u32>,
}

#[cfg(target_os = "linux")]
impl Drop for GroupKill {
    fn drop(&mut self) {
        if let Some(pgid) = self.pgid {
            // The group may already be gone, all of it having ended; there is nothing to report.
            let _ = oxedyne_fe2o3_sys::signal::to_group(pgid, oxedyne_fe2o3_sys::signal::Signal::Kill);
        }
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_run_echo() {
        let ex = Executor::local_default();
        let out = ex.run("echo hello", Path::new("/tmp")).await.expect("run");
        assert_eq!(out.stdout.trim(), "hello");
        assert_eq!(out.exit_code, 0);
        assert!(!out.timed_out);
    }

    #[tokio::test]
    async fn test_run_exit_code() {
        let ex = Executor::local_default();
        let out = ex.run("exit 3", Path::new("/tmp")).await.expect("run");
        assert_eq!(out.exit_code, 3);
    }

    /// Dropping an in-flight `run` must kill the whole process group, not only the direct `sh`
    /// child: a backgrounded grandchild (a build, a server, a `sleep`) must not survive a Stop.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn test_drop_kills_process_group() {
        let dir = std::env::temp_dir().join(fmt!("daimond_exec_pg_{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let pidfile = dir.join("bg.pid");
        let _ = std::fs::remove_file(&pidfile);
        let ex = Executor::local_default();
        let cmd = fmt!("sleep 30 & echo $! > {}; sleep 30", pidfile.display());
        // The outer timeout drops the `run` future mid-flight, as a Stop does.
        let dropped = tokio::time::timeout(Duration::from_millis(500), ex.run(&cmd, &dir)).await;
        assert!(dropped.is_err(), "the command should still have been running");
        let pid: u32 = std::fs::read_to_string(&pidfile).expect("pidfile")
            .trim().parse().expect("pid");
        let alive = |pid: u32| match std::fs::read_to_string(fmt!("/proc/{}/stat", pid)) {
            // A zombie (state `Z`) is dead and only awaiting its reaper.
            Ok(stat) => !stat.rsplit(") ").next().map_or(false, |r| r.starts_with('Z')),
            Err(_) => false,
        };
        let mut gone = false;
        for _ in 0..20 {
            if !alive(pid) { gone = true; break; }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !gone {
            let _ = oxedyne_fe2o3_sys::signal::to_process(pid, oxedyne_fe2o3_sys::signal::Signal::Kill);
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert!(gone, "backgrounded grandchild {} survived the dropped run", pid);
    }

    #[tokio::test]
    async fn test_run_timeout() {
        let ex = Executor::Local { timeout: Duration::from_millis(200) };
        let out = ex.run("sleep 5", Path::new("/tmp")).await.expect("run");
        assert!(out.timed_out);
    }
}
