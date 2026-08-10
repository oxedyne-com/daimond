//! The Web panel edge — thin bindings to the JS driver `window.DaimondWeb`.
//!
//! `DaimondWeb` is the one interface the agent's web tools call, and it
//! hides which driver is attached (none, an iframe, or the Daimond Hands
//! extension), so the tools do not change when the extension appears.
//! Every method returns a `Promise`; each binding below awaits it and
//! hands back the resolved JSON, stringified.
//!
//! A rejection carries a plain-English `Error` the model is meant to read
//! and act on ("No page is open. Call web_open first."), so its `message`
//! is passed through **verbatim**: no prefix, no rewording.  Mangling it
//! would destroy the only instruction the model gets about what to do
//! next.

use crate::llm::json_escape;
use crate::tools::SearchAnswer;
use crate::tools::SearchHit;
use crate::tools::Verdict;
use crate::wasm::js_str;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;


#[wasm_bindgen]
extern "C" {

    /// The driver object the Web panel installs at `window.DaimondWeb`.
    #[wasm_bindgen(js_name = DaimondWeb)]
    type Driver;

    /// Which driver is attached, what is open, and who is driving.
    #[wasm_bindgen(method)]
    fn status(this: &Driver) -> js_sys::Promise;

    /// Dock the panel and navigate it to `url`.
    #[wasm_bindgen(method)]
    fn open(this: &Driver, url: &str) -> js_sys::Promise;

    /// Read `url` through the gateway, without a driver.
    #[wasm_bindgen(method)]
    fn fetch(this: &Driver, url: &str) -> js_sys::Promise;

    /// The accessibility tree of the open page.
    #[wasm_bindgen(method)]
    fn snapshot(this: &Driver) -> js_sys::Promise;

    /// The rendered text of the open page.
    #[wasm_bindgen(method)]
    fn read(this: &Driver) -> js_sys::Promise;

    /// Click the node named by `node_ref`.
    #[wasm_bindgen(method)]
    fn click(this: &Driver, node_ref: u32) -> js_sys::Promise;

    /// Type into the node named by `node_ref` (`type` is a Rust keyword).
    #[wasm_bindgen(method, js_name = "type")]
    fn type_into(this: &Driver, node_ref: u32, text: &str, submit: bool) -> js_sys::Promise;

    /// Scroll the open page; `amount` may be `undefined` for the default.
    #[wasm_bindgen(method)]
    fn scroll(this: &Driver, dir: &str, amount: JsValue) -> js_sys::Promise;

    /// Undock the panel and drop the page.
    #[wasm_bindgen(method)]
    fn close(this: &Driver) -> js_sys::Promise;
}


#[wasm_bindgen]
extern "C" {

    /// The search half the app installs at `window.DaimondSearch`.
    ///
    /// A global of its own rather than a `DaimondWeb` method, because it holds something the
    /// Web panel's driver knows nothing about: WHICH ENGINE the user chose, and the key that
    /// pays for it.  Keeping that on the driver would put the user's setting behind the thing
    /// that owns pages, and searching needs no page at all.
    #[wasm_bindgen(js_name = DaimondSearch)]
    type Searcher;

    /// Run one query, with the engine and any key the user's settings supply.
    ///
    /// Renamed on the Rust side only because [`search`] below is the function callers use; the
    /// JavaScript method is `search`, exactly as the contract names it.
    #[wasm_bindgen(method, js_name = "search")]
    fn run_query(this: &Searcher, query: &str, opts: &JsValue) -> js_sys::Promise;
}


/// Reach the driver object on `window`, or refuse in the model's language.
fn driver() -> Outcome<Driver> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("The web tools need a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondWeb"))
        .map_err(|e| err!("Reading window.DaimondWeb failed: {}.", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!(
            "The Web panel is not loaded in this page, so there is nothing to drive. \
            Tell the user, and carry on without the web tools.";
            System, Missing));
    }
    Ok(obj.unchecked_into::<Driver>())
}

/// The `message` of a rejected JS `Error`, verbatim, falling back to the
/// value's own rendering when it is not an `Error`.
fn refusal(e: &JsValue) -> String {
    match js_sys::Reflect::get(e, &JsValue::from_str("message")) {
        Ok(m)  => m.as_string().unwrap_or_else(|| js_str(e)),
        Err(_) => js_str(e),
    }
}

/// Render a resolved JS value as the JSON string the tool result carries.
fn stringify(v: &JsValue) -> Outcome<String> {
    if v.is_undefined() || v.is_null() {
        return Ok("{}".to_string());
    }
    if let Some(s) = v.as_string() {
        return Ok(s); // the driver resolved with JSON already
    }
    match js_sys::JSON::stringify(v) {
        Ok(s)  => Ok(String::from(s)),
        Err(e) => Err(err!(
            "The Web panel returned a result that cannot be read: {}.", refusal(&e);
            Invalid, Data)),
    }
}

/// Await a driver promise, passing a refusal through untouched.
async fn settle(promise: js_sys::Promise) -> Outcome<String> {
    match JsFuture::from(promise).await {
        Ok(v)  => stringify(&v),
        Err(e) => Err(err!("{}", refusal(&e); Network, Invalid)),
    }
}

