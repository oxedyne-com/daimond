//! LLM client — OpenAI-compatible chat completions with SSE streaming.
//!
//! Uses `fe2o3_net` for the underlying TLS connection.  Parses the
//! `text/event-stream` response line-by-line, extracting `data:` lines
//! containing JSON objects with `delta` content.
//!
//! No `serde` or `reqwest` — the OpenAI API JSON is simple enough to
//! parse manually using string scanning.  This keeps the dependency
//! surface minimal and stays within the fe2o3 ecosystem.

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::prelude::*;

use crate::protocol::{ChatMessage, ToolCall};

// Native transport imports — the hand-rolled TLS client lives behind
// tokio + rustls, which do not target wasm32.
#[cfg(not(target_arch = "wasm32"))]
use std::sync::Arc;
#[cfg(not(target_arch = "wasm32"))]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(not(target_arch = "wasm32"))]
use tokio_rustls::rustls::ClientConfig;


// ┌───────────────────────────────────────────────────────────────┐
// │ LlmClient                                                      │
// └───────────────────────────────────────────────────────────────┘

/// Async client for an OpenAI-compatible chat completions API.
///
/// Connects via TLS to the configured host, POSTs a chat completion
/// request with `stream: true`, and parses the SSE response
/// incrementally — calling `on_token` for each text chunk as it
/// arrives.
#[derive(Clone, Debug)]
pub struct LlmClient {
    pub host:       String,
    pub port:       u16,
    pub path:       String,
    pub api_key:    String,
    pub model:      String,
    /// Upper bound on generated tokens per turn.  Prevents runaway
    /// reasoning loops (e.g. GLM-5.2 without a cap).
    pub max_tokens: u32,
    /// Root-trust TLS configuration for the native transport.  The wasm
    /// transport delegates trust to the browser's `fetch`, so this field
    /// is native-only.
    #[cfg(not(target_arch = "wasm32"))]
    pub tls_config: Arc<ClientConfig>,
    /// Wasm transport URL scheme selector: `true` builds `https://…`,
    /// `false` builds `http://…`.  Defaults to `https` (all real
    /// providers are TLS-only); an `http` client targets a local mock
    /// over `127.0.0.1` for headless testing, where the browser still
    /// treats the origin as a secure context.
    #[cfg(target_arch = "wasm32")]
    pub secure: bool,
    /// Shared abort slot for the browser transport.  Each `fetch` installs
    /// a fresh [`web_sys::AbortController`] here and wires its signal into
    /// the request; [`abort`](Self::abort) fires it to cancel the in-flight
    /// turn.  An `Rc<RefCell<…>>` (never `unsafe`), shared across clones so
    /// a sub-agent built from a cloned client aborts on the same signal.
    #[cfg(target_arch = "wasm32")]
    abort: std::rc::Rc<std::cell::RefCell<Option<web_sys::AbortController>>>,
}

/// The response from a completed streaming chat call.
#[derive(Clone, Debug, Default)]
pub struct ChatResponse {
    pub content:           String,
    pub prompt_tokens:     u64,
    pub completion_tokens: u64,
    /// Set when the turn was cancelled mid-stream (browser abort).  The
    /// `content` then holds whatever streamed before the cancellation, so
    /// the caller keeps the partial answer rather than reporting an error.
    pub aborted:           bool,
}

/// The response from a chat call that may include tool calls the model
/// wants executed.  Whether it was produced by a streaming or a
/// non-streaming request, the accumulated shape is the same.
#[derive(Clone, Debug, Default)]
pub struct ChatOnceResponse {
    pub content:           String,
    pub tool_calls:        Vec<ToolCall>,
    pub prompt_tokens:     u64,
    pub completion_tokens: u64,
    /// Set when the turn was cancelled mid-stream (browser abort); see
    /// [`ChatResponse::aborted`].
    pub aborted:           bool,
}

impl LlmClient {

