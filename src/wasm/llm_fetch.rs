//! The browser model transport: [`LlmClient`]'s requests over `fetch` and `ReadableStream`.
//!
//! Moved verbatim from `llm.rs` (U2L), so engine code names no `crate::wasm::`.  It is an
//! inherent `impl` of [`LlmClient`] in the same crate; the fields and helpers it reads are
//! `pub(crate)` in `llm.rs`.

use oxedyne_fe2o3_core::prelude::*;

use crate::engine::race::{self as racing, Won};
use crate::llm::*;
use crate::wasm::js_str;

// ┌───────────────────────────────────────────────────────────────┐
// │ Wasm transport — browser `fetch` + `ReadableStream`            │
// └───────────────────────────────────────────────────────────────┘
//
// The wasm build has no TCP sockets or TLS stack; the browser owns
// both.  These methods mirror the native transport's private contract
// (`do_request_full` / `stream_sse`) using `fetch`, so the
// `chat_stream` / `chat_stream_tools` / `chat_once` API above is
// target-agnostic.

#[cfg(target_arch = "wasm32")]
impl LlmClient {

    /// The absolute request URL for the browser transport.
    ///
    /// The scheme follows [`secure`](Self::secure); the port is elided
    /// only when it is the scheme's default (443 for `https`, 80 for
    /// `http`), so a mock on a custom port is addressed explicitly.
    fn wasm_url(&self) -> String {
        let (scheme, default_port) = if self.secure { ("https", 443u16) } else { ("http", 80u16) };
        if self.port == default_port {
            fmt!("{}://{}{}", scheme, self.host, self.path)
        } else {
            fmt!("{}://{}:{}{}", scheme, self.host, self.port, self.path)
        }
    }

    /// Issue a lightweight transport probe and return the raw HTTP
    /// status the provider replies with.
    ///
    /// Unlike [`wasm_fetch`](Self::wasm_fetch), a non-2xx status is *not*
    /// treated as an error — the status number is the whole point.  A
    /// `401` from a real provider with a dummy key proves the full
    /// `fetch` + CORS + transport path end-to-end without a valid key.
    pub async fn probe_status(&self) -> Outcome<u16> {
        let messages = [crate::protocol::ChatMessage::user("ping")];
        let body = self.build_body(&messages, None, false);
        let resp = res!(self.wasm_fetch_raw(&body, self.stream_idle_ms.get()).await);
        Ok(resp.status())
    }

