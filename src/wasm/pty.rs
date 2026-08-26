//! The terminal's edge — thin bindings to the JS relay `window.DaimondPty`.
//!
//! The sibling of [`crate::wasm::hand`], and for the same reason: a web page
//! cannot create a process, so the capability lives in a program outside the
//! page and this file is the narrow part of that road.  What differs is the
//! shape of the conversation.  `hand::run` sends a command and waits for one
//! result; a terminal is a session -- bytes both ways for as long as the
//! program lives, a size the kernel has to be told about, and an ending that
//! arrives when the program decides rather than when the caller does.
//!
//! **The live bytes do not come through here.**  `window.DaimondPty` delivers
//! `output` to a subscriber in the page as raw bytes, because the thing drawing
//! a terminal is the page and a screen redrawn through wasm on every chunk
//! would be a boundary crossing per keystroke of output.  What crosses here is
//! the control surface: open one, type into it, tell it the window changed,
//! ask it to stop, and ask what is attached.
//!
//! **The fence is composed here, and nowhere else.**  A terminal session runs a
//! real program on the user's machine, so it goes through the same fence and
//! the same grant as `Tool::Run`: [`pty_request`] walks the identical path --
//! ask the hand what machine it is on, refuse a hand that cannot fence,
//! [`diamond_bounds`] then [`fence_spec`] -- and hands back the wire's own
//! `open` request with the compartment already in it.  The page asks for that
//! request and passes it through; it composes nothing, because a page that
//! composed a fence would be a second opinion about what a program may touch,
//! free to drift from the one the hand enforces.  [`open`] then takes the
//! request unchanged, and the relay refuses one arriving without a fence rather
//! than inventing a weaker path to the same machine.
//!
//! A rejection carries a plain-English `Error` a person or a model is meant to
//! read and act on, so its `message` is passed through **verbatim**, exactly as
//! the hand and Web panel edges do.  Wrapping one in an fe2o3 chain wraps ANSI
//! colour and a `src/*.rs:line` frame around the one sentence that matters, and
//! destroys the only instruction the reader gets.

use crate::llm::{
    extract_json_bool,
    extract_json_number,
    extract_json_string,
    extract_json_string_array,
    json_escape,
};
use crate::tools::{
    diamond_bounds,
    fence_enforced,
    fence_spec,
    normalise,
    refusal_line,
    Bound,
    Kit,
    Machine,
};
use crate::wasm::js_str;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;


#[wasm_bindgen]
extern "C" {

    /// The relay object the page installs at `window.DaimondPty`.
    #[wasm_bindgen(js_name = DaimondPty)]
    type Relay;

    /// Whether a hand is paired, whether this page can carry terminal
    /// messages, and how many sessions are open.
    #[wasm_bindgen(method)]
    fn status(this: &Relay) -> js_sys::Promise;

    /// Open a terminal, resolving with `{id, pid}` when one exists.
    #[wasm_bindgen(method)]
    fn open(this: &Relay, spec_json: &str) -> js_sys::Promise;

    /// Send keystrokes, as base64 of the raw bytes.
    #[wasm_bindgen(method)]
    fn input(this: &Relay, id: &str, data_b64: &str) -> js_sys::Promise;

    /// Tell the kernel the window changed size.
    #[wasm_bindgen(method)]
    fn resize(this: &Relay, id: &str, cols: u16, rows: u16) -> js_sys::Promise;

    /// Ask a terminal's program to stop.
    #[wasm_bindgen(method)]
    fn close(this: &Relay, id: &str, sig: &str) -> js_sys::Promise;
}


/// Reach the relay object on `window`, or refuse in the reader's language.
///
/// The refusal names the terminal specifically and says what still works: a
/// page without it can still run commands, and a user told only that something
/// failed will go looking for the wrong fault.
fn relay() -> Outcome<Relay> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("A terminal needs a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondPty"))
        .map_err(|e| err!("Reading window.DaimondPty failed: {}.", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!(
            "There is no terminal relay in this page, so no terminal can be \
            opened. Daimond runs in the browser and a browser cannot allocate a \
            terminal; the machine hand is a small companion that can. Commands \
            can still be run if a hand is paired -- only the interactive \
            terminal is unavailable.";
            System, Missing));
    }
    Ok(obj.unchecked_into::<Relay>())
}