    /// Construct a client for the native transport (tokio + rustls).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new(
        host:       &str,
        port:       u16,
        path:       &str,
        api_key:    &str,
        model:      &str,
        max_tokens: u32,
        tls_config: Arc<ClientConfig>,
    ) -> Self {
        Self {
            host:       host.to_string(),
            port,
            path:       path.to_string(),
            api_key:    api_key.to_string(),
            model:      model.to_string(),
            max_tokens,
            tls_config,
        }
    }

    /// Construct a client for the wasm transport (browser `fetch`).
    ///
    /// TLS trust is handled by the browser, so no `tls_config` is
    /// required — the streaming API (`chat_stream` / `chat_once`) is
    /// otherwise identical to the native client.
    #[cfg(target_arch = "wasm32")]
    pub fn new(
        host:       &str,
        port:       u16,
        path:       &str,
        api_key:    &str,
        model:      &str,
        max_tokens: u32,
    ) -> Self {
        Self::new_with_scheme(host, port, path, api_key, model, max_tokens, true)
    }

    /// Construct a wasm client with an explicit URL scheme.
    ///
    /// `secure` selects `https` (`true`) or `http` (`false`).  Real
    /// providers always use `https`; the `http` form exists so a local
    /// mock over `127.0.0.1` can be driven in a headless test.
    #[cfg(target_arch = "wasm32")]
    pub fn new_with_scheme(
        host:       &str,
        port:       u16,
        path:       &str,
        api_key:    &str,
        model:      &str,
        max_tokens: u32,
        secure:     bool,
    ) -> Self {
        Self {
            host:       host.to_string(),
            port,
            path:       path.to_string(),
            api_key:    api_key.to_string(),
            model:      model.to_string(),
            max_tokens,
            secure,
            abort:      std::rc::Rc::new(std::cell::RefCell::new(None)),
        }
    }

    /// Send a streaming chat completion request.
    ///
    /// Reads the SSE response line-by-line from the TLS stream,
    /// calling `on_token` for each text delta *as it arrives*.
    /// Returns the full accumulated response and token usage when
    /// the stream completes.
    pub async fn chat_stream(
        &self,
        messages:   &[ChatMessage],
        on_token:   &mut impl FnMut(&str),
    ) -> Outcome<ChatResponse> {
        let body = self.build_request_body(messages);
        let mut full = String::new();
        let mut pt = 0u64;
        let mut ct = 0u64;
        let aborted = res!(self.stream_sse(&body, &mut |data| {
            if let Some(content) = extract_json_string(data, "content") {
                on_token(&content);
                full.push_str(&content);
            }
            if let Some(usage) = find_json_object(data, "usage") {
                if let Some(p) = extract_json_number(&usage, "prompt_tokens") { pt = p; }
                if let Some(c) = extract_json_number(&usage, "completion_tokens") { ct = c; }
            }
        }).await);
        Ok(ChatResponse {
            content:           full,
            prompt_tokens:     pt,
            completion_tokens: ct,
            aborted,
        })
    }

    /// Streaming chat completion with tools enabled.
    ///
    /// Issues the request with `stream: true` and reconstructs the
    /// assistant turn from the SSE deltas: text is forwarded to
    /// `on_token` as it arrives (so the answer streams even while tools
    /// are active), and any `tool_calls` fragments are accumulated across
    /// chunks into whole calls (see [`StreamAcc`]).  Returns the same
    /// [`ChatOnceResponse`] shape as [`chat_once`](Self::chat_once).
    pub async fn chat_stream_tools(
        &self,
        messages:   &[ChatMessage],
        tools:      Option<&str>,
        on_token:   &mut impl FnMut(&str),
    ) -> Outcome<ChatOnceResponse> {
        let body = self.build_body(messages, tools, true);
        let mut acc = StreamAcc::default();
        let aborted = res!(self.stream_sse(&body, &mut |data| {
            acc.ingest(data, on_token);
        }).await);
        Ok(acc.into_response(aborted))
    }

    /// Non-streaming chat completion, optionally with tools.
    ///
    /// Returns the assistant content and any `tool_calls` the model
    /// wants executed, plus token usage.  Retained for callers that
    /// prefer a single whole-response parse over streamed fragments.
    pub async fn chat_once(
        &self,
        messages:   &[ChatMessage],
        tools:      Option<&str>,
    ) -> Outcome<ChatOnceResponse> {
        let body = self.build_body(messages, tools, false);
        let raw = res!(self.do_request_full(&body).await);
        let (content, tool_calls, pt, ct) = parse_full_response(&raw);
        Ok(ChatOnceResponse {
            content,
            tool_calls,
            prompt_tokens: pt,
            completion_tokens: ct,
            aborted: false,
        })
    }

    /// Build the JSON request body for the OpenAI-compatible API.
    ///
    /// `tools` (if present) is a ready-made JSON array injected as the
    /// `tools` field with `tool_choice: auto`.  `stream` toggles SSE
    /// streaming and usage reporting.
    fn build_body(&self, messages: &[ChatMessage], tools: Option<&str>, stream: bool) -> String {
        let mut out = String::with_capacity(1024);
        out.push('{');
        out.push_str(&fmt!("\"model\":\"{}\",", self.model));
        out.push_str("\"messages\":[");
        for (i, msg) in messages.iter().enumerate() {
            if i > 0 { out.push(','); }
            out.push_str(&message_to_json(msg));
        }
        out.push_str("],");
        if let Some(t) = tools {
            out.push_str(&fmt!("\"tools\":{},", t));
            out.push_str("\"tool_choice\":\"auto\",");
        }
        if stream {
            out.push_str("\"stream\":true,");
            out.push_str("\"stream_options\":{\"include_usage\":true},");
        } else {
            out.push_str("\"stream\":false,");
        }
        out.push_str(&fmt!("\"max_tokens\":{}", self.max_tokens));
        out.push('}');
        out
    }

    /// Streaming body (no tools).  Kept as a thin wrapper for the
    /// pure-chat path and its unit test.
    fn build_request_body(&self, messages: &[ChatMessage]) -> String {
        self.build_body(messages, None, true)
    }

    /// Connect, TLS-handshake, send the request, and consume the
    /// response headers.  Returns the stream positioned at the body
    /// start plus whether the body uses chunked transfer encoding.
    /// Errors on a non-200 status (with body detail).
    #[cfg(not(target_arch = "wasm32"))]
    async fn open(
        &self,
        body: &str,
    )
        -> Outcome<(tokio_rustls::client::TlsStream<tokio::net::TcpStream>, bool)>
    {
        use tokio_rustls::TlsConnector;
        use tokio::net::TcpStream;

        let body_bytes = body.as_bytes();

        let mut request = String::with_capacity(512 + body_bytes.len());
        request.push_str(&fmt!("POST {} HTTP/1.1\r\n", self.path));
        request.push_str(&fmt!("Host: {}\r\n", self.host));
        request.push_str(&fmt!("Authorization: Bearer {}\r\n", self.api_key));
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&fmt!("Content-Length: {}\r\n", body_bytes.len()));
        request.push_str("Connection: close\r\n");
        request.push_str("\r\n");

        let tcp = match TcpStream::connect((self.host.as_str(), self.port)).await {
            Ok(s) => s,
            Err(e) => return Err(err!(e,
                "LLM: TCP connect to {}:{} failed.", self.host, self.port;
                IO, Network, Init)),
        };
        let server_name = match tokio_rustls::rustls::pki_types::ServerName::try_from(self.host.clone()) {
            Ok(n) => n,
            Err(e) => return Err(err!(e,
                "LLM: invalid server name '{}'.", self.host;
                IO, Network, Invalid, Input)),
        };
        let connector = TlsConnector::from(self.tls_config.clone());
        let mut stream = match connector.connect(server_name, tcp).await {
            Ok(s) => s,
            Err(e) => return Err(err!(e,
                "LLM: TLS handshake to {} failed.", self.host;
                IO, Network, Init)),
        };

        let mut req = Vec::with_capacity(request.as_bytes().len() + body_bytes.len());
        req.extend_from_slice(request.as_bytes());
        req.extend_from_slice(body_bytes);
        res!(stream.write_all(&req).await
            .map_err(|e| err!(e, "LLM: write request failed."; IO, Network, Wire, Write)));
        res!(stream.flush().await
            .map_err(|e| err!(e, "LLM: flush failed."; IO, Network, Wire, Write)));

        // Read headers byte-by-byte until \r\n\r\n.
        let mut hdr_buf = Vec::with_capacity(2048);
        let mut byte = [0u8; 1];
        loop {
            match stream.read(&mut byte).await {
                Ok(0) => break,
                Ok(_) => {
                    hdr_buf.push(byte[0]);
                    if hdr_buf.ends_with(b"\r\n\r\n") { break; }
                }
                Err(e) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(err!(e,
                    "LLM: read headers failed."; IO, Network, Wire, Read)),
            }
        }

        let headers_str = String::from_utf8_lossy(&hdr_buf);
        let is_chunked = headers_str
            .to_ascii_lowercase()
            .contains("transfer-encoding: chunked");

        let status_line = headers_str.lines().next().unwrap_or("");
        if !status_line.contains("200") {
            let mut err_body = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match stream.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(n) => err_body.extend_from_slice(&chunk[..n]),
                    Err(_) => break,
                }
            }
            let err_msg = String::from_utf8_lossy(&err_body);
            return Err(err!(
                "LLM: HTTP error: {} | {}", status_line, &err_msg[..err_msg.len().min(300)];
                IO, Network, Wire, Read));
        }

        Ok((stream, is_chunked))
    }

    /// Perform a non-streaming request and return the full response
    /// body as one string.  Lines are concatenated (JSON does not need
    /// the newlines), dechunking transparently.
    #[cfg(not(target_arch = "wasm32"))]
    async fn do_request_full(&self, body: &str) -> Outcome<String> {
        let (stream, is_chunked) = res!(self.open(body).await);
        let mut reader = LineReader::new(stream, is_chunked);
        let mut full = String::new();
        loop {
            match reader.read_line().await {
                Ok(Some(l)) => full.push_str(&l),
                Ok(None) => break,
                Err(e) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(err!(e,
                    "LLM: read response body failed."; IO, Network, Wire, Read)),
            }
        }
        Ok(full)
    }

    /// Send the HTTP request and stream the SSE response line-by-line,
    /// calling `on_data` with each `data:` payload (the JSON after the
    /// `data: ` prefix) as it arrives, stopping at `[DONE]`.  Handles
    /// both chunked and identity transfer encoding via [`LineReader`].
    ///
    /// Returns whether the stream was aborted.  The native transport has
    /// no cancellation path, so it always returns `false`; the wasm
    /// transport returns `true` when the browser fired the abort signal.
    #[cfg(not(target_arch = "wasm32"))]
    async fn stream_sse(
        &self,
        body:       &str,
        on_data:    &mut impl FnMut(&str),
    ) -> Outcome<bool>
    {
        let (stream, is_chunked) = res!(self.open(body).await);
        let mut reader = LineReader::new(stream, is_chunked);
        loop {
            let line = match reader.read_line().await {
                Ok(Some(l)) => l,
                Ok(None) => break,
                Err(e) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(err!(e,
                    "LLM: read SSE line failed."; IO, Network, Wire, Read)),
            };
            let line = line.trim();
            if !line.starts_with("data: ") {
                continue;
            }
            let data = &line[6..];
            if data == "[DONE]" {
                break;
            }
            on_data(data);
        }
        Ok(false)
    }
}


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
        let messages = [crate::protocol::ChatMessage::User {
            content: "ping".to_string(),
        }];
        let body = self.build_body(&messages, None, false);
        let resp = res!(self.wasm_fetch_raw(&body).await);
        Ok(resp.status())
    }

    /// POST `body` via `fetch` and await the `Response`, mapping any
    /// JS error into an `Outcome`.  A non-2xx status is surfaced as an
    /// error (the streaming/chat callers require a 200).
    async fn wasm_fetch(&self, body: &str) -> Outcome<web_sys::Response> {
        let resp = res!(self.wasm_fetch_raw(body).await);
        if !resp.ok() {
            return Err(err!(
                "LLM: HTTP error: {} {}.", resp.status(), resp.status_text();
                IO, Network, Wire, Read));
        }
        Ok(resp)
    }

    /// POST `body` via `fetch` and await the `Response` without checking
    /// the status, mapping any JS error into an `Outcome`.  TLS trust is
    /// the browser's.  Callers that need a 2xx guarantee go through
    /// [`wasm_fetch`](Self::wasm_fetch).
    async fn wasm_fetch_raw(&self, body: &str) -> Outcome<web_sys::Response> {
        use wasm_bindgen::JsCast;
        use wasm_bindgen::JsValue;
        use wasm_bindgen_futures::JsFuture;
        use web_sys::{Headers, Request, RequestInit, RequestMode, Response};

        let headers = res!(Headers::new()
            .map_err(|e| err!("LLM: create headers failed: {}.", js_str(&e); IO, Network, Init)));
        res!(headers.append("Authorization", &fmt!("Bearer {}", self.api_key))
            .map_err(|e| err!("LLM: set auth header failed: {}.", js_str(&e); IO, Network, Init)));
        res!(headers.append("Content-Type", "application/json")
            .map_err(|e| err!("LLM: set content-type failed: {}.", js_str(&e); IO, Network, Init)));

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
            *self.abort.borrow_mut() = Some(ctrl);
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

        let resp_val = res!(JsFuture::from(promise).await
            .map_err(|e| err!("LLM: fetch failed: {}.", js_str(&e); IO, Network, Wire)));
        let resp: Response = res!(resp_val.dyn_into()
            .map_err(|_| err!("LLM: fetch did not return a Response."; IO, Network, Wire)));
        Ok(resp)
    }

    /// Non-streaming request — await the full response body as text.
    async fn do_request_full(&self, body: &str) -> Outcome<String> {
        use wasm_bindgen_futures::JsFuture;

        let resp = res!(self.wasm_fetch(body).await);
        let text_promise = res!(resp.text()
            .map_err(|e| err!("LLM: read response text failed: {}.", js_str(&e); IO, Network, Wire, Read)));
        let text_val = res!(JsFuture::from(text_promise).await
            .map_err(|e| err!("LLM: await response text failed: {}.", js_str(&e); IO, Network, Wire, Read)));
        Ok(text_val.as_string().unwrap_or_default())
    }

    /// Streaming request — read the SSE body incrementally from the
    /// response's `ReadableStream`, calling `on_data` with each `data:`
    /// payload as it arrives, stopping at `[DONE]`.
    ///
    /// Returns whether the browser fired the abort signal.  When the
    /// initial `fetch` or a stream read rejects, an armed abort is
    /// distinguished from a genuine transport failure: an abort resolves
    /// to `Ok(true)` (the caller keeps whatever streamed and ends the
    /// turn cleanly), any other rejection is a real error.
    async fn stream_sse(
        &self,
        body:       &str,
        on_data:    &mut impl FnMut(&str),
    ) -> Outcome<bool>
    {
        use wasm_bindgen::JsValue;
        use wasm_bindgen_futures::JsFuture;
        use web_sys::{ReadableStream, ReadableStreamDefaultReader};

        let resp = match self.wasm_fetch(body).await {
            Ok(r) => r,
            Err(e) => {
                if self.abort_signalled() { return Ok(true); }
                return Err(e);
            }
        };
        let stream: ReadableStream = match resp.body() {
            Some(s) => s,
            None => return Err(err!(
                "LLM: response has no body stream."; IO, Network, Wire, Read)),
        };
        let reader = res!(ReadableStreamDefaultReader::new(&stream)
            .map_err(|e| err!("LLM: acquire stream reader failed: {}.", js_str(&e); IO, Network, Wire, Read)));

        // Accumulate raw bytes and extract complete SSE lines as they
        // arrive, mirroring the native `LineReader` line discipline.
        let mut buf: Vec<u8> = Vec::with_capacity(8192);

        loop {
            let result = match JsFuture::from(reader.read()).await {
                Ok(r) => r,
                Err(e) => {
                    if self.abort_signalled() { return Ok(true); }
                    return Err(err!(
                        "LLM: read stream chunk failed: {}.", js_str(&e);
                        IO, Network, Wire, Read));
                }
            };
            let done = res!(js_sys::Reflect::get(&result, &JsValue::from_str("done"))
                .map_err(|e| err!("LLM: read 'done' failed: {}.", js_str(&e); IO, Network, Wire, Read)))
                .as_bool()
                .unwrap_or(true);
            if done {
                break;
            }
            let value = res!(js_sys::Reflect::get(&result, &JsValue::from_str("value"))
                .map_err(|e| err!("LLM: read 'value' failed: {}.", js_str(&e); IO, Network, Wire, Read)));
            let chunk = js_sys::Uint8Array::new(&value).to_vec();
            buf.extend_from_slice(&chunk);

            // Drain complete lines (terminated by `\n`) from the buffer.
            loop {
                let nl = match buf.iter().position(|&b| b == b'\n') {
                    Some(p) => p,
                    None    => break,
                };
                let line_bytes: Vec<u8> = buf.drain(..=nl).collect();
                let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
                let line = line.trim();
                if !line.starts_with("data: ") {
                    continue;
                }
                let data = &line[6..];
                if data == "[DONE]" {
                    return Ok(false);
                }
                on_data(data);
            }
        }

        Ok(false)
    }

    /// Fire the abort signal for the in-flight request, if any.  Safe to
    /// call when idle: with no armed controller it is a no-op.
    pub fn abort(&self) {
        if let Some(ctrl) = self.abort.borrow().as_ref() {
            ctrl.abort();
        }
    }

    /// Whether the armed abort controller's signal has fired.  Used to
    /// tell a cancelled fetch/stream apart from a genuine failure.
    fn abort_signalled(&self) -> bool {
        self.abort
            .borrow()
            .as_ref()
            .map(|ctrl| ctrl.signal().aborted())
            .unwrap_or(false)
    }
}