/// Which driver is attached, what is open, and who is driving.
pub async fn status() -> Outcome<String> {
    let d = res!(driver());
    settle(d.status()).await
}

/// The address of the page currently open, or empty when nothing says.
///
/// Best effort: the driver reports its state as JSON, and the one field wanted here is the URL.
/// An action on a page has no address of its own, so this is what names the destination.
pub async fn current_url() -> String {
    let st = match status().await {
        Ok(s)  => s,
        Err(_) => return String::new(),
    };
    let key = "\"url\":\"";
    let from = match st.find(key) {
        Some(i) => i + key.len(),
        None    => return String::new(),
    };
    match st[from..].find('"') {
        Some(end) => st[from..from + end].to_string(),
        None      => String::new(),
    }
}

/// Show `url` in the Web panel.
pub async fn open(url: &str) -> Outcome<String> {
    let d = res!(driver());
    settle(d.open(url)).await
}

/// Read `url` through the gateway, driver or no driver.
pub async fn fetch(url: &str) -> Outcome<String> {
    let d = res!(driver());
    settle(d.fetch(url)).await
}

// ── Searching ───────────────────────────────────────────────────────

/// Reach the search object on `window`, or refuse in the model's language.
///
/// Separate from [`driver`] because the two can be absent independently: a build with a Web
/// panel and no search settings is a real state, and telling the model the Web panel is missing
/// would send it looking in the wrong place.
fn searcher() -> Outcome<Searcher> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("Searching needs a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondSearch"))
        .map_err(|e| err!("Reading window.DaimondSearch failed: {}.", js_str(&e);
            System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!(
            "Search is not set up in this page, so there is nothing to search with. \
            Tell the user, and carry on without it.";
            System, Missing));
    }
    Ok(obj.unchecked_into::<Searcher>())
}

/// Put one option on the object handed to the search driver.
///
/// # Arguments
/// * `obj` - The options object being built.
/// * `key` - The option's name.
/// * `val` - Its value.
fn set(obj: &js_sys::Object, key: &str, val: JsValue) -> Outcome<()> {
    match js_sys::Reflect::set(obj, &JsValue::from_str(key), &val) {
        Ok(_)  => Ok(()),
        Err(e) => Err(err!("Building the search request failed at '{}': {}.", key, js_str(&e);
            System, Invalid)),
    }
}

