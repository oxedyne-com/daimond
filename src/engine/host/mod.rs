//! The host a turn runs on, reached through one port per kind of reach (spec §2.2).
//!
//! Generic, never `dyn`: `ToolContext<H>` and `ToolRegistry<H>` carry the host, and engine code
//! reaches it only through `ctx.host()`.  The tab runs [`crate::wasm::host::WasmHost`]; the native
//! build defaults to [`local::LocalHost`], and the engine's tests run on [`test::TestHost`].

pub mod clock;
pub mod exec;
pub mod fs;
#[cfg(not(target_arch = "wasm32"))]
pub mod local;
#[cfg(not(target_arch = "wasm32"))]
pub mod native;
pub mod net;
pub mod store;
pub mod sync;
#[cfg(test)]
pub mod test;
pub mod types;
pub mod ui;
pub mod web;

use self::{
    clock::HostClock,
    exec::HostExec,
    fs::HostFs,
    net::HostNet,
    store::HostStore,
    sync::SyncPort,
    ui::HostUi,
    web::HostWeb,
};

use std::fmt::Debug;

/// Everything a turn reaches outside the engine, one port per kind.
pub trait Host: Clone + Debug + Default + 'static {
    /// Which tool half `Tool::execute` runs.  Only `LocalHost` says false; it and the native
    /// `std::fs` half go together at R1, when a native host arrives that says true.
    const HOSTED: bool;
    type Fs:    HostFs;
    type Exec:  HostExec;
    type Net:   HostNet;
    type Clock: HostClock;
    type Store: HostStore;
    type Ui:    HostUi;
    type Sync:  SyncPort;
    type Web:   HostWeb;
    fn fs(&self)    -> &Self::Fs;
    fn exec(&self)  -> &Self::Exec;
    fn net(&self)   -> &Self::Net;
    fn clock(&self) -> &Self::Clock;
    fn store(&self) -> &Self::Store;
    fn ui(&self)    -> &Self::Ui;
    fn sync(&self)  -> &Self::Sync;
    fn web(&self)   -> &Self::Web;
}

/// The host a `ToolContext` carries when nobody names one.
#[cfg(target_arch = "wasm32")]
pub type DefaultHost = crate::wasm::host::WasmHost;
/// The host a `ToolContext` carries when nobody names one.
#[cfg(not(target_arch = "wasm32"))]
pub type DefaultHost = local::LocalHost;

#[cfg(test)]
#[path = "../../../tests/unit/engine/host/tests.rs"]
mod tests;