/// Render a JS error value as a human-readable string for error tags.
#[cfg(target_arch = "wasm32")]
fn js_str(v: &wasm_bindgen::JsValue) -> String {
    v.as_string().unwrap_or_else(|| fmt!("{:?}", v))
}


// ┌───────────────────────────────────────────────────────────────┐
// │ LineReader — incremental line reader for TLS streams           │
// └───────────────────────────────────────────────────────────────┘

/// Reads lines from a TLS stream, handling HTTP chunked transfer
/// encoding transparently.
///
/// For identity (Content-Length) encoding, lines are read directly
/// from the stream.  For chunked encoding, chunk headers are parsed
/// and chunk data is dechunked on the fly, so the caller sees a
/// continuous stream of lines.
///
/// A line is terminated by `\n` (with or without a preceding `\r`).
#[cfg(not(target_arch = "wasm32"))]
struct LineReader<S: tokio::io::AsyncRead + Unpin> {
    stream:     S,
    buf:        Vec<u8>,
    buf_pos:    usize,
    is_chunked: bool,
    // For chunked encoding: remaining bytes in the current chunk.
    // None means we need to read the next chunk header.
    chunk_remaining: Option<usize>,
    eof:        bool,
}

#[cfg(not(target_arch = "wasm32"))]
impl<S: tokio::io::AsyncRead + Unpin> LineReader<S> {

