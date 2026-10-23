//! NativeHost, the host a run's child process runs on (R1b): LocalHost's ports, but for its store,
//! which is the parent's store over a pipe ([`RemoteStore`] over [`PipeLink`]), its clock, which
//! is the process clock (`fe2o3_core::time::clock`, driven in the rig), and its fs, which is the
//! run's workspace on disk ([`NativeFs`]).  Generic, never `dyn`: the store is named by its type.
//!
//! HOSTED (R1 capture gate, 18 Oct): the runner runs the tab's tool half, so a write or a delete
//! there takes the tab's capture into the keeper's store and leaves a History row; the bare
//! `std::fs` half (`local_file_*`) is LocalHost's alone and unreachable here.
//!
//! It adds no store semantics: every store call is the one [`RemoteStore`] makes over the
//! in-process [`LoopLink`](crate::store::server::LoopLink), carried by the pipe instead.

pub mod clock;
pub mod fs;

use crate::{
    engine::host::{
        Host,
        exec::HostExec,
        ui::HostUi,
        local::{
            LocalSync,
            exec::LocalExec,
            net::LocalNet,
            ui::LocalUi,
            web::LocalWeb,
        },
    },
    store::{
        pipe::PipeLink,
        remote::RemoteStore,
    },
    workspace::Workspace,
};
use self::{
    clock::NativeClock,
    fs::NativeFs,
};

use std::sync::Arc;

/// NativeHost's store port: the parent's store, over the child's pipe.
pub type NativeStore = RemoteStore<PipeLink>;

/// NativeHost: one field per port.  Its clones share one store port, and so one pipe.
///
/// Its exec port `E` is named by its type, never `dyn`: [`LocalExec`] (no commands) unless a run's
/// child gives it the runner's own, which runs each command under the run's fence (RKEY-c).  Its
/// ui port `U` likewise: [`LocalUi`] (nobody there, so every ask stops the act) unless a run's
/// child gives it one that carries the ask to the person who sent the turn (R3d-c).
#[derive(Clone)]
pub struct NativeHost<E: HostExec + Clone + 'static = LocalExec, U: HostUi + Clone + 'static = LocalUi> {
    fs:    NativeFs,
    exec:  E,
    net:   LocalNet,
    clock: NativeClock,
    store: Arc<NativeStore>,
    ui:    U,
    sync:  LocalSync,
    web:   LocalWeb,
}

impl NativeHost {

    /// The host whose store is reached over `link`, with no workspace: every fs call refused.
    pub fn new(link: PipeLink) -> Self {
        Self::with_fs(link, NativeFs::default())
    }

    /// The host whose store is reached over `link` and whose files are `ws`'s.
    pub fn rooted(link: PipeLink, ws: Workspace) -> Self {
        Self::with_fs(link, NativeFs::over(ws))
    }

    fn with_fs(link: PipeLink, fs: NativeFs) -> Self {
        NativeHost::rooted_on(link, fs, LocalExec::default())
    }
}

impl<E: HostExec + Clone + 'static> NativeHost<E> {

    /// The host whose store is reached over `link`, whose files are `fs`'s and whose commands
    /// go to `exec`; nobody to ask.
    pub fn rooted_on(link: PipeLink, fs: NativeFs, exec: E) -> Self {
        NativeHost::asking(link, fs, exec, LocalUi::default())
    }
}

impl<E: HostExec + Clone + 'static, U: HostUi + Clone + 'static> NativeHost<E, U> {

    /// The host whose store is reached over `link`, whose files are `fs`'s, whose commands go to
    /// `exec` and whose asks go out through `ui`.
    pub fn asking(link: PipeLink, fs: NativeFs, exec: E, ui: U) -> Self {
        // The fs reads a store-owned path from this same store (HL5a).
        let store = Arc::new(RemoteStore::new(link));
        Self {
            fs:    fs.reading(store.clone()),
            exec,
            net:   LocalNet::default(),
            clock: NativeClock,
            store,
            ui,
            sync:  LocalSync,
            web:   LocalWeb::default(),
        }
    }
}

impl<E: HostExec + Clone + 'static, U: HostUi + Clone + 'static> std::fmt::Debug for NativeHost<E, U> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeHost").field("store", self.store.link()).finish()
    }
}

impl<E, U> Default for NativeHost<E, U>
    where E: HostExec + Clone + Default + 'static, U: HostUi + Clone + Default + 'static
{
    /// A host with no pipe and no workspace, on `E`'s and `U`'s defaults.
    fn default() -> Self {
        NativeHost::asking(PipeLink::closed(), NativeFs::default(), E::default(), U::default())
    }
}

impl<E, U> Host for NativeHost<E, U>
    where E: HostExec + Clone + Default + 'static, U: HostUi + Clone + Default + 'static
{
    // The tab's half, through these ports (R1 capture gate): never `local_execute`'s bare std::fs.
    const HOSTED: bool = true;
    type Fs    = NativeFs;
    type Exec  = E;
    type Net   = LocalNet;
    type Clock = NativeClock;
    type Store = NativeStore;
    type Ui    = U;
    type Sync  = LocalSync;
    type Web   = LocalWeb;
    fn fs(&self) -> &NativeFs { &self.fs }
    fn exec(&self) -> &E { &self.exec }
    fn net(&self) -> &LocalNet { &self.net }
    fn clock(&self) -> &NativeClock { &self.clock }
    fn store(&self) -> &NativeStore { &self.store }
    fn ui(&self) -> &U { &self.ui }
    fn sync(&self) -> &LocalSync { &self.sync }
    fn web(&self) -> &LocalWeb { &self.web }
}
