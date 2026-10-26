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
 *   EDIT    OpenRouter's Image API, `/images` beside his row's chat endpoint, on the PDF route's
 *           key (UNBLOCK-9, `image_edit`). A reply that links to its picture rather than
 *           carrying it is fetched here, so the wasm always sees `data[0].b64_json`.
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

	/// The bytes behind an `ArrayBuffer`, as base64, in slices `String.fromCharCode` can take.
	function b64(buf) {
		var u = new Uint8Array(buf), s = '';
		for (var i = 0; i < u.length; i += 0x8000) {
			s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
		}
		return btoa(s);
	}

	/// A reply whose first picture is a `url` and not `b64_json`, with that picture fetched into
	/// `b64_json` so the wasm parses one shape. Any other reply is returned as it came.
	async function inlined(body) {
		var j = null;
		try { j = JSON.parse(body); } catch (e) { return body; }
		var d = j && j.data && j.data[0];
		if (!d || d.b64_json || typeof d.url !== 'string' || !/^https:/.test(d.url)) return body;
		var r = await fetch(d.url);
		if (!r.ok) throw new Error('The image model made a picture, but fetching it returned HTTP ' + r.status + '.');
		d.b64_json = b64(await r.arrayBuffer());
		delete d.url;
		return JSON.stringify(j);
	}

	/// POST an Image API body (`image_edit`) to OpenRouter's `/images` on the PDF route: his
	/// `openrouter` row, else the Daimond-credits key routed through OpenRouter. Resolves the
	/// raw response body, a linked picture already fetched into it.
	async function images(body) {
		var o = openrouter();
		if (!o) {
			throw new Error(
				'Editing a picture needs an OpenRouter key or Daimond credits: an image model there '
				+ 'makes it. Add a key in the models panel, or run your models through OpenRouter.');
		}
		// The sibling of his chat endpoint, as the runner's `LlmClient::sibling` derives it.
		var url = M().siblingUrl(o.url, 'images'); // fixed: OpenRouter Image API path
		var res = await post(url, o.key, body);
		if (!res.ok && !res.body) {
			throw new Error('OpenRouter returned HTTP ' + res.status + ' with no body.');
		}
		return res.ok ? inlined(res.body) : res.body;
	}

	/// GET a JSON document on the OpenRouter route, or null where it did not answer with one.
	async function getJson(o, url) {
		try {
			var auth = (M() && M().authHeaders) ? M().authHeaders(url, o.key) : { authorization: 'Bearer ' + o.key };
			var r = await fetch(url, { headers: auth });
			return r.ok ? await r.json() : null;
		} catch (e) { return null; }
	}

	var catalogueOnce = null;	// the one fetch of the catalogue this page makes, shared

	/// The Image API catalogue and each picture-taking model's price, fetched once a page on the
	/// PDF route and handed to models.js (`setImageCatalogue`): the list at `/images/models`
	/// beside his chat endpoint, then each model's own `endpoints` address, which the list names.
	/// A `google/` model is listed but not priced, since it is never the computed default.
	function imageCatalogue() {
		if (catalogueOnce) return catalogueOnce;
		catalogueOnce = (async function () {
			var o = openrouter(), m = M();
			if (!o || !m) { catalogueOnce = null; return { models: [], prices: {} }; }
			var list = await getJson(o, m.siblingUrl(o.url, 'images/models')); // fixed: OpenRouter Image API path
			var models = (list && Array.isArray(list.data)) ? list.data : [];
			var prices = {};
			await Promise.all(models.filter(function (x) {
				return m.imageTakesPicture(x) && typeof x.endpoints === 'string' && !/^google\//.test(String(x.id));
			}).map(async function (x) {
				var at = '';
				try { at = new URL(x.endpoints, o.url).href; } catch (e) { return; }
				var pr = m.imagePrice(await getJson(o, at));
				if (pr) prices[x.id] = pr;
			}));
			if (!models.length) catalogueOnce = null;	// asked again next time, not cached empty
			var cat = { models: models, prices: prices };
			m.setImageCatalogue(models, prices);
			return cat;
		})();
		return catalogueOnce;
	}

	/// The "Image editing" model as `{"id","price"}` JSON: his Jobs pick, else the cheapest the
	/// catalogue prices (models.js `imageModelOf`); empty when there is neither.
	async function imageModel() {
		var m = M();
		if (!m || typeof m.imageModelOf !== 'function') return JSON.stringify({ id: '', price: '' });
		var pick = m.getJob('imageEditing');
		var cat = pick.model ? null : await imageCatalogue();
		return JSON.stringify(m.imageModelOf(cat) || { id: '', price: '' });
	}

	window.DaimondOcr = { chat: chat, image: image, images: images, imageModel: imageModel,
		imageCatalogue: imageCatalogue, route: route };
})();