    fn new(stream: S, is_chunked: bool) -> Self {
        Self {
            stream,
            buf: Vec::with_capacity(8192),
            buf_pos: 0,
            is_chunked,
            chunk_remaining: None,
            eof: false,
        }
    }

    /// Read the next line (without the trailing newline).
    ///
    /// Returns `Ok(None)` at end of stream.
    async fn read_line(&mut self) -> std::io::Result<Option<String>> {
        loop {
            // Try to find a complete line in the buffer.
            if let Some(line) = self.try_extract_line() {
                return Ok(Some(line));
            }
            if self.eof {
                // If there's remaining data without a newline,
                // return it as the last line.
                if self.buf_pos < self.buf.len() {
                    let rest = String::from_utf8_lossy(
                        &self.buf[self.buf_pos..]
                    ).to_string();
                    self.buf_pos = self.buf.len();
                    return Ok(Some(rest));
                }
                return Ok(None);
            }
            // Need more data.
            match self.fill_buf().await {
                Ok(())  => {},
                Err(e)  => return Err(e),
            }
        }
    }

    /// Try to extract a complete line from the buffer.
    fn try_extract_line(&mut self) -> Option<String> {
        let search_start = self.buf_pos;
        let rest = &self.buf[search_start..];
        if let Some(pos) = rest.iter().position(|&b| b == b'\n') {
            let end = search_start + pos;
            let line = &self.buf[self.buf_pos..end];
            // Strip trailing \r if present.
            let line = if line.ends_with(b"\r") { &line[..line.len()-1] } else { line };
            let s = String::from_utf8_lossy(line).to_string();
            self.buf_pos = end + 1; // skip the \n
            // Compact buffer periodically.
            if self.buf_pos > 16384 {
                self.buf.drain(..self.buf_pos);
                self.buf_pos = 0;
            }
            return Some(s);
        }
        None
    }

    /// Read more data into the buffer.
    async fn fill_buf(&mut self) -> std::io::Result<()> {
        let mut tmp = [0u8; 4096];

        if self.is_chunked {
            // For chunked encoding, we need to be careful about
            // chunk boundaries.  However, SSE lines are always
            // within a single chunk in practice (servers don't
            // split a data: line across chunks).  We read raw
            // bytes and handle chunk boundaries in the line
            // buffer.  This is simpler than tracking exact chunk
            // positions and works because we only need lines.
            //
            // For correctness, we parse chunk headers when we
            // run out of chunk data.
            if self.chunk_remaining == Some(0) {
                // Read and discard the trailing \r\n after a chunk,
                // then read the next chunk header.
                let mut crlf = [0u8; 2];
                match self.stream.read_exact(&mut crlf).await {
                    Ok(_) => {}
                    Err(e) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => {
                        self.eof = true;
                        return Ok(());
                    }
                    Err(e) => return Err(e),
                }
                self.chunk_remaining = None;
            }

            if self.chunk_remaining.is_none() {
                // Read chunk size line.
                let mut size_line = Vec::new();
                let mut byte = [0u8; 1];
                loop {
                    match self.stream.read(&mut byte).await {
                        Ok(0) => { self.eof = true; return Ok(()); }
                        Ok(_) => {
                            size_line.push(byte[0]);
                            if size_line.ends_with(b"\r\n") {
                                break;
                            }
                            // Some servers include chunk extensions
                            // after the size: 1a;ext=val\r\n
                            if size_line.ends_with(b"\n") {
                                break;
                            }
                        }
                        Err(e) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => {
                            self.eof = true;
                            return Ok(());
                        }
                        Err(e) => return Err(e),
                    }
                }
                let size_str = String::from_utf8_lossy(&size_line);
                let size_str = size_str.trim();
                // Strip chunk extensions (everything after ;).
                let size_str = size_str.split(';').next().unwrap_or("0").trim();
                let size = match usize::from_str_radix(size_str, 16) {
                    Ok(n) => n,
                    Err(_) => { self.eof = true; return Ok(()); }
                };
                if size == 0 {
                    // Last chunk — end of body.
                    self.eof = true;
                    return Ok(());
                }
                self.chunk_remaining = Some(size);
            }

            // Read up to chunk_remaining bytes or tmp.len(), whichever is smaller.
            let remaining = match self.chunk_remaining {
                Some(r) => r,
                None    => return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "chunk_remaining unexpectedly unset")),
            };
            let to_read = remaining.min(tmp.len());
            match self.stream.read(&mut tmp[..to_read]).await {
                Ok(0) => { self.eof = true; return Ok(()); }
                Ok(n) => {
                    self.buf.extend_from_slice(&tmp[..n]);
                    self.chunk_remaining = Some(remaining - n);
                }
                Err(e) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => {
                    self.eof = true;
                    return Ok(());
                }
                Err(e) => return Err(e),
            }
        } else {
            // Identity encoding — read directly.
            match self.stream.read(&mut tmp).await {
                Ok(0) => { self.eof = true; return Ok(()); }
                Ok(n) => self.buf.extend_from_slice(&tmp[..n]),
                Err(e) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => {
                    self.eof = true;
                    return Ok(());
                }
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

/// Parse an SSE response body, calling `on_token` for each text delta.
///
/// SSE format:
/// ```text
/// data: {"choices":[{"delta":{"content":"Hello"}}]}
///
/// data: {"choices":[{"delta":{"content":" world"}}]}
///
/// data: [DONE]
/// ```
///
/// We scan for `"content":"..."` in each `data:` line.  This is a
/// deliberately simple parser — it handles the common case without
/// needing a full JSON parser.  Escaped quotes inside content are
/// handled by scanning for the matching unescaped quote.
pub fn parse_sse_stream(body: &[u8], on_token: &mut impl FnMut(&str))
    -> (String, u64, u64)
{
    let text = String::from_utf8_lossy(body);
    let mut full = String::new();
    let mut prompt_tokens = 0u64;
    let mut completion_tokens = 0u64;

    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with("data: ") {
            continue;
        }
        let data = &line[6..];
        if data == "[DONE]" {
            break;
        }
        // Extract content from: {"choices":[{"delta":{"content":"..."}}]}
        if let Some(content) = extract_json_string(data, "content") {
            on_token(&content);
            full.push_str(&content);
        }
        // Extract usage from the final chunk:
        // {"choices":[],"usage":{"prompt_tokens":13,"completion_tokens":200}}
        if let Some(usage_str) = find_json_object(data, "usage") {
            if let Some(pt) = extract_json_number(&usage_str, "prompt_tokens") {
                prompt_tokens = pt;
            }
            if let Some(ct) = extract_json_number(&usage_str, "completion_tokens") {
                completion_tokens = ct;
            }
        }
    }

    (full, prompt_tokens, completion_tokens)
}

/// Extract a JSON object value for a key from a JSON string.
///
/// Scans for `"key":{...}` and returns the inner object string
/// (including the braces).  Used to extract the `usage` object
/// from the final SSE chunk.
fn find_json_object(json: &str, key: &str) -> Option<String> {
    let needle = fmt!("\"{}\":", key);
    let pos = match json.find(&needle) {
        Some(p) => p,
        None    => return None,
    };
    let bytes = json.as_bytes();
    // Skip whitespace after the colon to the opening brace.
    let mut start = pos + needle.len();
    while start < bytes.len() && bytes[start].is_ascii_whitespace() { start += 1; }
    if start >= bytes.len() || bytes[start] != b'{' { return None; }
    let mut depth = 0i32;
    let mut i = start;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(json[start..=i].to_string());
                }
            }
            b'"' => {
                // Skip string contents.
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' { i += 2; continue; }
                    if bytes[i] == b'"' { break; }
                    i += 1;
                }
            }
            _ => (),
        }
        i += 1;
    }
    None
}

