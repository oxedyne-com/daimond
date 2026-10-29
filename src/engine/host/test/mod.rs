//! TestHost, the native host the engine's tests run the hosted tool half on: an in-memory Fs, a
//! fixed Clock, a Store that fails closed, and refusals for the rest.

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
    clock::TestClock,
    exec::TestExec,
    fs::TestFs,
    net::TestNet,
    store::TestStore,
    ui::TestUi,
    web::TestWeb,
};

/// TestHost's sync port.
#[derive(Clone, Debug, Default)]
pub struct TestSync;

impl SyncPort for TestSync {}

/// TestHost: one field per port.
#[derive(Clone, Debug, Default)]
pub struct TestHost {
    fs:    TestFs,
    exec:  TestExec,
    net:   TestNet,
    clock: TestClock,
    store: TestStore,
    ui:    TestUi,
    sync:  TestSync,
    web:   TestWeb,
}

impl Host for TestHost {
    const HOSTED: bool = true;
    type Fs    = TestFs;
    type Exec  = TestExec;
    type Net   = TestNet;
    type Clock = TestClock;
    type Store = TestStore;
    type Ui    = TestUi;
    type Sync  = TestSync;
    type Web   = TestWeb;
    fn fs(&self) -> &TestFs { &self.fs }
    fn exec(&self) -> &TestExec { &self.exec }
    fn net(&self) -> &TestNet { &self.net }
    fn clock(&self) -> &TestClock { &self.clock }
    fn store(&self) -> &TestStore { &self.store }
    fn ui(&self) -> &TestUi { &self.ui }
    fn sync(&self) -> &TestSync { &self.sync }
    fn web(&self) -> &TestWeb { &self.web }
}

/// THE HOSTED HALF RUNS ON A NON-WASM HOST (u2_plan.md §9, U2d): a tool, and a whole model turn,
/// reach the world through TestHost's ports and not through `std::fs`, and the fence stands in
/// front of the port.
#[cfg(test)]
#[path = "../../../../tests/unit/engine/host/test/tests.rs"]
mod tests;
