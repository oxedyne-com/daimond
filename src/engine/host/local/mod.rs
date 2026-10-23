//! LocalHost, the native default: today's native tool half (`std::fs` and `Executor::Local`) runs
//! beside it and never calls a port, so every port refuses.  It goes at R1, with that half.

pub mod clock;
pub mod exec;
pub mod fs;
pub mod net;
pub mod store;
pub mod ui;
pub mod web;

use crate::engine::host::{
    Host,
    sync::SyncPort,
};
use self::{
    clock::LocalClock,
    exec::LocalExec,
    fs::LocalFs,
    net::LocalNet,
    store::LocalStore,
    ui::LocalUi,
    web::LocalWeb,
};

/// LocalHost's sync port.
#[derive(Clone, Debug, Default)]
pub struct LocalSync;

impl SyncPort for LocalSync {}

/// LocalHost: one field per port.
#[derive(Clone, Debug, Default)]
pub struct LocalHost {
    fs:    LocalFs,
    exec:  LocalExec,
    net:   LocalNet,
    clock: LocalClock,
    store: LocalStore,
    ui:    LocalUi,
    sync:  LocalSync,
    web:   LocalWeb,
}

impl Host for LocalHost {
    const HOSTED: bool = false;
    type Fs    = LocalFs;
    type Exec  = LocalExec;
    type Net   = LocalNet;
    type Clock = LocalClock;
    type Store = LocalStore;
    type Ui    = LocalUi;
    type Sync  = LocalSync;
    type Web   = LocalWeb;
    fn fs(&self) -> &LocalFs { &self.fs }
    fn exec(&self) -> &LocalExec { &self.exec }
    fn net(&self) -> &LocalNet { &self.net }
    fn clock(&self) -> &LocalClock { &self.clock }
    fn store(&self) -> &LocalStore { &self.store }
    fn ui(&self) -> &LocalUi { &self.ui }
    fn sync(&self) -> &LocalSync { &self.sync }
    fn web(&self) -> &LocalWeb { &self.web }
}
