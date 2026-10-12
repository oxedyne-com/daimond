/* ============================================================
   Daimond — the Austenite compiler, off the main thread
   ------------------------------------------------------------
   A module worker holding the ONE Austenite instance the live
   preview compiles with (typst.js `getAustenite`). The wasm runs
   here so that a rebuild never holds the page: measured on
   12 Oct (au_preview_measure.md), a one-character edit to a
   300-page book took 0.25 s in the engine with the paragraph
   memo (fe2o3 be95a5d9) and 1.35 s when every paragraph holds
   inline maths, and on the main thread that is a keyboard that
   stops answering for as long.

   The protocol is one request, one reply, matched by `id`:

     { id, op, args }            -> { id, value, heap }
                                  | { id, error, heap }

   A page's SVG crosses as BYTES, MOVED, never copied: each
   `changed[i].svg` goes out as UTF-8 in its own ArrayBuffer on the
   transfer list, and the page decodes it once (typst.js `unpack`).
   A string posted as a string is structured-cloned: the page gets
   a copy while the worker's is garbage until its GC, so a 300-page
   reply sat in memory twice (the 3.74 GB kill of 12 Oct,
   au_preview_measure.md).

   `op` is a method of `DaimondTypst` (compileProjectDelta,
   renderPage, queryProject). `heap` is the instance's wasm heap in MB after
   the call, so the page can answer `heapMB()` synchronously.
   The first message out is `{ id: 0, ready: true, heap }` or
   `{ id: 0, error }`, once the module is built.

   Security (H5): bytes and strings in, bytes and strings out;
   a worker has no DOM.
   ============================================================ */

const VENDOR = new URL('../vendor/austenite/', import.meta.url);
const GLUE   = new URL('oxedyne_fe2o3_austenite.js', VENDOR);
const WASM   = new URL('oxedyne_fe2o3_austenite_bg.wasm', VENDOR);
const OPS    = ['compileProjectDelta', 'renderPage', 'queryProject'];

let aust = null;	// the instance, once built
let fault = '';		// why it could not be built, if it could not

const ENC = new TextEncoder();

/// Turn each page's SVG -- a delta's `changed[i].svg`, or a `renderPage` answer's
/// `svg` -- into UTF-8 bytes in place, and name their buffers for the transfer list, so
/// the reply moves them rather than cloning them.
function pack(value) {
	const xfer = [];
	const changed = value && Array.isArray(value.changed) ? value.changed.slice() : [];
	if (value && typeof value.svg === 'string') changed.push(value);
	for (const c of changed) {
		if (!c || typeof c.svg !== 'string') continue;
		const b = ENC.encode(c.svg);
		c.svg = b;
		xfer.push(b.buffer);
	}
	return xfer;
}

function heap() {
	try { return aust ? Number(aust.heapMB()) || 0 : 0; } catch (e) { return 0; }
}

async function run(m) {
	const id = m && m.id;
	if (fault) { self.postMessage({ id, error: fault }); return; }
	if (!OPS.includes(m && m.op)) {
		self.postMessage({ id, error: 'The Austenite worker has no operation ' + String(m && m.op) + '.', heap: heap() });
		return;
	}
	try {
		const value = await Promise.resolve(aust[m.op].apply(aust, m.args || []));
		const xfer = pack(value);
		self.postMessage({ id, value, heap: heap() }, xfer);
	} catch (e) {
		self.postMessage({ id, error: String(e && e.message ? e.message : e), heap: heap() });
	}
}

const built = (async function () {
	try {
		const mod = await import(GLUE.href);
		await mod.default(WASM.href);
		aust = new mod.DaimondTypst();
		self.postMessage({ id: 0, ready: true, heap: heap() });
	} catch (e) {
		fault = 'The Austenite compiler could not be loaded: ' + String(e && e.message ? e.message : e);
		self.postMessage({ id: 0, error: fault });
	}
})();

// ONE AT A TIME, IN ARRIVAL ORDER, through one chain: the instance's memo and its
// `version` counter assume sequential calls, and a request that arrives while the
// module is still building waits behind it rather than racing it.
let chain = built;
self.onmessage = function (ev) {
	const m = ev.data;
	chain = chain.then(function () { return run(m); });
};