    /// POST `body` via `fetch`, retrying a transient failure with bounded
    /// backoff, and await the `Response`.
    ///
    /// Nothing has reached the caller at this point, so a dropped `fetch`, a 429
    /// or a 5xx is simply tried again; every other non-2xx is this request being
    /// wrong and is returned as-is.  `waited` is the shared backoff budget; see
    /// the native [`open`](LlmClient::open).
    ///
    /// A refusal carries the provider's OWN WORDS, as the native transport has always
    /// done.  Without them the browser could say no more than
    /// `LLM: HTTP error: 400 Bad Request.`, which tells the user nothing they can act on
    /// and tells [`compact::looks_like_overflow`](crate::agent::compact::looks_like_overflow)
    /// nothing at all -- so a request refused for being too long and one refused for
    /// being wrong had to be told apart by size alone.  Both dialects are covered,
    /// because it is the raw body that is carried and neither is parsed.
    async fn wasm_fetch(&self, body: &str, wait_ms: u64) -> Result<web_sys::Response, TransportErr> {
        let resp = match self.wasm_fetch_raw(body, wait_ms).await {
            Ok(r) => r,
            // The first-byte watchdog fired: the provider accepted the connection and then
            // never answered.  Checked BEFORE `halted` -- abort-first would read
            // this as a user cancel and mislabel a stall as a Stop -- and the tear-down is
            // fired HERE (as the stream idle watchdog does) so a dropped future does not
            // leave the `fetch` running.  TERMINAL, not transient: a stall is not fixed by
            // retrying it, so `classify` ends the round rather than re-entering the ladder.
            Err(e) if e.tags().contains(&ErrTag::Timeout) => {
                self.halt.tear_down();
                return Err(TransportErr::classify(
                    "no response from the provider".to_string(), e));
            }
            // A rejected `fetch` is a network or CORS failure; an armed abort is
            // the caller cancelling, and must not be retried.
            Err(e) => return Err(if self.halted() {
                TransportErr::fatal("the turn was cancelled".to_string(), e)
            } else {
                TransportErr::transient("could not reach the provider".to_string(), e)
            }),
        };
        if !resp.ok() {
            let status = resp.status();
            let status_text = resp.status_text();
            // Read BEFORE the body: consuming the stream cannot then cost the retry its
            // requested delay, and a `Retry-After` is the one thing on a 429 worth more
            // than the message.
            let after = if status_retryable(status) {
                resp.headers().get("retry-after").ok().flatten()
                    .and_then(|v| parse_retry_after(&v))
            } else {
                None
            };
            let detail = self.body_detail(&resp, wait_ms).await;
            let err = err!(
                "LLM: HTTP error: {} {} | {}", status, status_text, detail;
                IO, Network, Wire, Read);
            let reason = fmt!("the provider returned HTTP {}", status);
            return Err(if status_retryable(status) {
                TransportErr::transient(reason, err).after(after)
            } else {
                TransportErr::fatal(reason, err)
            }.at(status));
        }
        Ok(resp)
    }

    /// The first [`ERR_BODY_BYTES`] of a refusal's body, or nothing when it cannot be read.
    ///
    /// Consumes the response, which is why it is called only on the failing path.  A body
    /// that will not resolve -- an abort landing between the headers and the text, a
    /// provider that sent none -- yields an empty string rather than turning a refusal
    /// with a known status into a failure of a different kind.
    ///
    /// # Arguments
    /// * `resp` - The non-2xx response, whose body is read to exhaustion.
    async fn body_detail(&self, resp: &web_sys::Response, wait_ms: u64) -> String {
        use wasm_bindgen::JsValue;

        let text = match resp.text() {
            // Race the body against the same idle ceiling: a refusal whose body will not
            // resolve resolves to nothing rather than hanging the error path itself.
            Ok(p) => {
                enum Raced { Done(Result<JsValue, JsValue>), Idle }
                let raced = race(
                    Box::pin(async move { Raced::Done(crate::wasm::settle_js(p).await) }),
                    Box::pin(async move { sleep_ms(wait_ms).await; Raced::Idle }),
                ).await;
                match raced {
                    Raced::Done(Ok(v)) => v.as_string().unwrap_or_default(),
                    Raced::Idle | Raced::Done(Err(_)) => String::new(),
                }
            }
            Err(_) => String::new(),
        };
        clip_bytes(&text, ERR_BODY_BYTES).to_string()
    }

