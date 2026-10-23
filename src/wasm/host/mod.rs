//! WasmHost, the tab's host: every port method is one call to today's free function in
//! `src/wasm/`.  It and its ports are zero-sized.

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
    clock::WasmClock,
    exec::WasmExec,
    fs::WasmFs,
    net::WasmNet,
    store::WasmStore,
    ui::WasmUi,
    web::WasmWeb,
};

/// WasmHost's sync port.
#[derive(Clone, Debug, Default)]
pub struct WasmSync;

impl SyncPort for WasmSync {}

/// WasmHost: one field per port.
#[derive(Clone, Debug, Default)]
pub struct WasmHost {
    fs:    WasmFs,
    exec:  WasmExec,
    net:   WasmNet,
    clock: WasmClock,
    store: WasmStore,
    ui:    WasmUi,
    sync:  WasmSync,
    web:   WasmWeb,
}

impl Host for WasmHost {
    const HOSTED: bool = true;
    type Fs    = WasmFs;
    type Exec  = WasmExec;
    type Net   = WasmNet;
    type Clock = WasmClock;
    type Store = WasmStore;
    type Ui    = WasmUi;
    type Sync  = WasmSync;
    type Web   = WasmWeb;
    fn fs(&self) -> &WasmFs { &self.fs }
    fn exec(&self) -> &WasmExec { &self.exec }
    fn net(&self) -> &WasmNet { &self.net }
    fn clock(&self) -> &WasmClock { &self.clock }
    fn store(&self) -> &WasmStore { &self.store }
    fn ui(&self) -> &WasmUi { &self.ui }
    fn sync(&self) -> &WasmSync { &self.sync }
    fn web(&self) -> &WasmWeb { &self.web }
}