/// Extract a numeric value for a key from a JSON string.
///
/// Scans for `"key":number` and returns the parsed value.
pub(crate) fn extract_json_number(json: &str, key: &str) -> Option<u64> {
    let needle = fmt!("\"{}\":", key);
    let pos = match json.find(&needle) {
        Some(p) => p,
        None    => return None,
    };
    let mut start = pos + needle.len();
    let bytes = json.as_bytes();
    // Skip whitespace.
    while start < bytes.len() && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    let mut end = start;
    while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'-') {
        end += 1;
    }
    json[start..end].parse::<u64>().ok()
}

/// Extract a boolean value for a key from a JSON string.
///
/// Scans for `"key":true`/`false` and accepts the quoted forms too, since
/// models routinely send a boolean argument as the string `"true"`.
pub fn extract_json_bool(json: &str, key: &str) -> Option<bool> {
    let needle = fmt!("\"{}\":", key);
    let pos = match json.find(&needle) {
        Some(p) => p,
        None    => return None,
    };
    let bytes = json.as_bytes();
    let mut i = pos + needle.len();
    // Skip whitespace, then an optional opening quote.
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'"' {
        i += 1;
    }
    let rest = &json[i..];
    if rest.starts_with("true") {
        Some(true)
    } else if rest.starts_with("false") {
        Some(false)
    } else {
        None
    }
}


/// Handles `\"`, `\\`, `\n`, `\t` escapes.
///
/// The search ensures `key` is a complete JSON key, not a suffix of
/// a longer key (e.g. `"content"` must not match inside
/// `"reasoning_content"`).  This is done by requiring the character
/// before the opening quote to be `{` or `,` (whitespace-tolerant).
pub(crate) fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let needle = fmt!("\"{}\":", key);
    let bytes = json.as_bytes();
    let mut search_from = 0;
    loop {
        let pos = match json[search_from..].find(&needle) {
            Some(p) => search_from + p,
            None => return None,
        };
        // Reject suffix matches (e.g. "content" inside
        // "reasoning_content") by checking the character before the
        // key's opening quote.
        let valid_prefix = pos == 0 || {
            let prev = bytes[pos - 1];
            prev == b'{' || prev == b',' || prev.is_ascii_whitespace()
        };
        if !valid_prefix {
            search_from = pos + needle.len();
            continue;
        }
        // Skip whitespace between the colon and the value — real API
        // output uses `"key": "value"` with a space.
        let mut i = pos + needle.len();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() { i += 1; }
        if i >= bytes.len() || bytes[i] != b'"' {
            // Value is not a string (null / number / object); keep
            // searching in case the key appears again.
            search_from = pos + needle.len();
            continue;
        }
        i += 1; // past the opening quote
        // Collect the string value as bytes, then decode as UTF-8, so
        // multi-byte characters survive.
        let mut out: Vec<u8> = Vec::new();
        while i < bytes.len() {
            let b = bytes[i];
            if b == b'\\' && i + 1 < bytes.len() {
                match bytes[i + 1] {
                    b'"'  => out.push(b'"'),
                    b'\\' => out.push(b'\\'),
                    b'n'  => out.push(b'\n'),
                    b't'  => out.push(b'\t'),
                    b'r'  => out.push(b'\r'),
                    b'/'  => out.push(b'/'),
                    other => { out.push(b'\\'); out.push(other); }
                }
                i += 2;
            } else if b == b'"' {
                return Some(String::from_utf8_lossy(&out).to_string());
            } else {
                out.push(b);
                i += 1;
            }
        }
        return None;
    }
}