    /// POST `body` via `fetch` and await the `Response` without checking
    /// the status, mapping any JS error into an `Outcome`.  TLS trust is
    /// the browser's.  Callers that need a 2xx guarantee go through
    /// [`wasm_fetch`](Self::wasm_fetch).
    async fn wasm_fetch_raw(&self, body: &str, wait_ms: u64) -> Outcome<web_sys::Response> {
        use wasm_bindgen::JsCast;
        use wasm_bindgen::JsValue;
        use web_sys::{Headers, Request, RequestInit, RequestMode, Response};

        let headers = res!(Headers::new()
            .map_err(|e| err!("LLM: create headers failed: {}.", js_str(&e); IO, Network, Init)));
        // `true`: this is the browser transport, so an Anthropic endpoint also
        // gets the header that makes its edge answer a cross-origin request.
        for (name, value) in self.auth_headers(true) {
            res!(headers.append(name, &value)
                .map_err(|e| err!("LLM: set header {} failed: {}.", name, js_str(&e);
                    IO, Network, Init)));
        }

        let opts = RequestInit::new();
        opts.set_method("POST");
        opts.set_mode(RequestMode::Cors);
        opts.set_headers(&headers);
        opts.set_body(&JsValue::from_str(body));

        // Install a fresh abort controller for this request and wire its
        // signal in, so `abort` can cancel the in-flight fetch/stream.  A
        // controller that fails to construct simply leaves the request
        // uncancellable rather than failing the turn.
        if let Ok(ctrl) = web_sys::AbortController::new() {
            opts.set_signal(Some(&ctrl.signal()));
            self.halt.arm(ctrl);
        }

        let url = self.wasm_url();
        let request = res!(Request::new_with_str_and_init(&url, &opts)
            .map_err(|e| err!("LLM: build request failed: {}.", js_str(&e); IO, Network, Init)));

        // `fetch` lives on the window in a document context and on the
        // global scope in a worker; support both.
        let promise = if let Some(win) = web_sys::window() {
            win.fetch_with_request(&request)
        } else {
            let scope = res!(js_sys::global()
                .dyn_into::<web_sys::WorkerGlobalScope>()
                .map_err(|_| err!(
                    "LLM: no window or worker scope for fetch."; IO, Network, Init)));
            scope.fetch_with_request(&request)
        };

        // Bound the wait for the response the same way `stream_sse` bounds the wait for a
        // stream chunk: race the `fetch` against `sleep_ms`, so a provider that accepts the
        // connection and then never answers ends the attempt instead of hanging.  No
        // `self.abort()` here -- that is the caller's to fire once it has classified the
        // timeout (see `wasm_fetch`), so this layer stays a plain "did it arrive?".
        enum Raced { Done(Result<JsValue, JsValue>), Idle }
        let raced = race(
            Box::pin(async move { Raced::Done(crate::wasm::settle_js(promise).await) }),
            Box::pin(async move { sleep_ms(wait_ms).await; Raced::Idle }),
        ).await;
        let resp_val = match raced {
            Raced::Idle         => return Err(err!(
                "LLM: no response within {} ms.", wait_ms; IO, Network, Timeout)),
            Raced::Done(Ok(v))  => v,
            Raced::Done(Err(e)) => return Err(err!(
                "LLM: fetch failed: {}.", js_str(&e); IO, Network, Wire)),
        };
        let resp: Response = res!(resp_val.dyn_into()
            .map_err(|_| err!("LLM: fetch did not return a Response."; IO, Network, Wire)));
        Ok(resp)
    }

    /// Non-streaming request — await the full response body as text.
    pub(crate) async fn do_request_full(&self, body: &str) -> Result<String, TransportErr> {
        use wasm_bindgen::JsValue;

        // The whole reply arrives in one body here (`chat_once` -> the fold summary), and a
        // non-streaming provider generates the answer before sending a byte, so this path gets
        // the wider first-byte ceiling; see `REPLY_WAIT_FACTOR`.
        let wait_ms = self.stream_idle_ms.get().saturating_mul(REPLY_WAIT_FACTOR);
        let resp = match self.wasm_fetch(body, wait_ms).await {
            Ok(r)  => r,
            Err(e) => return Err(e),
        };
        let text_promise = match resp.text() {
            Ok(p)  => p,
            Err(e) => return Err(TransportErr::transient("the reply was cut short".to_string(), err!(
                "LLM: read response text failed: {}.", js_str(&e); IO, Network, Wire, Read))),
        };
        // Bound the body wait as well: headers can arrive before a slow generation finishes,
        // so a body that never resolves must end the attempt rather than hang it.
        enum Raced { Done(Result<JsValue, JsValue>), Idle }
        let raced = race(
            Box::pin(async move { Raced::Done(crate::wasm::settle_js(text_promise).await) }),
            Box::pin(async move { sleep_ms(wait_ms).await; Raced::Idle }),
        ).await;
        let text_val = match raced {
            Raced::Idle => {
                // The body never resolved.  Read the abort flag BEFORE tearing the fetch down
                // (which itself fires the signal): if a Stop or the 540 s wall clock already
                // landed, this is a cancel; otherwise it is a first-byte-class stall.  Either
                // way TERMINAL -- `classify` on the timeout tag, and an abort is never
                // retryable -- so the body wait no longer re-enters the ladder (was the hole
                // that retried an abort landing between the headers and the text).
                let cancelled = self.halted();
                self.halt.tear_down();
                return Err(if cancelled {
                    TransportErr::fatal("the turn was cancelled".to_string(), err!(
                        "LLM: aborted awaiting the response body."; IO, Network))
                } else {
                    TransportErr::classify("the reply was cut short".to_string(), err!(
                        "LLM: no response body within {} ms.", wait_ms; IO, Network, Timeout))
                });
            }
            Raced::Done(Ok(v))  => v,
            Raced::Done(Err(e)) => return Err(TransportErr::transient("the reply was cut short".to_string(), err!(
                "LLM: await response text failed: {}.", js_str(&e); IO, Network, Wire, Read))),
        };
        Ok(text_val.as_string().unwrap_or_default())
    }