/// A string property of a JavaScript object, empty where it is absent or is not a string.
fn prop(v: &JsValue, key: &str) -> String {
    match js_sys::Reflect::get(v, &JsValue::from_str(key)) {
        Ok(x)  => x.as_string().unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// Read the driver's reply into the common shape.
///
/// A result missing a title or a url is DROPPED rather than passed on empty, per the contract: a
/// row with no address is nothing the model can follow up, and a row with no title reads as a
/// blank line in the middle of the list.  One bad row never fails the whole answer.
///
/// # Arguments
/// * `v` - What the promise resolved with: the result object, or the JSON text of one.
/// * `asked` - The query as it was sent.
fn answer(v: &JsValue, asked: &str) -> Outcome<SearchAnswer> {
    // A driver that resolves with JSON TEXT rather than an object is read anyway: the Web panel's
    // driver already resolves both ways (see `stringify`), and a working search reported as a
    // broken one because of which of the two it picked would be a poor trade for strictness.
    let obj = match v.as_string() {
        Some(s) => match js_sys::JSON::parse(&s) {
            Ok(o)  => o,
            Err(_) => JsValue::NULL,
        },
        None => v.clone(),
    };
    let list = match js_sys::Reflect::get(&obj, &JsValue::from_str("results")) {
        Ok(l)  => l,
        Err(_) => JsValue::UNDEFINED,
    };
    // No list at all is a MALFORMED reply, and it is not the same thing as an empty one. Reporting
    // it as "no results" would tell the model the web has nothing on the subject, which is a lie
    // about a broken reply and one it cannot see through.
    if !js_sys::Array::is_array(&list) {
        return Err(err!(
            "The search service answered without a result list, so nothing can be read from it.";
            Invalid, Data));
    }
    let mut out = SearchAnswer {
        engine:  prop(&obj, "engine"),
        // OURS, not the reply's echo of it: see the doc comment on `search`.
        query:   asked.to_string(),
        results: Vec::new(),
    };
    for item in js_sys::Array::from(&list).iter() {
        let title = prop(&item, "title");
        let url   = prop(&item, "url");
        if title.trim().is_empty() || url.trim().is_empty() {
            continue;
        }
        out.results.push(SearchHit {
            title,
            url,
            snippet: prop(&item, "snippet"),
            age:     prop(&item, "age"),
        });
    }
    Ok(out)
}

/// Search the web through the engine the USER chose.
///
/// The engine, and any key of the user's own that pays for it, are supplied by the JavaScript
/// half and are deliberately not arguments: the choice is a setting, not the model's.
///
/// **The query in the answer is the one that was ASKED, not the one the reply echoed.** The
/// origin line of the untrusted envelope is a record of what the model went looking for, and
/// nothing arriving from outside is entitled to rewrite that record.
///
/// # Arguments
/// * `query` - What to search for.
/// * `kind` - `web`, `news` or `academic`, already checked by the tool.
/// * `limit` - How many results to ask for, left to the engine when unset.
pub async fn search(query: &str, kind: &str, limit: Option<u32>) -> Outcome<SearchAnswer> {
    let s = res!(searcher());
    let opts = js_sys::Object::new();
    res!(set(&opts, "kind", JsValue::from_str(kind)));
    if let Some(n) = limit {
        res!(set(&opts, "limit", JsValue::from_f64(n as f64)));
    }
    let v = match JsFuture::from(s.run_query(query, opts.as_ref())).await {
        Ok(v)  => v,
        Err(e) => return Err(err!("{}", refusal(&e); Network, Invalid)),
    };
    answer(&v, query)
}

/// The accessibility tree of the open page, whose refs the actions take.
pub async fn snapshot() -> Outcome<String> {
    let d = res!(driver());
    settle(d.snapshot()).await
}

/// The rendered text of the open page -- the way to READ its content.
pub async fn read() -> Outcome<String> {
    let d = res!(driver());
    settle(d.read()).await
}

/// Click the node named by `node_ref` from the latest snapshot.
pub async fn click(node_ref: u32) -> Outcome<String> {
    let d = res!(driver());
    settle(d.click(node_ref)).await
}

/// Type `text` into the node named by `node_ref`, optionally submitting.
pub async fn type_into(node_ref: u32, text: &str, submit: bool) -> Outcome<String> {
    let d = res!(driver());
    settle(d.type_into(node_ref, text, submit)).await
}

/// Scroll the open page, leaving `amount` to the driver when unset.
pub async fn scroll(dir: &str, amount: Option<u32>) -> Outcome<String> {
    let d = res!(driver());
    let amt = match amount {
        Some(n) => JsValue::from_f64(n as f64),
        None    => JsValue::UNDEFINED,
    };
    settle(d.scroll(dir, amt)).await
}

/// Close the Web panel and drop the page.
pub async fn close() -> Outcome<String> {
    let d = res!(driver());
    settle(d.close()).await
}


// ── The egress gate's edge ──────────────────────────────────────────

/// The global the JavaScript half installs to answer whether this turn may reach a destination.
///
/// It is not a `DaimondWeb` method: the question is about the turn, not about the panel, and the
/// half that answers it owns the user's standing decisions rather than the browser driver.
const EGRESS_GLOBAL: &str = "__daimondEgressAllowed";

/// Read a resolved answer, where anything but the exact string `allow` is a refusal.
///
/// A gate must not be talked past by a value it does not understand, so the default is `Deny`
/// rather than a guess.
///
/// # Arguments
/// * `v` - What the promise resolved with.
fn verdict(v: &JsValue) -> Verdict {
    match v.as_string().as_deref() {
        Some("allow") => Verdict::Allow,
        _             => Verdict::Deny,
    }
}

/// Ask the JavaScript half whether this turn may reach `url`, returning `None` when it cannot be
/// asked at all.
///
/// The payload is a JSON string, per the contract: `{"tool":"web_fetch","url":"…"}`.  The
/// JavaScript side owns the remembering -- it resolves `allow` without prompting for a destination
/// the user already approved -- so this asks every time and caches nothing.
///
/// # Arguments
/// * `tool` - The wire name of the tool asking.
/// * `url` - The destination it wants.
pub async fn egress_allowed(tool: &str, url: &str) -> Option<Verdict> {
    egress_allowed_detail(tool, url, "").await
}

/// As [`egress_allowed`], with a `detail` the user should see -- the text about to be typed into a
/// page, say, which is the thing being sent and therefore the thing to look at.
///
/// # Arguments
/// * `tool` - The wire name of the tool asking.
/// * `url` - The destination it wants.
/// * `detail` - What is being sent, when the tool sends something other than the address.
pub async fn egress_allowed_detail(tool: &str, url: &str, detail: &str) -> Option<Verdict> {
    let win = match web_sys::window() {
        Some(w) => w,
        None    => return None,
    };
    let f = match js_sys::Reflect::get(&win, &JsValue::from_str(EGRESS_GLOBAL)) {
        Ok(v)  => v,
        Err(_) => return None,
    };
    if !f.is_function() {
        return None;
    }
    let f = f.unchecked_into::<js_sys::Function>();
    let payload = fmt!(
        "{{\"tool\":\"{}\",\"url\":\"{}\",\"detail\":\"{}\"}}",
        json_escape(tool), json_escape(url), json_escape(detail));
    let ret = match f.call1(&JsValue::NULL, &JsValue::from_str(&payload)) {
        Ok(v)  => v,
        Err(_) => return None,
    };
    // The contract says a Promise; a value returned outright is read anyway rather than refused
    // on a technicality, since it is still an answer.
    let promise = match ret.dyn_into::<js_sys::Promise>() {
        Ok(p)  => p,
        Err(v) => return Some(verdict(&v)),
    };
    match JsFuture::from(promise).await {
        Ok(v)  => Some(verdict(&v)),
        Err(_) => None,
    }
}