/// Convert a JDAT DaticleMap to a minimal JSON string.
///
/// This is used to build the LLM API request body without `serde`.
/// Only handles the types we need: String, U64, Bool, Map, List.
/// Serialise a `ChatMessage` to an OpenAI-API JSON object, including
/// assistant `tool_calls` and the `tool` role — which `datmap_to_json`
/// does not carry.
fn message_to_json(msg: &ChatMessage) -> String {
    match msg {
        ChatMessage::System { content } =>
            fmt!("{{\"role\":\"system\",\"content\":\"{}\"}}", json_escape(content)),
        ChatMessage::User { content } =>
            fmt!("{{\"role\":\"user\",\"content\":\"{}\"}}", json_escape(content)),
        ChatMessage::Assistant { content, tool_calls } => {
            if tool_calls.is_empty() {
                fmt!("{{\"role\":\"assistant\",\"content\":\"{}\"}}", json_escape(content))
            } else {
                let calls: Vec<String> = tool_calls.iter().map(|tc| fmt!(
                    "{{\"id\":\"{}\",\"type\":\"function\",\"function\":{{\"name\":\"{}\",\"arguments\":\"{}\"}}}}",
                    json_escape(&tc.id), json_escape(&tc.name), json_escape(&tc.arguments))).collect();
                fmt!("{{\"role\":\"assistant\",\"content\":\"{}\",\"tool_calls\":[{}]}}",
                    json_escape(content), calls.join(","))
            }
        }
        ChatMessage::Tool { tool_call_id, content } =>
            fmt!("{{\"role\":\"tool\",\"tool_call_id\":\"{}\",\"content\":\"{}\"}}",
                json_escape(tool_call_id), json_escape(content)),
    }
}

/// Parse a non-streaming chat completion body into
/// `(content, tool_calls, prompt_tokens, completion_tokens)`.
fn parse_full_response(body: &str) -> (String, Vec<ToolCall>, u64, u64) {
    // Scope content extraction to before "tool_calls" so we don't pick
    // up a "content" key inside a tool call's arguments.
    let scope_end = body.find("\"tool_calls\"").unwrap_or(body.len());
    let content = extract_json_string(&body[..scope_end], "content").unwrap_or_default();

    let mut tool_calls = Vec::new();
    if let Some(arr) = find_json_array(body, "tool_calls") {
        for elem in split_top_level_objects(&arr) {
            let name = match extract_json_string(&elem, "name") {
                Some(n) if !n.is_empty() => n,
                _ => continue,
            };
            let id = extract_json_string(&elem, "id").unwrap_or_default();
            let arguments = extract_json_string(&elem, "arguments")
                .unwrap_or_else(|| "{}".to_string());
            tool_calls.push(ToolCall { id, name, arguments });
        }
    }

    let mut pt = 0u64;
    let mut ct = 0u64;
    if let Some(usage) = find_json_object(body, "usage") {
        pt = extract_json_number(&usage, "prompt_tokens").unwrap_or(0);
        ct = extract_json_number(&usage, "completion_tokens").unwrap_or(0);
    }
    (content, tool_calls, pt, ct)
}


// ┌───────────────────────────────────────────────────────────────┐
// │ StreamAcc — streamed delta accumulator                         │
// └───────────────────────────────────────────────────────────────┘

/// One tool call being reconstructed from streamed fragments.
///
/// A streamed `tool_calls` delta arrives in pieces keyed by `index`: the
/// first fragment usually carries the `id` and function `name` with an
/// empty `arguments`, and later fragments append `arguments` text until
/// the call is whole.
struct StreamCall {
    /// Position of this call within the assistant turn.
    index:     i64,
    id:        String,
    name:      String,
    /// Accumulated raw JSON arguments, concatenated across fragments.
    arguments: String,
}

/// Accumulates OpenAI-style streaming chat deltas across SSE chunks:
/// text content, incrementally-built tool calls, and usage.
///
/// Each `data:` payload is fed to [`ingest`](StreamAcc::ingest); when the
/// stream ends, [`into_response`](StreamAcc::into_response) yields the
/// assembled [`ChatOnceResponse`].
#[derive(Default)]
struct StreamAcc {
    content:           String,
    prompt_tokens:     u64,
    completion_tokens: u64,
    calls:             Vec<StreamCall>,
}

impl StreamAcc {

    /// Fold one SSE `data:` payload into the accumulator, forwarding any
    /// text delta to `on_token` as it arrives.
    fn ingest(&mut self, data: &str, on_token: &mut impl FnMut(&str)) {
        // Text delta — scoped to before any `tool_calls` so a `content`
        // key inside a tool call's arguments is never mistaken for it.
        let scope_end = data.find("\"tool_calls\"").unwrap_or(data.len());
        if let Some(content) = extract_json_string(&data[..scope_end], "content") {
            if !content.is_empty() {
                on_token(&content);
                self.content.push_str(&content);
            }
        }

        // Tool-call fragments — merge each into its slot by `index`.
        if let Some(arr) = find_json_array(data, "tool_calls") {
            for elem in split_top_level_objects(&arr) {
                let index = extract_json_number(&elem, "index")
                    .map(|n| n as i64)
                    .unwrap_or(0);
                // Locate an existing slot by index before borrowing
                // mutably, so a new slot can be pushed without an
                // overlapping borrow.
                let pos = self.calls.iter().position(|c| c.index == index);
                let slot = match pos {
                    Some(p) => &mut self.calls[p],
                    None => {
                        self.calls.push(StreamCall {
                            index,
                            id:        String::new(),
                            name:      String::new(),
                            arguments: String::new(),
                        });
                        let last = self.calls.len() - 1;
                        &mut self.calls[last]
                    }
                };
                if let Some(id) = extract_json_string(&elem, "id") {
                    if !id.is_empty() { slot.id = id; }
                }
                if let Some(name) = extract_json_string(&elem, "name") {
                    if !name.is_empty() { slot.name = name; }
                }
                if let Some(args) = extract_json_string(&elem, "arguments") {
                    slot.arguments.push_str(&args);
                }
            }
        }

        // Usage — present on the final chunk when include_usage is set.
        if let Some(usage) = find_json_object(data, "usage") {
            if let Some(pt) = extract_json_number(&usage, "prompt_tokens") {
                self.prompt_tokens = pt;
            }
            if let Some(ct) = extract_json_number(&usage, "completion_tokens") {
                self.completion_tokens = ct;
            }
        }
    }

    /// Consume the accumulator into a [`ChatOnceResponse`].  Calls with no
    /// name are dropped (a stray fragment), and an empty arguments string
    /// becomes `{}` so tool dispatch always sees a valid JSON object.
    fn into_response(self, aborted: bool) -> ChatOnceResponse {
        let tool_calls = self.calls.into_iter()
            .filter(|c| !c.name.is_empty())
            .map(|c| ToolCall {
                id:        c.id,
                name:      c.name,
                arguments: if c.arguments.is_empty() { "{}".to_string() } else { c.arguments },
            })
            .collect();
        ChatOnceResponse {
            content:           self.content,
            tool_calls,
            prompt_tokens:     self.prompt_tokens,
            completion_tokens: self.completion_tokens,
            aborted,
        }
    }
}

