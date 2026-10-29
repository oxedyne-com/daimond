//! Agent tools — the "coding" half of Daimond.
//!
//! Tools are modelled as an enum (favouring concrete types over dynamic
//! dispatch, per the Oxedyne style) rather than a trait-object registry.
//! Each variant knows its name, description, JSON-schema parameters, and
//! how to execute against a [`ToolContext`] (workspace + executor).
//!
//! Arguments arrive as the raw JSON string from the LLM's `tool_call`;
//! each tool extracts the fields it needs with the same manual JSON
//! helpers used by the LLM client — no `serde`.

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_file::relpath::Fault;
use oxedyne_fe2o3_file::relpath::RelPath;
// `Media` names a file's format from its extension, which is how `file_read` tells a Word document
// from any other ZIP: every Office format IS a ZIP and the bytes alone cannot separate them.
use oxedyne_fe2o3_stds::media::Media;
use oxedyne_fe2o3_text::base64;
use oxedyne_fe2o3_text::glob::Glob;
use oxedyne_fe2o3_text::regex::{self, Regex};

use crate::engine::host::{DefaultHost, Host};
use crate::engine::host::{
    clock::HostClock,
    exec::HostExec,
    fs::HostFs,
    net::HostNet,
    store::HostStore,
    ui::HostUi,
    web::HostWeb,
};
use crate::engine::host::types::store::{Landed, SettlePhase};
use crate::executor::Executor;
use crate::llm::{
    extract_json_bool,
    extract_json_f64,
    extract_json_number,
    extract_json_objects,
    extract_json_string,
    extract_json_string_array,
    json_escape,
};
use crate::llm::extract_json_i64;
use crate::diamond_versions::Found;
use crate::protocol::{ContentPart, Dropped, ImageMedia, ImagePart, MessageContent};

use oxedyne_fe2o3_jdat::Dat;
use oxedyne_fe2o3_jdat::{FromDat, ToDat};
use crate::workspace::Workspace;

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

// The pieces, in the file's former order: `macro_rules!` is textual, so a macro reaches only
// the pieces declared after the one that defines it.
#[macro_use] mod state;	// a turn's state, the read cache, file formats, the store's roots
#[macro_use] mod doc;	// crystals, recall, skill and keeper bounds, outline, search
#[macro_use] mod run;	// toolchains, a turn's bounds, secret names
#[macro_use] mod file;	// the two filesystems and the file tools' doors
#[macro_use] mod web;	// strangers' content, autonomy, packs, reaching out, push
#[macro_use] mod context;	// what a run leaves, `ToolContext`, the licence, spend
#[macro_use] mod pending;	// a daimon's lines on the Pending panel
#[macro_use] mod tool;	// `Tool`: belts, names, descriptions, parameters
#[macro_use] mod dispatch;	// `Tool::execute_inner`, reads, search, mail, OCR
#[macro_use] mod file_ops;	// the page's file writes, edits, moves and holds
#[macro_use] mod local;	// the native file tools, shell and `run`
#[macro_use] mod verify;	// `verify`, `serve` and a project's own check
#[macro_use] mod registry;	// `ToolRegistry`, several reads in one round, crystal looks

// `dispatch`, `file_ops` and `local` hold only `impl Tool` methods, so they have nothing to re-export.
pub use state::*;
pub use doc::*;
pub use run::*;
pub use file::*;
pub use web::*;
pub use context::*;
pub(crate) use pending::*;	// nothing in it is wider than the crate
pub use tool::*;
pub use verify::*;
pub use registry::*;

#[cfg(test)]
#[path = "../../tests/unit/tools/spawn_context_tests.rs"]
mod spawn_context_tests;

#[cfg(test)]
#[path = "../../tests/unit/tools/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../../tests/unit/tools/no_wasm_memory_views.rs"]
mod no_wasm_memory_views;

#[cfg(test)]
#[path = "../../tests/unit/tools/read_prefix_tests.rs"]
mod read_prefix_tests;

#[cfg(test)]
#[path = "../../tests/unit/tools/claim_tests.rs"]
mod claim_tests;

#[cfg(test)]
#[path = "../../tests/unit/tools/crystal_load_proof.rs"]
mod crystal_load_proof;

#[cfg(test)]
#[path = "../../tests/unit/tools/debug_node_check.rs"]
mod debug_node_check;

#[cfg(test)]
#[path = "../../tests/unit/tools/tests_restore.rs"]
mod tests_restore;

#[cfg(test)]
#[path = "../../tests/unit/tools/tests_utf8_text.rs"]
mod tests_utf8_text;

#[cfg(test)]
#[path = "../../tests/unit/tools/crystal_hot_mend.rs"]
mod crystal_hot_mend;

/// ALERT-PENDING (D-20261016-17): a daimon raises and clears an alert on the Pending panel.
#[cfg(test)]
#[path = "../../tests/unit/tools/tests_pending.rs"]
mod tests_pending;

#[cfg(test)]
#[path = "../../tests/unit/tools/made1.rs"]
mod made1;

// The pieces' own text, in their order above, for the tests that read the tools' source.
#[cfg(test)]
const SOURCE: [&str; 13] = [
    include_str!("state.rs"),
    include_str!("doc.rs"),
    include_str!("run.rs"),
    include_str!("file.rs"),
    include_str!("web.rs"),
    include_str!("context.rs"),
    include_str!("pending.rs"),
    include_str!("tool.rs"),
    include_str!("dispatch.rs"),
    include_str!("file_ops.rs"),
    include_str!("local.rs"),
    include_str!("verify.rs"),
    include_str!("registry.rs"),
];

/// The tools' whole product source as one text, the pieces in order, for the tests that scan it.
#[cfg(test)]
pub(crate) fn source() -> String {
    SOURCE.concat()
}