/// The `message` of a rejected JS `Error`, verbatim, falling back to the
/// value's own rendering when it is not an `Error`.
fn refusal(e: &JsValue) -> String {
    match js_sys::Reflect::get(e, &JsValue::from_str("message")) {
        Ok(m)  => m.as_string().unwrap_or_else(|| js_str(e)),
        Err(_) => js_str(e),
    }
}

/// Render a resolved JS value as the JSON string a caller carries.
fn stringify(v: &JsValue) -> Outcome<String> {
    if v.is_undefined() || v.is_null() {
        return Ok("{}".to_string());
    }
    if let Some(s) = v.as_string() {
        return Ok(s); // the relay resolved with JSON already
    }
    match js_sys::JSON::stringify(v) {
        Ok(s)  => Ok(String::from(s)),
        Err(e) => Err(err!(
            "The terminal relay returned a result that cannot be read: {}.", refusal(&e);
            Invalid, Data)),
    }
}

/// Await a relay promise, passing a refusal through untouched.
async fn settle(promise: js_sys::Promise) -> Outcome<String> {
    match JsFuture::from(promise).await {
        Ok(v)  => stringify(&v),
        Err(e) => Err(err!("{}", refusal(&e); IO, Invalid)),
    }
}

/// Await a relay promise, turning a refusal into the refusal JSON a caller
/// renders rather than into an error.
///
/// The same choice `hand::run` makes, and for the same reason: every rejection
/// from the relay is a whole sentence written to be acted on -- the hand is not
/// installed, the user declined, it stopped part-way, the request had no
/// fence -- and an `Err` reaches the reader wrapped in an fe2o3 chain around
/// the one sentence that matters.  A terminal that will not open has been
/// refused, so it is handed on as a refusal and rendered as one.
async fn settle_or_refuse(promise: js_sys::Promise) -> Outcome<String> {
    match JsFuture::from(promise).await {
        Ok(v)  => stringify(&v),
        Err(e) => Ok(fmt!(r#"{{"refused":"{}"}}"#, crate::llm::json_escape(&refusal(&e)))),
    }
}

/// Whether a hand is paired, whether this page carries terminal messages, and
/// how many sessions are open.
///
/// It never refuses: a caller asking what is attached is owed an answer, and
/// the JSON carries a `reason` sentence when the answer is "nothing".
pub async fn status() -> Outcome<String> {
    let r = res!(relay());
    settle(r.status()).await
}

/// Open a terminal and attach a program to it.
///
/// # Arguments
/// * `spec_json` - The `open` request, already rendered as the wire's JSON and
///   already carrying the fence [`crate::tools::fence_spec`] computed.  It is
///   passed through unchanged, so there is one place a request is composed and
///   it is the one that holds the compartment.
///
/// # Returns
/// `{"id":…,"pid":…}` once the terminal exists, or `{"refused":…}` carrying the
/// sentence saying why there is none.
pub async fn open(spec_json: &str) -> Outcome<String> {
    let r = res!(relay());
    settle_or_refuse(r.open(spec_json)).await
}

/// Send keystrokes to a terminal.
///
/// Base64 in, because a terminal is a byte stream: `Ctrl-C`, an arrow key and a
/// bracketed paste are all just bytes the program is entitled to see exactly as
/// they were typed, and a lossy text conversion corrupts precisely the case a
/// terminal exists to handle.
///
/// # Arguments
/// * `id` - The session, as `open` returned it.
/// * `data_b64` - Base64 of the bytes typed.
pub async fn input(id: &str, data_b64: &str) -> Outcome<String> {
    let r = res!(relay());
    settle_or_refuse(r.input(id, data_b64)).await
}

/// Tell the kernel the window changed size, which tells the program.
///
/// # Arguments
/// * `id` - The session.
/// * `cols` - Columns.
/// * `rows` - Rows.
pub async fn resize(id: &str, cols: u16, rows: u16) -> Outcome<String> {
    let r = res!(relay());
    settle_or_refuse(r.resize(id, cols, rows)).await
}

/// Ask a terminal's program to stop.
///
/// # Arguments
/// * `id` - The session.
/// * `sig` - `"term"` to ask, `"kill"` to insist, `"int"` to interrupt as
///   `Ctrl-C` would.  Asking is the default the relay applies to anything else:
///   a shell given `SIGTERM` writes out its history, and one given `SIGKILL`
///   does not.
pub async fn close(id: &str, sig: &str) -> Outcome<String> {
    let r = res!(relay());
    settle_or_refuse(r.close(id, sig)).await
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Composing the request                                          │
// └───────────────────────────────────────────────────────────────┘
//
// Everything below this line is the terminal's half of what `Tool::Run` does in
// `src/tools.rs`, and it is deliberately the same walk in the same order: ask
// the hand what machine it is standing on, refuse a hand that cannot fence,
// turn the Diamond's workspace into bounds, turn the bounds into a compartment,
// and say what may run inside it.  Only the last two lines differ, because a
// terminal is a session rather than a result.
//
// **The verb split does not reach here.**  A scope leaves READING free at the
// file tools (`tools::Bound::OnlyWriteUnder`), and `fence_spec` deliberately
// does not follow it: a program is opaque, so a terminal reaches the folders
// the user marked in and nothing else, exactly as it did before.  A session is
// a person at a keyboard running programs of their own choosing, which is the
// case for keeping that fence rather than relaxing it.

/// The terminal a person is given when nobody named a program and the hand did not say.
///
/// `/bin/sh` is the one program POSIX promises is there, so it is what a terminal falls back
/// to -- but it is a FALLBACK now and no longer the answer.  On this machine `/bin/sh` is
/// `dash`: no prompt worth the name, no history, no completion, and none of the user's own
/// aliases, so a person opening a terminal in Daimond met a shell belonging to nobody.
///
/// The page still cannot read an environment.  The HAND can, and now says so: `shell:<path>`
/// rides in its `hello` beside `home:` and `host:`, taken from the `SHELL` the login session
/// set, which is what every other terminal on that machine opens.  Where it said nothing --
/// an older hand, a `SHELL` that is unset or relative -- this is what is left, because a
/// guessed shell is a terminal that opens on a refusal.
const SHELL: &str = "/bin/sh";

/// The largest terminal this edge will ask for, in cells each way.
///
/// The extension refuses anything past it and the wire carries a `u16`, so a
/// bigger number is not a bigger terminal but a frame the hand cannot read.
const CELLS_MAX: u64 = 2000;

/// Columns assumed when the page did not say.
const COLS_DEFAULT: u64 = 80;

/// Rows assumed when the page did not say.
const ROWS_DEFAULT: u64 = 24;

/// A refusal as the caller renders it: one sentence, in JSON.
fn refused(reason: &str) -> String {
    fmt!(r#"{{"refused":"{}"}}"#, json_escape(&refusal_line(reason)))
}

/// A size the wire can carry, from whatever the page offered.
///
/// # Arguments
/// * `ask` - The page's request JSON.
/// * `key` - `"cols"` or `"rows"`.
/// * `dflt` - What to assume when the page did not say.
fn cells(ask: &str, key: &str, dflt: u64) -> u64 {
    match extract_json_number(ask, key) {
        Some(n) if n >= 1 => n.min(CELLS_MAX),
        _                 => dflt,
    }
}

/// Whether the absolute `path` sits at or beneath one of `roots`, comparing
/// whole segments so `/w/notes` is not "inside" `/w/note`.
///
/// A near-copy of `under` in [`crate::tools`], which is private there and works
/// on workspace-relative paths; this one compares the ABSOLUTE paths the fence
/// is written in, which is what the extension and the hand both compare.
///
/// # Arguments
/// * `path` - An absolute path.
/// * `roots` - Absolute roots.
fn inside(path: &str, roots: &[String]) -> bool {
    roots.iter().any(|r| {
        let root = r.trim_end_matches('/');
        path == root || path.starts_with(&fmt!("{}/", root))
    })
}

/// The wire's `open` request for a terminal in a Diamond, fence and all.
///
/// This is the whole of the fence question for a terminal, and it is the same
/// walk `Tool::Run` makes.  The page hands over what only it knows -- which
/// Diamond, what the user attached, how big the panel is -- and gets back
/// either the request the wire carries or the sentence saying why there is
/// none.  It never rejects: a refusal is written to be read, and an `Err`
/// reaches the reader wrapped in an fe2o3 chain around the one sentence that
/// matters.
///
/// Three things are settled and none of them is a caller's to change.  A
/// toolkit is never inferred from what was asked to run -- it is granted by the
/// user, arrives as a name, and resolves through [`Kit::resolve`] exactly as it
/// does for a command.  The fence is never widened by anything a model says:
/// `argv` reaches neither the compartment nor the environment.  And `TERM` is
/// not sent, because the hand sets it and refuses a caller who names it -- a
/// page that could name it could promise a program capabilities nothing on the
/// other end can draw.
///
/// # Arguments
/// * `ask_json` - What the page knows, as JSON:
///   `{own_dir, attached, read_only, cwd, cols, rows}`, plus the optional
///   `argv` (defaulting to [`SHELL`]), `toolkits` (the names the user granted
///   this Diamond) and `tainted` (a session belonging to a turn that has read a
///   stranger's words, which loses the network).
///
/// # Returns
/// The `open` request as the wire spells it, or `{"refused":"…"}`.
#[wasm_bindgen]
pub async fn pty_request(ask_json: String) -> String {
    let ask = ask_json.as_str();
    // Where the hand's grant reaches on this machine. The page cannot know it:
    // a real folder arrives through the File System Access API as a handle and
    // never a path, so the hand is asked and its answer is what the fence is
    // expressed against.
    let st = match crate::wasm::hand::status().await {
        Ok(s)  => s,
        Err(e) => return refused(&e.msgs().join(" ")),
    };
    if extract_json_bool(&st, "paired") != Some(true) {
        return refused(&extract_json_string(&st, "reason").unwrap_or_else(|| fmt!(
            "There is no machine hand paired with this browser, so there is nothing to open a \
            terminal on. Daimond runs in the browser and a browser cannot allocate a terminal.")));
    }
    let machine = Machine::from_status(&st);
    // An ABSENT root and an EMPTY one are the same answer and are refused
    // alike: the hand compares paths with `starts_with`, for which every path
    // on the machine is under "".
    if !machine.rooted() {
        return refused(
            "The machine hand did not say which folder it was granted, so there is no way to say \
            what a terminal may touch. It is not safe to guess, so none was opened.");
    }
    // Release gate 1, applied to a session: a program that cannot be fenced is
    // REFUSED, never run unfenced and mentioned afterwards. The test is
    // affirmative -- silence is not a fence.
    if !fence_enforced(&machine.caps) {
        return refused(&fmt!(
            "the machine hand on this computer {}, so nothing would stop a program in a terminal \
            reaching the rest of the machine. Daimond will not open a terminal it cannot contain. \
            Tell the user; the file tools work regardless.",
            if machine.caps.iter().any(|c| c == "fence:none") {
                "says it cannot fence a program"
            } else {
                "did not say it can fence a program"
            }));
    }
    // A terminal is a pseudo-terminal device, which is a POSIX thing. Refused
    // here rather than left to fail two layers down with a system error nobody
    // could act on.
    if machine.os == "windows" {
        return refused(
            "This machine's hand runs on Windows, where the terminal Daimond opens -- a POSIX \
            pseudo-terminal -- does not exist. Commands can still be run.");
    }

    let own_dir   = extract_json_string(ask, "own_dir").unwrap_or_default();
    let attached  = extract_json_string_array(ask, "attached").unwrap_or_default();
    let read_only = extract_json_string_array(ask, "read_only").unwrap_or_default();
    let mut bounds = diamond_bounds(&own_dir, &attached, &read_only);
    // The toolchains the user granted this Diamond, and nothing else. The names
    // come from what they decided, never from `argv`: a fence that widened
    // itself to fit the program asked for would be a fence the caller chooses,
    // and the whole arrangement rests on its not being one.
    // `terminal_toolkit_bounds` and not `toolkit_bounds`, and the difference is the whole of
    // the trust boundary: the Remote toolkit lends an ssh key, and an ssh reaches a shell on
    // another machine that nothing here fences. A person opened this surface and is typing into
    // it; a daimon's `run` never can, because `toolkit_bounds` -- which is what every other
    // caller uses -- drops the rule. See `Toolkit::terminal_only`.
    bounds.extend(crate::tools::terminal_toolkit_bounds(
        &extract_json_string_array(ask, "toolkits").unwrap_or_default()));

    // A tainted session loses the network, the same rule `egress_check` applies
    // to a URL -- and now the same rule the user's PERMISSION MODE governs. The
    // rung is read from `tools::mode()` and never taken from the ask: a page
    // that could name its own rung could grant itself one, which is the same
    // objection that keeps a toolkit out of `argv`. Only the page can say
    // whether the session is tainted, and it can only ever say it in the
    // narrowing direction: absent, and the answer is "not tainted", which is
    // what a terminal the user opened by hand is.
    //
    // The rung reaches a terminal through THIS question and no other, which is
    // a decision rather than an omission. `Mode::Ask` puts a command to the user
    // before it runs; the person typing into a terminal has already asked, and
    // a dialog over their own keystrokes would be the app asking permission to
    // do what they are in the middle of doing.
    let tainted = extract_json_bool(ask, "tainted") == Some(true);
    let fence = fence_spec(&bounds, &machine, crate::tools::mode().withholds_net(tainted));
    if fence.rw.is_empty() && fence.ro.is_empty() {
        // Two states arrive here and a person can only act on one of them, so they are told
        // apart. A Diamond that named itself and nothing else is the ORDINARY case -- a fresh
        // Diamond, with a Terminal panel and no folder yet -- and the sentence it gets has to
        // say what to do about it, or the user meets a wall with no door in it. A scope naming
        // nowhere at all is the panel having no Diamond to ask for, which is a different
        // situation and no amount of attaching would fix.
        return refused(if bounds.iter().any(|b| matches!(b, Bound::Nowhere)) {
            "there is no Diamond here for a terminal to belong to, so there is nothing to say \
            what one may touch. Open a Diamond and try again."
        } else {
            "this Diamond has no folder on this computer attached to it, so there is nowhere for \
            a terminal to run. A Diamond's own files live in Daimond's storage, which is not a \
            place on this computer. Attach a folder in the Workspace panel, then open the \
            terminal again."
        });
    }

    let root = machine.root.trim_end_matches('/').to_string();
    // Where the session starts, by the same rule a command starts by: `tools::start_dir`, which
    // both edges now share. The panel sends the Diamond's own directory as the `cwd`, because
    // that is what a Diamond IS to it -- and that directory is in the browser's storage and not
    // on this machine, so a session that took it literally asked for a terminal outside its own
    // fence and was refused. Every Diamond terminal, including one with a folder attached and
    // nothing whatever wrong with it.
    let asked = normalise(&extract_json_string(ask, "cwd").unwrap_or_default());
    let cwd_rel = if asked.is_empty() || crate::tools::is_store_path(&asked) {
        crate::tools::start_dir(&bounds)
    } else {
        asked
    };
    let cwd = if cwd_rel.is_empty() { root.clone() } else { fmt!("{}/{}", root, cwd_rel) };
    // The hand refuses a working directory outside the fence, and so does the
    // extension. Refused here as well, where the sentence can still name the
    // folder the caller asked for rather than the absolute path two layers down.
    if !inside(&cwd, &fence.rw) && !inside(&cwd, &fence.ro) {
        return refused(&fmt!(
            "a terminal was asked for in \"{}\", which is outside what this Diamond may touch. A \
            session starts inside the folders the user attached to it.", cwd));
    }

    let argv = match extract_json_string_array(ask, "argv") {
        Some(v) if !v.is_empty() && !v[0].trim().is_empty() => v,
        // The user's own login shell where the hand named one, and [`SHELL`] where it did
        // not. Taken from the machine and never from the ask, exactly as the fence is: a page
        // that could name the program could name one outside the fence and be refused two
        // layers down in a sentence about a path nobody chose.
        _ => vec![machine.shell.clone().unwrap_or_else(|| SHELL.to_string())],
    };
    let argv_json: Vec<String> = argv.iter().map(|a| fmt!("\"{}\"", json_escape(a))).collect();

    // The environment is not a caller's to set, exactly as it is not for a
    // command: what goes here is the granted toolkit's own two or three names,
    // from the table in `src/tools.rs`, or nothing at all. `TERM` is pointedly
    // absent -- the hand sets it and REFUSES a session that names it.
    let env_json = match Kit::resolve(&bounds, &machine) {
        Some(kit) => kit.env_json(),
        None      => fmt!("[]"),
    };

    // No `id`: the relay mints one, because it is the end that knows which
    // sessions this page already has open and an id has to be unique among
    // those. Everything else is composed here, once.
    // The granted toolkit names travel with the fence, as they do for a command: the hand clamps
    // an arriving fence against the toolchains it was told were granted, and a toolchain folder is
    // not under the granted root, so it cannot check the one without the other. Read back out of
    // the bounds rather than echoed from the ask, so an unknown name is dropped here and never
    // reaches the wire.
    fmt!(
        r#"{{"t":"open","argv":[{}],"cwd":"{}","env":{},"size":{{"cols":{},"rows":{}}},"fence":{},"toolkits":{}}}"#,
        argv_json.join(","),
        json_escape(&cwd),
        env_json,
        cells(ask, "cols", COLS_DEFAULT),
        cells(ask, "rows", ROWS_DEFAULT),
        fence.to_json(),
        crate::tools::toolkit_names_json(&bounds),
    )
}