    /// Streaming request — read the SSE body incrementally from the
    /// response's `ReadableStream`, handing `on_data` each `data:`
    /// payload as it arrives, stopping at `[DONE]`.  `on_data` answers with a [`Pulse`]; see the
    /// native `stream_sse` and [`StreamWatch`].
    ///
    /// Returns whether the browser fired the abort signal.  When the
    /// initial `fetch` or a stream read rejects, an armed abort is
    /// distinguished from a genuine transport failure: an abort resolves
    /// to `Ok(true)` (the caller keeps whatever streamed and ends the
    /// turn cleanly), any other rejection is a real error.
    pub(crate) async fn stream_sse(
        &self,
        body:       &str,
        first_ms:   u64,
        quiet_cap:  u64,
        on_data:    &mut impl FnMut(Wire<'_>) -> Pulse,
    ) -> Result<StreamOutcome, TransportErr>
    {
        use wasm_bindgen::JsValue;
        use web_sys::{ReadableStream, ReadableStreamDefaultReader};

        // Headers arrive before the first token on a streaming request, so the first-byte
        // wait is the plain idle ceiling; the watch below covers the rest.
        let idle_ms = self.stream_idle_ms.get();
        let asked   = now_ms();
        // The wait for the reply is held outside the liveness race (U3a LV2); see `ReplyHold`.
        let mut held = crate::engine::worker::liveness::ReplyHold::new(self.liveness.clone(),
            asked.saturating_add(idle_ms.saturating_mul(crate::llm::REPLY_WAIT_FACTOR)));
        // Raced against the halt as the native reader is, so a Stop from the stop cell -- which
        // fires no controller of its own -- lands here too; `fired` tears the `fetch` down.
        let fetched = match racing::race(self.wasm_fetch(body, idle_ms), self.halt.fired()).await {
            Won::First(fetched) => fetched,
            Won::Second(())     => return Ok(StreamOutcome::ABORTED),
        };
        let resp = match fetched {
            Ok(r) => r,
            Err(e) => {
                if self.halted() {
                    return Ok(StreamOutcome::ABORTED);
                }
                return Err(e);
            }
        };
        let stream: ReadableStream = match resp.body() {
            Some(s) => s,
            None => return Err(TransportErr::transient("the reply carried no stream".to_string(), err!(
                "LLM: response has no body stream."; IO, Network, Wire, Read))),
        };
        let reader = match ReadableStreamDefaultReader::new(&stream) {
            Ok(r)  => r,
            Err(e) => return Err(TransportErr::fatal("the stream could not be read".to_string(), err!(
                "LLM: acquire stream reader failed: {}.", js_str(&e); IO, Network, Wire, Read))),
        };

        // Accumulate raw bytes and extract complete SSE lines as they
        // arrive, mirroring the native `LineReader` line discipline.
        let mut buf: Vec<u8> = Vec::with_capacity(8192);

        let mut watch = StreamWatch::new(now_ms(), idle_ms, first_ms).capped(quiet_cap).asked(asked)
            .beating(self.liveness.clone());
        let status = resp.status();
        let ctype = resp.headers().get("content-type").ok().flatten();
        let mut lines = SseLines::new(ctype.as_deref());
        // A stream has answered with its headers; a whole body has not until it is all here.
        if lines.is_stream() { held.release(now_ms()); }
        // ONE READ, kept across the watch's ticks: a read future dropped when a tick fired
        // would take the chunk it was about to deliver with it.
        let mut pending: Option<std::pin::Pin<Box<dyn std::future::Future<Output = Result<JsValue, JsValue>>>>>
            = None;

        loop {
            // THE IDLE WATCHDOG, raced against the read rather than wrapped around it, so a
            // chunk of real data re-arms the timeout for the next one; see the same note on
            // the native `stream_sse`. `sleep_ms` is the browser `setTimeout` this client
            // already uses for retry backoff, so no new timer mechanism is added. Hand-rolled
            // (`read_or_nap`) rather than `tokio::select!`: `tokio` is not in this target's
            // dependency graph at all -- the wasm build has no TCP sockets or TLS stack, and
            // pulling in tokio's executor for one macro would be a second async runtime
            // fighting `wasm-bindgen-futures` for the same microtask queue.
            let now = now_ms();
            if watch.expired(now) {
                // Tear the `fetch` down, as a Stop would, but leave the turn's halt alone: a
                // stall is not a Stop.  Nothing else tears down a `fetch` this client has
                // stopped reading from, and a dropped `JsFuture` does not reach the
                // connection at all.
                self.halt.tear_down();
                return Ok(watch.ended(now, StreamOutcome::STALLED));
            }
            if let Some(secs) = watch.tick(now) {
                on_data(Wire::Silence(secs));
            }
            // A cloned HANDLE, not a second reader: `ReadableStreamDefaultReader` is a thin
            // wasm-bindgen wrapper around one JS object, so cloning it is what lets the read
            // future OWN a reference to it while `reader` itself is still there to read from
            // on the next loop iteration.
            let read = pending.get_or_insert_with(|| {
                let handle = reader.clone();
                Box::pin(async move { crate::wasm::settle_js(handle.read()).await })
            });
            let raced = match racing::race(read_or_nap(read, watch.next_in(now_ms())), self.halt.fired())
                .await
            {
                Won::First(raced)   => raced,
                Won::Second(())     => return Ok(watch.ended(now_ms(), StreamOutcome::ABORTED)),
            };
            let result = match raced {
                // A tick: nothing arrived yet, and the read is still pending.
                None => continue,
                Some(Ok(r)) => { pending = None; r }
                Some(Err(e)) => {
                    if self.halted() {
                        return Ok(watch.ended(now_ms(), StreamOutcome::ABORTED));
                    }
                    // A stream that broke mid-flight; whether it is safe to try
                    // again is the caller's judgement, not this layer's.
                    return Err(TransportErr::transient("the stream broke".to_string(), err!(
                        "LLM: read stream chunk failed: {}.", js_str(&e);
                        IO, Network, Wire, Read)));
                }
            };
            let done = match js_sys::Reflect::get(&result, &JsValue::from_str("done")) {
                Ok(v)  => v.as_bool().unwrap_or(true),
                Err(e) => return Err(TransportErr::fatal("the stream was malformed".to_string(), err!(
                    "LLM: read 'done' failed: {}.", js_str(&e); IO, Network, Wire, Read))),
            };
            if done {
                break;
            }
            let value = match js_sys::Reflect::get(&result, &JsValue::from_str("value")) {
                Ok(v)  => v,
                Err(e) => return Err(TransportErr::fatal("the stream was malformed".to_string(), err!(
                    "LLM: read 'value' failed: {}.", js_str(&e); IO, Network, Wire, Read))),
            };
            let chunk = js_sys::Uint8Array::new(&value).to_vec();
            buf.extend_from_slice(&chunk);
            watch.heard(now_ms());
            watch.took(chunk.len() as u64);

            // Drain complete lines (terminated by `\n`) from the buffer.
            loop {
                let nl = match buf.iter().position(|&b| b == b'\n') {
                    Some(p) => p,
                    None    => break,
                };
                let line_bytes: Vec<u8> = buf.drain(..=nl).collect();
                let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
                match lines.sort(&line) {
                    SseLine::Skip       => continue,
                    SseLine::Done       => return Ok(watch.ended(now_ms(), StreamOutcome::default())),
                    SseLine::Data(data) => {
                        let pulse = on_data(Wire::Data(data));
                        watch.data(now_ms(), pulse);
                    }
                }
            }
        }

        // A last line with no newline after it: a one-body reply usually ends so.
        if !buf.is_empty() {
            let line = String::from_utf8_lossy(&buf).to_string();
            match lines.sort(&line) {
                SseLine::Data(data) => { on_data(Wire::Data(data)); }
                SseLine::Done | SseLine::Skip => {}
            }
        }
        let end = now_ms();
        held.release(end);
        match lines.body() {
            Some(b) => self.deliver_body(status, b, on_data).map(|o| watch.ended(end, o)),
            None    => Ok(watch.ended(end, StreamOutcome::default())),
        }
    }
}


/// Whichever of two same-shaped futures becomes ready first; the other is dropped.
///
/// Hand-rolled rather than `tokio::select!` or a `futures` crate helper: `tokio` is not in
/// this target's dependency graph (the wasm build has no TCP sockets or TLS stack, so
/// nothing before this needed its executor), and pulling one in for a macro would be a
/// second async runtime contending with `wasm-bindgen-futures` for the same microtask
/// queue. A boxed, pinned trait object on each side is what lets the two callers of this
/// (one `JsFuture`, one `sleep_ms`) share a Future poll loop despite being different
/// concrete types.
#[cfg(target_arch = "wasm32")]
async fn race<T>(
    mut a: std::pin::Pin<Box<dyn std::future::Future<Output = T>>>,
    mut b: std::pin::Pin<Box<dyn std::future::Future<Output = T>>>,
)
    -> T
{
    std::future::poll_fn(move |cx| {
        if let std::task::Poll::Ready(v) = a.as_mut().poll(cx) { return std::task::Poll::Ready(v); }
        if let std::task::Poll::Ready(v) = b.as_mut().poll(cx) { return std::task::Poll::Ready(v); }
        std::task::Poll::Pending
    }).await
}
/// The pending read if it finishes within `ms`, else `None` -- and the read is left pending.
///
/// `race` takes both futures by value and drops the loser, which is right for a one-shot wait
/// and wrong for a read that has to survive the watch's ticks.
#[cfg(target_arch = "wasm32")]
async fn read_or_nap<T>(
    read: &mut std::pin::Pin<Box<dyn std::future::Future<Output = T>>>,
    ms:   u64,
)
    -> Option<T>
{
    // A trait object, so `poll` needs no `Future` import (this crate is edition 2021).
    let mut nap: std::pin::Pin<Box<dyn std::future::Future<Output = ()>>> = Box::pin(sleep_ms(ms));
    std::future::poll_fn(move |cx| {
        if let std::task::Poll::Ready(v) = read.as_mut().poll(cx) {
            return std::task::Poll::Ready(Some(v));
        }
        if nap.as_mut().poll(cx).is_ready() { return std::task::Poll::Ready(None); }
        std::task::Poll::Pending
    }).await
}
