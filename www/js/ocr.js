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

	/// WHICH PROVIDER PAYS EACH READ (OWNKEY A1, QA OKD-A M-2): `{ pdf, image }`, each a provider
	/// id or '' for none. This is the one place the decision is made: the fetches below obey it,
	/// and peer.js `makeErrand` sends `route({ runner: true })` to a runner as the errand's `ocr`,
	/// so a runner reads with exactly the keys this tab would and never guesses.
	///
	/// `pdf` is an explicit `openrouter` provider first; failing that, the running default
	/// provider WHEN its endpoint is OpenRouter -- which is how a Daimond-credits key, minted to
	/// run models through OpenRouter, pays for the file parser without the user configuring a
	/// second thing. `image` is `mistral` when he has a Mistral key (its OCR first, falling
	/// through to a vision model on the `pdf` route), else the `pdf` route itself.
	///
	/// For a runner, a row that fails models.js `runnerReach` counts as absent (lead ruling,
	/// ledger l.375): the route falls back exactly as it would without that row, so a turn that
	/// never reads still runs there, and only an actual read meets the plain refusal.
	function route(opts) {
		var out = { pdf: '', image: '' };
		var m = M();
		if (!m) return out;
		var runner = !!(opts && opts.runner);
		var usable = function (pid) {
			if (!runner) return true;
			return typeof m.runnerReach === 'function' && !!m.runnerReach(pid).ok;
		};
		var own = function (pid) {
			return !!(m.hasKey && m.hasKey(pid) && m.keyFor(pid)) && usable(pid);
		};
		if (own('openrouter')) {
			out.pdf = 'openrouter';
		} else {
			var d = m.resolve ? m.resolve('', '') : null;
			if (d && d.apiKey && d.baseUrl && d.provider && usable(String(d.provider))) {
				var host = '';
				try { host = new URL(d.baseUrl).host; } catch (e) { host = ''; }
				if (/(^|\.)openrouter\.ai$/.test(host)) out.pdf = String(d.provider);
			}
		}
		out.image = own('mistral') ? 'mistral' : out.pdf;
		return out;
	}

	/// The OpenRouter endpoint and key `route()` names for a PDF, or null when it names none.
	function openrouter() {
		var m = M(), pid = route().pdf;
		if (!m || !pid) return null;
		// His row may hold a base URL or the whole endpoint; models.js `chatUrl` reconciles the
		// two exactly as the runner's `LlmClient::from_url` does.
		if (pid === 'openrouter') {
			var base = (m.providerUrl && m.providerUrl('openrouter')) || OPENROUTER_CHAT;
			return { url: m.chatUrl(String(base)), key: m.keyFor('openrouter') };
		}
		var d = m.resolve('', '');
		return (d && d.provider === pid) ? { url: m.chatUrl(String(d.baseUrl)), key: d.apiKey } : null;
	}

	/// The Mistral OCR endpoint and key, or null when `route()` does not send pictures there. The
	/// endpoint is his row's `/ocr` sibling (models.js `siblingUrl`), the address the runner's
	/// `sibling` derives from the same row, so tab and runner follow his row alike.
	function mistral() {
		var m = M();
		if (!m || route().image !== 'mistral') return null;
		var base = m.providerUrl ? m.providerUrl('mistral') : '';
		var url = (base && m.siblingUrl) ? m.siblingUrl(String(base), 'ocr') : MISTRAL_OCR;
		return { url: url, key: m.keyFor('mistral') };
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

	window.DaimondOcr = { chat: chat, image: image, route: route };
})();