/// Extract a JSON array value for a key, returning the inner text
/// including the surrounding brackets.  String contents are skipped so
/// brackets inside strings don't confuse the depth count.
fn find_json_array(json: &str, key: &str) -> Option<String> {
    let needle = fmt!("\"{}\":", key);
    let pos = match json.find(&needle) {
        Some(p) => p,
        None    => return None,
    };
    let bytes = json.as_bytes();
    // Skip whitespace after the colon to the opening bracket.
    let mut start = pos + needle.len();
    while start < bytes.len() && bytes[start].is_ascii_whitespace() { start += 1; }
    if start >= bytes.len() || bytes[start] != b'[' { return None; }
    let mut depth = 0i32;
    let mut in_str = false;
    let mut i = start;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str {
            if b == b'\\' { i += 2; continue; }
            if b == b'"' { in_str = false; }
        } else {
            match b {
                b'"' => in_str = true,
                b'[' => depth += 1,
                b']' => {
                    depth -= 1;
                    if depth == 0 { return Some(json[start..=i].to_string()); }
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

/// Split a JSON array's text into its top-level `{...}` object elements.
fn split_top_level_objects(arr: &str) -> Vec<String> {
    let bytes = arr.as_bytes();
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    let mut in_str = false;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str {
            if b == b'\\' { i += 2; continue; }
            if b == b'"' { in_str = false; }
        } else {
            match b {
                b'"' => in_str = true,
                b'{' => { if depth == 0 { start = i; } depth += 1; }
                b'}' => {
                    depth -= 1;
                    if depth == 0 { out.push(arr[start..=i].to_string()); }
                }
                _ => {}
            }
        }
        i += 1;
    }
    out
}

pub fn datmap_to_json(m: &DaticleMap) -> String {
    let mut out = String::with_capacity(256);
    out.push('{');
    let mut first = true;
    // DaticleMap iteration is not ordered — we sort keys for
    // deterministic output (not required by the API but cleaner).
    let mut entries: Vec<(&Dat, &Dat)> = m.iter().collect();
    entries.sort_by(|a, b| {
        match (a.0, b.0) {
            (Dat::Str(a_s), Dat::Str(b_s)) => a_s.cmp(b_s),
            _ => std::cmp::Ordering::Equal,
        }
    });
    for (k, v) in entries {
        if !first { out.push(','); }
        first = false;
        if let Dat::Str(k_s) = k {
            out.push('"');
            out.push_str(k_s);
            out.push_str("\":");
            out.push_str(&dat_to_json(v));
        }
    }
    out.push('}');
    out
}

/// Escape a string for embedding inside a JSON string literal (no
/// surrounding quotes).  Shared with the tool-definition builder.
pub(crate) fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"'  => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&fmt!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Convert a JDAT Dat value to JSON.
fn dat_to_json(d: &Dat) -> String {
    match d {
        Dat::Str(s) => {
            let mut out = String::with_capacity(s.len() + 2);
            out.push('"');
            for c in s.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\t' => out.push_str("\\t"),
                    '\r' => out.push_str("\\r"),
                    c if (c as u32) < 0x20 => {
                        out.push_str(&fmt!("\\u{:04x}", c as u32));
                    }
                    c => out.push(c),
                }
            }
            out.push('"');
            out
        }
        Dat::U64(n) => fmt!("{}", n),
        Dat::Bool(b) => fmt!("{}", b),
        Dat::List(list) => {
            let items: Vec<String> = list.iter().map(dat_to_json).collect();
            fmt!("[{}]", items.join(","))
        }
        Dat::Map(m) => datmap_to_json(m),
        Dat::Empty => "null".to_string(),
        _ => "null".to_string(),
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    fn test_extract_json_string() {
        let json = r#"{"choices":[{"delta":{"content":"hello"}}]}"#;
        assert_eq!(extract_json_string(json, "content"), Some("hello".to_string()));
    }

    #[test]
    fn test_extract_json_bool() {
        assert_eq!(extract_json_bool(r#"{"submit":true}"#, "submit"), Some(true));
        assert_eq!(extract_json_bool(r#"{"submit": false}"#, "submit"), Some(false));
        // A model that quotes the boolean is still understood.
        assert_eq!(extract_json_bool(r#"{"submit":"true"}"#, "submit"), Some(true));
        assert_eq!(extract_json_bool(r#"{"ref":3}"#, "submit"), None);
    }

    #[test]
    fn test_extract_json_string_escaped() {
        let json = r#"{"choices":[{"delta":{"content":"hello \"world\""}}]}"#;
        assert_eq!(extract_json_string(json, "content"), Some("hello \"world\"".to_string()));
    }

    #[test]
    fn test_extract_json_string_newline() {
        let json = r#"{"choices":[{"delta":{"content":"line1\nline2"}}]}"#;
        assert_eq!(extract_json_string(json, "content"), Some("line1\nline2".to_string()));
    }

    #[test]
    fn test_parse_sse_simple() {
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\ndata: [DONE]\n";
        let mut tokens = Vec::new();
        let (full, _pt, _ct) = parse_sse_stream(sse.as_bytes(), &mut |t| tokens.push(t.to_string()));
        assert_eq!(tokens, vec!["Hello", " world"]);
        assert_eq!(full, "Hello world");
    }

    #[test]
    fn test_parse_sse_empty_lines() {
        let sse = "\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\r\n\r\ndata: [DONE]\r\n";
        let mut tokens = Vec::new();
        let (full, _pt, _ct) = parse_sse_stream(sse.as_bytes(), &mut |t| tokens.push(t.to_string()));
        assert_eq!(tokens, vec!["Hi"]);
        assert_eq!(full, "Hi");
    }

    // Chunked transfer decoding is now handled inline by `LineReader`;
    // the standalone `dechunk` helper and its tests were removed.

    #[test]
    fn test_parse_full_response_tool_calls() {
        let body = r#"{"choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"file_read","arguments":"{\"path\":\"a.txt\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":8}}"#;
        let (content, calls, pt, ct) = parse_full_response(body);
        assert_eq!(content, "");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].name, "file_read");
        assert_eq!(calls[0].arguments, r#"{"path":"a.txt"}"#);
        assert_eq!(pt, 12);
        assert_eq!(ct, 8);
    }

    #[test]
    fn test_extract_json_string_whitespace() {
        // Real model output has a space after the colon.
        assert_eq!(extract_json_string(r#"{"path": "a.txt"}"#, "path"), Some("a.txt".to_string()));
        assert_eq!(extract_json_string(r#"{ "content": "hi" }"#, "content"), Some("hi".to_string()));
        // A null value is not a string.
        assert_eq!(extract_json_string(r#"{"content": null, "x":"y"}"#, "content"), None);
    }

    #[test]
    fn test_parse_full_response_spaced() {
        // Whitespace after colons, as real APIs emit.
        let body = r#"{"choices": [{"message": {"content": null, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "file_write", "arguments": "{\"path\": \"a.txt\", \"content\": \"hi\"}"}}]}}], "usage": {"prompt_tokens": 4, "completion_tokens": 2}}"#;
        let (content, calls, pt, ct) = parse_full_response(body);
        assert_eq!(content, "");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "file_write");
        assert_eq!(calls[0].arguments, r#"{"path": "a.txt", "content": "hi"}"#);
        assert_eq!(pt, 4);
        assert_eq!(ct, 2);
        // And the tool can extract the spaced args.
        assert_eq!(extract_json_string(&calls[0].arguments, "path"), Some("a.txt".to_string()));
    }

    #[test]
    fn test_parse_full_response_text() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"Hello there."},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}"#;
        let (content, calls, pt, ct) = parse_full_response(body);
        assert_eq!(content, "Hello there.");
        assert!(calls.is_empty());
        assert_eq!(pt, 5);
        assert_eq!(ct, 3);
    }

    #[test]
    fn test_parse_full_response_two_calls() {
        let body = r#"{"choices":[{"message":{"content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"file_list","arguments":"{}"}},{"id":"c2","type":"function","function":{"name":"shell","arguments":"{\"command\":\"ls\"}"}}]}}]}"#;
        let (_c, calls, _p, _ct) = parse_full_response(body);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "file_list");
        assert_eq!(calls[1].name, "shell");
        assert_eq!(calls[1].arguments, r#"{"command":"ls"}"#);
    }

    /// Drive a sequence of SSE `data:` payloads through a fresh
    /// [`StreamAcc`], collecting the forwarded text tokens.
    fn run_stream(chunks: &[&str]) -> (ChatOnceResponse, Vec<String>) {
        let mut acc = StreamAcc::default();
        let mut tokens = Vec::new();
        for c in chunks {
            acc.ingest(c, &mut |t| tokens.push(t.to_string()));
        }
        (acc.into_response(false), tokens)
    }

    #[test]
    fn test_stream_acc_text_only() {
        let (resp, tokens) = run_stream(&[
            r#"{"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}"#,
            r#"{"choices":[{"delta":{"content":"lo!"}}]}"#,
            r#"{"choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}"#,
        ]);
        assert_eq!(tokens, vec!["Hel", "lo!"]);
        assert_eq!(resp.content, "Hello!");
        assert!(resp.tool_calls.is_empty());
        assert_eq!(resp.prompt_tokens, 7);
        assert_eq!(resp.completion_tokens, 3);
        assert!(!resp.aborted);
    }

    #[test]
    fn test_stream_acc_tool_call_fragments() {
        // The name arrives with the first fragment; the arguments are split
        // across two later fragments and must be concatenated verbatim.
        let (resp, tokens) = run_stream(&[
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"file_read","arguments":""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":\""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"a.txt\"}"}}]}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":8}}"#,
        ]);
        assert!(tokens.is_empty());
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].id, "call_1");
        assert_eq!(resp.tool_calls[0].name, "file_read");
        assert_eq!(resp.tool_calls[0].arguments, r#"{"path":"a.txt"}"#);
        assert_eq!(resp.prompt_tokens, 12);
        assert_eq!(resp.completion_tokens, 8);
    }

    #[test]
    fn test_stream_acc_two_parallel_calls() {
        // Two calls interleaved by index across chunks.
        let (resp, _t) = run_stream(&[
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"file_list","arguments":"{}"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1","function":{"name":"file_read","arguments":"{\"path\":"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\"b.txt\"}"}}]}}]}"#,
        ]);
        assert_eq!(resp.tool_calls.len(), 2);
        assert_eq!(resp.tool_calls[0].name, "file_list");
        assert_eq!(resp.tool_calls[0].arguments, "{}");
        assert_eq!(resp.tool_calls[1].name, "file_read");
        assert_eq!(resp.tool_calls[1].arguments, r#"{"path":"b.txt"}"#);
    }

    #[test]
    fn test_stream_acc_text_then_tool_call() {
        // Interim assistant text streams, then a tool call is requested.
        let (resp, tokens) = run_stream(&[
            r#"{"choices":[{"delta":{"content":"Let me check. "}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"file_list","arguments":"{}"}}]}}]}"#,
        ]);
        assert_eq!(tokens, vec!["Let me check. "]);
        assert_eq!(resp.content, "Let me check. ");
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].name, "file_list");
    }

    #[test]
    fn test_message_to_json_assistant_tool_calls() {
        let msg = ChatMessage::Assistant {
            content: String::new(),
            tool_calls: vec![ToolCall {
                id: "c1".to_string(),
                name: "shell".to_string(),
                arguments: r#"{"command":"ls"}"#.to_string(),
            }],
        };
        let j = message_to_json(&msg);
        assert!(j.contains(r#""role":"assistant""#));
        assert!(j.contains(r#""tool_calls""#));
        assert!(j.contains(r#""name":"shell""#));
        // Arguments must be re-escaped as a JSON string literal.
        assert!(j.contains(r#""arguments":"{\"command\":\"ls\"}""#));
    }

    #[test]
    fn test_datmap_to_json() {
        let mut m = DaticleMap::new();
        m.insert(dat!("role"), dat!("user"));
        m.insert(dat!("content"), dat!("hello"));
        let json = datmap_to_json(&m);
        // Keys are sorted.
        assert!(json.contains("\"content\":\"hello\""));
        assert!(json.contains("\"role\":\"user\""));
    }

    #[test]
    fn test_datmap_to_json_escaped() {
        let mut m = DaticleMap::new();
        m.insert(dat!("content"), dat!("hello \"world\"\n"));
        let json = datmap_to_json(&m);
        assert!(json.contains("\\\"world\\\""));
        assert!(json.contains("\\n"));
    }

    #[test]
    fn test_build_request_body() {
        use rustls::crypto::ring;
        let _ = ring::default_provider().install_default();
        let tls = Arc::new(
            ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(NoVerify))
                .with_no_client_auth()
        );
        let client = LlmClient::new("api.test.com", 443, "/v1/chat", "key", "model", 4096, tls);
        let messages = vec![
            ChatMessage::System { content: "You are helpful".to_string() },
            ChatMessage::User { content: "Hello".to_string() },
        ];
        let body = client.build_request_body(&messages);
        assert!(body.contains("\"model\":\"model\""));
        assert!(body.contains("\"stream\":true"));
        assert!(body.contains("\"role\":\"system\""));
        assert!(body.contains("\"role\":\"user\""));
        assert!(body.contains("\"content\":\"You are helpful\""));
        assert!(body.contains("\"content\":\"Hello\""));
    }

    // Test verifier that accepts any certificate (for unit tests only).
    use tokio_rustls::rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use std::sync::Arc;

    #[derive(Debug)]
    pub struct NoVerify;

    impl ServerCertVerifier for NoVerify {
        fn verify_server_cert(
            &self,
            _end_entity: &tokio_rustls::rustls::pki_types::CertificateDer<'_>,
            _intermediates: &[tokio_rustls::rustls::pki_types::CertificateDer<'_>],
            _server_name: &tokio_rustls::rustls::pki_types::ServerName<'_>,
            _ocsp_response: &[u8],
            _now: tokio_rustls::rustls::pki_types::UnixTime,
        ) -> Result<ServerCertVerified, tokio_rustls::rustls::Error> {
            Ok(ServerCertVerified::assertion())
        }
        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &tokio_rustls::rustls::pki_types::CertificateDer<'_>,
            _dss: &tokio_rustls::rustls::DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &tokio_rustls::rustls::pki_types::CertificateDer<'_>,
            _dss: &tokio_rustls::rustls::DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn supported_verify_schemes(&self) -> Vec<tokio_rustls::rustls::SignatureScheme> {
            vec![
                tokio_rustls::rustls::SignatureScheme::RSA_PKCS1_SHA256,
                tokio_rustls::rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
                tokio_rustls::rustls::SignatureScheme::ED25519,
            ]
        }
    }
}
