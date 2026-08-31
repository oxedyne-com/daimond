/* ocr.js — window.DaimondOcr: the authenticated POSTs that turn a PDF or an image into text.
 *
 * THE MODEL NEVER RECEIVES PIXELS. A PDF or a photograph is parsed on the far side of one
 * throwaway request and only its TEXT comes back, so the transcript costs the turn words and
 * not image tokens. The Rust tools (`file_read` on a `.pdf`, and `ocr`) build the request
 * bodies and parse the replies; this file does the one thing that must happen in the page —
 * the authenticated fetch — because the provider KEY lives here, in `DaimondModels`, and must
 * not cross into the wasm.
 *
 * Two endpoints, both verified against the live docs on 2026-08-31:
 *
 *   PDF     OpenRouter chat/completions with the `file-parser` plugin in the BODY. The parsed
 *           text comes back as `annotations` on the assistant message. This needs an OpenRouter
 *           key specifically: the plugin is OpenRouter's. A credits key routed through
 *           OpenRouter counts.
 *
 *   IMAGE   Mistral's own `/v1/ocr` (returns markdown text, the cheap path) when a `mistral`
 *           key is configured, else a vision model on OpenRouter reading an `image_url` part.
 *
 * Everything here returns the RAW response body to the wasm, which parses it — so the defensive
 * parsing is one place, in Rust, and tested there.
 */
(function () {
	'use strict';

	var OPENROUTER_CHAT = 'https://openrouter.ai/api/v1/chat/completions';
	var MISTRAL_OCR     = 'https://api.mistral.ai/v1/ocr';

	function M() { return window.DaimondModels; }

	/// The OpenRouter endpoint and key, or null when none can be found.
	///
	/// An explicit `openrouter` provider first; failing that, the running default provider WHEN
	/// its endpoint is OpenRouter — which is how a Daimond-credits key, minted to run models
	/// through OpenRouter, pays for the file parser without the user configuring a second thing.
	function openrouter() {
		var m = M();
		if (!m) return null;
		if (m.hasKey && m.hasKey('openrouter') && m.keyFor('openrouter')) {
			var provs = m.providers ? m.providers() : {};
			var known = m.known ? m.known() : {};
			var url = (provs.openrouter && provs.openrouter.url)
				|| (known.openrouter && known.openrouter.url)
				|| OPENROUTER_CHAT;
			return { url: url, key: m.keyFor('openrouter') };
		}
		var d = m.resolve ? m.resolve('', '') : null;
		if (d && d.apiKey && d.baseUrl) {
			var host = '';
			try { host = new URL(d.baseUrl).host; } catch (e) { host = ''; }
			if (/(^|\.)openrouter\.ai$/.test(host)) return { url: d.baseUrl, key: d.apiKey };
		}
		return null;
	}

	/// The Mistral OCR endpoint and key, or null when no `mistral` provider is configured.
	function mistral() {
		var m = M();
		if (!m || !m.hasKey || !m.hasKey('mistral') || !m.keyFor('mistral')) return null;
		return { url: MISTRAL_OCR, key: m.keyFor('mistral') };
	}

	/// POST a JSON body with the right auth for the endpoint. Returns {ok, status, body}.
	async function post(url, key, body) {
		var headers = { 'content-type': 'application/json' };
		var auth = (M() && M().authHeaders)
			? M().authHeaders(url, key)
			: { authorization: 'Bearer ' + key };
		for (var k in auth) { if (auth.hasOwnProperty(k)) headers[k] = auth[k]; }
		var r = await fetch(url, { method: 'POST', headers: headers, body: body });
		var text = '';
		try { text = await r.text(); } catch (e) { text = ''; }
		return { ok: r.ok, status: r.status, body: text };
	}

	/// POST a file-parser body to OpenRouter; resolve the raw response body.
	async function chat(body) {
		var o = openrouter();
		if (!o) {
			throw new Error(
				'Reading a PDF needs an OpenRouter key: its file parser does the work. '
				+ 'Add one in the models panel, or run your models through OpenRouter.');
		}
		var res = await post(o.url, o.key, body);
		if (!res.ok && !res.body) {
			throw new Error('OpenRouter returned HTTP ' + res.status + ' with no body.');
		}
		return res.body;
	}

	/// Transcribe an image. Mistral OCR first (returns text, cheapest), a vision model on
	/// OpenRouter as the fallback. Resolves '{"route":...,"body":...}' as a JSON string.
	async function image(mistralBody, visionBody) {
		var ms = mistral();
		if (ms) {
			var r = await post(ms.url, ms.key, mistralBody);
			// A Mistral hiccup falls through to the vision model rather than failing the call.
			if (r.ok && r.body) return JSON.stringify({ route: 'mistral', body: r.body });
		}
		var o = openrouter();
		if (o) {
			var v = await post(o.url, o.key, visionBody);
			if (!v.ok && !v.body) {
				throw new Error('OpenRouter returned HTTP ' + v.status + ' with no body.');
			}
			return JSON.stringify({ route: 'vision', body: v.body });
		}
		throw new Error(
			'Reading an image needs a provider key: a Mistral key (its OCR returns text cheaply) '
			+ 'or an OpenRouter key (a vision model reads it). Add one in the models panel.');
	}

	window.DaimondOcr = { chat: chat, image: image };
})();
