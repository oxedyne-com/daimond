//! Daimond — AI agent and web chatbot for the Hematite Steel server.
//!
//! Daimond provides a web-based chat interface to an LLM (via an OpenAI-compatible
//! API) with tool-calling capability.  It replaces the tmux/PTY terminal
//! bridge approach with a structured WebSocket protocol using JDAT
//! serialisation.
//!
//! Key components:
//!
//! - [`llm`] — async LLM client with SSE streaming
//! - [`agent`] — the agent loop: message → LLM → tools → streamed response
//! - [`protocol`] — WS message types (JDAT serialisation)

#![forbid(unsafe_code)]

pub mod activity;
pub mod agent;
pub mod executor;
/// Crystal version history as a delta log: when a version stores a full copy
/// and when it stores splices, and which stored files rebuild any one version.
pub mod diamond_delta;
/// The pure core of a Diamond's `meta.json` — its shape, its parse/serialise
/// pair, and tag normalisation.  Target-agnostic, so it is tested natively
/// while the OPFS edge over it stays in [`wasm::diamond`].
pub mod diamond_link;
pub mod diamond_meta;
/// Which of a Diamond's files are page logs: the paths a crystal page has appended to, recorded so
/// the import can join them line by line.  Target-agnostic; the store's edge is [`store::diamond`].
pub mod diamond_pagelog;
/// What an import does with this device's own history before it lays another device's copy of a
/// Diamond over it: which versions are this device's alone, and the files that refile each one
/// whole above both histories.  Target-agnostic, so the plan is tested natively while the OPFS
/// edge that carries it out stays in [`wasm::diamond`].
pub mod diamond_rebase;
/// What a Diamond's FILES held before the change that overwrote them: the per-version manifest,
/// the content-addressed bodies under it, the sparse "as at N" resolver, the prune order and the
/// reference-count sweep.
///
/// Target-agnostic on purpose, like the delta log beside it: the OPFS edge is compiled for the
/// browser alone, so what decides -- what a manifest says, what a path held at a version, and
/// what a prune is willing to throw away -- is tested natively instead.
pub mod diamond_versions;
/// The runtime pieces a turn runs on: the race a Stop wins, and the per-session actor.
pub mod engine;
pub mod errand;
/// How one path component is spelled on a filesystem that will not take it as it stands.
///
/// Target-agnostic on purpose: the rules are a browser's, but the codec is a pure string
/// transform whose reversibility is the whole of its correctness, and that is provable
/// natively rather than only in a page.  The edge that applies it is [`wasm::opfs`].
pub mod fork;
pub mod fsname;
/// Handles kept by path, so a filesystem edge walks a path once (OPFSLEAK).
pub mod handle_cache;
/// The question a turn puts before it changes a file the person made, and what each answer
/// means.  Target-agnostic; the asking edge is `wasm::deletes::ask_change`.
pub mod held_change;
/// How fast each host serves each model, and the hosts routing leaves out (D-20261020-10).
pub mod hostspeed;
pub mod image_edit;
pub mod llm;
pub mod marks;
/// One address check for every request a remote party's word sends out (R3 F1).
#[cfg(not(target_arch = "wasm32"))]
pub mod net_guard;
/// The system prompt each kind of agent runs under, and the part of it a user
/// may replace from their workspace.
/// What a model's own dialect needs, read off the provider's slug: the prompt addendum it
/// carries, the tools and schema shapes it is offered, and how generously its arguments are read.
///
/// Target-agnostic, so the wire fixtures the rules were written against are held by native unit
/// tests rather than only by a page.
pub mod profile;
pub mod prompts;
pub mod protocol;
/// Per-product rating: product handles, the author a version entry names, form `daimond/1` and the
/// rating record.  Target-agnostic, so the gateway can link the same form it validates against.
pub mod rating;
/// The seal: post, peer-envelope and account-wrap records, one code path for wasm and native.
pub mod seal;
/// Named instruction bundles, and the two ways a turn invokes one.
///
/// Target-agnostic on purpose.  The directory walk ([`skills::list_skills`]) is `std::fs`, native
/// only, and has had no caller since the native `handler` went (P1.2); the parts that decide what a `/name` means and what the
/// model is finally handed are pure, and the browser drives them over OPFS from `wasm::app` --
/// because in the browser, which is where the user actually works, this module used to compile and
/// be read by nothing.
pub mod skills;
/// `STATE.md` as keyed sections, rendered and retired by the engine rather than refused
/// (UNBLOCK-18).  Pure; the store's half is `store::diamond::standing_retired`.
pub mod state_md;
/// The three standing files read and seeded through one store, proved without a browser.
pub mod standing;
/// The one block of a person's standing notes composed into the chat's and the daimon's prompt,
/// and the lint that keeps a note from asking the model to chase approval.
///
/// Target-agnostic, so the cap and the lint are held by native unit tests, and the page asks
/// the wasm for the same verdict the engine acts on.
pub mod steering;
/// The Diamond store: its backend (primitives, locks, environment) and the codec its calls and
/// replies travel in across a process boundary.
pub mod store;
pub mod syntax;
pub mod tools;
pub mod turn_state;
pub mod turn_log;
/// The browser (wasm32) entry surface — a `#[wasm_bindgen]` API plus the
/// OPFS filesystem edge.  Gated to wasm32 so the native build never sees
/// `wasm-bindgen`'s generated glue.
#[cfg(target_arch = "wasm32")]
pub mod wasm;
pub mod workspace;
