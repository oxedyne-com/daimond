/* ============================================================
   Daimond — in-page delivery check (DaimondVerify)
   ------------------------------------------------------------
   "The code your browser is running is the published source."
   This lets a user check that from inside the running app.

   Be honest about what a page can and cannot prove about itself:
   a tampered server could serve a tampered checker, so a page
   verifying itself is a convenience, not a proof. Its ONE
   genuinely load-bearing check is against something this server
   does NOT control — the transparency log published in the
   public repo, fetched from a different origin. If the bundle
   this server served is not a sealed entry in that public,
   hash-chained history, something is wrong however green the
   rest looks.

   The trustworthy verdict is `verify/check.mjs`, run from the
   source you cloned, or the browser extension — neither of which
   this server can touch. This module says so, every time.

   Exposes `window.DaimondVerify`. Depends on nothing.
   ============================================================ */
(function () {
	'use strict';

	// The transparency log in the PUBLIC repo, on an origin this server does not
	// control. Overridable with <meta name="daimond-log" content="..."> so a fork
	// or a mirror can point at its own. The default is the canonical repo.
	var META = document.querySelector('meta[name="daimond-log"]');
	var LOG_URL = (META && META.content)
		|| 'https://raw.githubusercontent.com/oxedyne-com/daimond/main/verify/transparency.jsonl';
	var GENESIS_PREV = '0'.repeat(64);

	// ── The canonical fingerprint, byte-identical to verify/lib.mjs ─────
	function hex(buf) {
		var v = new Uint8Array(buf), s = '';
		for (var i = 0; i < v.length; i++) s += v[i].toString(16).padStart(2, '0');
		return s;
	}
	async function sha256(bytes) {
		return hex(await crypto.subtle.digest('SHA-256', bytes));
	}
	async function sha256str(str) {
		return sha256(new TextEncoder().encode(str));
	}
	function manifestText(files) {
		var rels = Object.keys(files).sort(), s = '';
		for (var i = 0; i < rels.length; i++) s += rels[i] + '\n' + files[rels[i]] + '\n';
		return s;
	}
	async function bundleHash(files) {
		return sha256str(manifestText(files));
	}
	async function entryHash(e) {
		return sha256str(e.seq + '|' + e.ts + '|' + e.build + '|' + e.bundle + '|' + e.prev);
	}
	async function verifyChain(entries) {
		var prev = GENESIS_PREV;
		for (var i = 0; i < entries.length; i++) {
			var e = entries[i];
			if (e.seq !== i)       return { ok: false, error: 'entry ' + i + ' out of order' };
			if (e.prev !== prev)   return { ok: false, error: 'entry ' + i + ' does not chain on ' + (i - 1) };
			if (e.entry !== await entryHash(e)) return { ok: false, error: 'entry ' + i + ' hash mismatch' };
			prev = e.entry;
		}
		return { ok: true, error: '' };
	}

	// ── The check ───────────────────────────────────────────────────────

	/// Verify this page against its manifest and the public transparency log.
	///
	/// `opts.files` (default true) also fetches and re-hashes every covered file;
	/// set false for the quick check (manifest self-consistency + chain
	/// membership only), which does not pull the whole bundle down again.
	/// `opts.onProgress(done, total)` is called as files are hashed.
	///
	/// Returns a verdict:
	///   { ok, build, bundle, checks: [{ name, ok, detail }], caveat }
	/// where `ok` is true only if every check that could run passed.
	async function check(opts) {
		opts = opts || {};
		var doFiles = opts.files !== false;
		var checks = [];
		var add = function (name, ok, detail) { checks.push({ name: name, ok: ok, detail: detail || '' }); };

		var manifest;
		try {
			manifest = await (await fetch('manifest.json', { cache: 'no-store' })).json();
		} catch (e) {
			add('manifest', false, 'this build was served without a manifest.json — it cannot be checked');
			return verdict(checks, null);
		}

		// 1. The manifest is internally consistent: its bundle hash is the hash of
		//    its own file list. (Weak on its own — the server wrote both — but a
		//    fast, necessary sanity gate.)
		var recomputed = await bundleHash(manifest.files);
		add('manifest self-consistent', recomputed === manifest.bundle,
			recomputed === manifest.bundle ? '' : 'the manifest bundle hash does not match its file list');

		// 2. THE one that matters: the served bundle is a sealed entry in the
		//    public, hash-chained log on an origin this server does not control.
		try {
			var text = await (await fetch(LOG_URL, { cache: 'no-store' })).text();
			var entries = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(JSON.parse);
			var chain = await verifyChain(entries);
			if (!chain.ok) {
				add('public transparency log', false, 'the public log is not an intact chain: ' + chain.error);
			} else {
				var sealed = entries.some(function (e) { return e.bundle === manifest.bundle; });
				add('sealed in the public log', sealed,
					sealed ? entries.length + ' releases on record'
						: 'this served bundle is NOT in the public history — it was never published');
			}
		} catch (e) {
			add('public transparency log', null,
				'could not reach the public log (offline, or blocked by policy) — run verify/check.mjs to be sure');
		}

		// 3. Optionally, every served file hashes to what the manifest says. This
		//    catches partial tampering and CDN drift, though a server that rewrote
		//    the files could rewrite the manifest to match — which is why (2) is
		//    the check that counts.
		if (doFiles) {
			var rels = Object.keys(manifest.files), bad = [], done = 0;
			for (var i = 0; i < rels.length; i++) {
				var rel = rels[i];
				try {
					var res = await fetch(rel, { cache: 'no-store' });
					var got = await sha256(new Uint8Array(await res.arrayBuffer()));
					if (got !== manifest.files[rel]) bad.push(rel);
				} catch (e) { bad.push(rel + ' (unreadable)'); }
				done++;
				if (opts.onProgress) try { opts.onProgress(done, rels.length); } catch (e) {}
			}
			add('every served file matches the manifest', bad.length === 0,
				bad.length ? bad.length + ' differ: ' + bad.slice(0, 8).join(', ') : rels.length + ' files');
		}

		return verdict(checks, manifest);
	}

	function verdict(checks, manifest) {
		// A null result (could-not-check) does not fail the verdict, but it does
		// stop it being a clean pass: the answer is "unproven", not "fine".
		var anyFail = checks.some(function (c) { return c.ok === false; });
		var anyUnknown = checks.some(function (c) { return c.ok === null; });
		return {
			ok:     !anyFail && !anyUnknown,
			failed: anyFail,
			build:  manifest ? manifest.build : '',
			bundle: manifest ? manifest.bundle : '',
			checks: checks,
			caveat: 'A page cannot fully vouch for itself: a tampered server could tamper with this '
				+ 'very check. For an independent verdict, build the public source and run '
				+ 'verify/check.mjs, or use the delivery-verify browser extension — neither of which '
				+ 'this server can touch.',
		};
	}

	window.DaimondVerify = { check: check, LOG_URL: LOG_URL };
})();
