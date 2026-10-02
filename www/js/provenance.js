/* ============================================================
   Daimond — product provenance (DaimondProvenance)
   ------------------------------------------------------------
   Every product a model makes -- an answer, a file row, a fold,
   a worker's report, a mail draft, a Pending proposal -- carries
   one `prod` record, stamped by the device that made it at the
   moment it was made, and never rewritten. The transcript union
   is first-copy-wins by mid, so a field added later would never
   reach a device that already holds the message.

   Design: ~/usr/code/ai/claude/specs/
   daimond_product_rating_design_20260924.md, §3; U1 of §11.

   `prod` holds only what is known when the turn STARTS, because
   the streamed provisional copy and the final copy of an answer
   must carry byte-identical records (§3.5). What is known only
   when it settles -- the tool path and the length -- is derived
   when a rating is made, by `toolPath` and `lenOf` below.

   The handle grammar is the one `src/rating.rs` parses; its
   tests and these hold the same strings.

   Pure: no DOM, no storage. Attaches `window.DaimondProvenance`.
   ============================================================ */
(function () {
	'use strict';

	var V = 'p1';

	// ── Handles ────────────────────────────────────────────────
	// A chat, store or Diamond id never holds a `/`; what follows
	// the first `/` (a mid, a path, a version) belongs to the item.
	var h = {
		answer:   function (chat, mid)     { return V + ':answer:' + chat + '/' + mid; },
		file:     function (store, v, path) { return V + ':file:' + store + '/v' + v + '/' + path; },
		crystal:  function (diamond, v)    { return V + ':crystal:' + diamond + '/v' + v; },
		fold:     function (chat, mid)     { return V + ':crystal:' + chat + '/' + mid; },
		worker:   function (run)           { return V + ':worker:' + run; },
		mail:     function (draft)         { return V + ':mail:' + draft; },
		proposal: function (pending)       { return V + ':proposal:' + pending; },
	};

	// ── The record ─────────────────────────────────────────────
	// Which model, by the catalogue: pricing.js `identify`, which
	// files by `resolveExact` alone. Without the catalogue the
	// model's own string stands, and says it is unknown.
	function identify(model) {
		var P = (typeof window !== 'undefined') && window.DaimondPricing;
		if (P && typeof P.identify === 'function') {
			try { return P.identify(model); } catch (e) { /* fall through */ }
		}
		return { cm: String(model || ''), fam: '', fi: 1, cls: 'unknown' };
	}

	/// The `prod` record for one product. Keys are written in one
	/// order, every one of them always, and every string is a string,
	/// so two calls on the same facts serialise to the same bytes --
	/// the property a streamed copy and its final copy are compared on.
	///
	/// EVERY FIELD, ALWAYS: the sync contract's record type is exact,
	/// with no optional field (`dev/SYNC_CONTRACT.md` §3.2, the `Prod`
	/// declaration in the U1 fix brief). `fi` is false where the
	/// family is the catalogue's; `hash` and `run` are '' where the
	/// product is not a file row.
	///
	/// `o`: { h, k, m (the model as sent), pv, role, sp, d, c, t,
	/// dev, at }, and for a file row `hash` (the content rated),
	/// `run` (the worker that wrote it) and `via`.
	///
	/// `via` (Prod v2, last): 'command' where the row was found by a
	/// command or helper window around a call and credited to the agent
	/// that ran it, '' for everything else -- an answer, a fold, a mail
	/// row, a proposal, and a file a file tool wrote. Anything but
	/// 'command' is written as ''.
	function stamp(o) {
		o = o || {};
		var id = identify(o.m);
		return {
			h:    String(o.h || ''),
			k:    String(o.k || ''),
			m:    String(o.m || ''),
			pv:   String(o.pv || ''),
			cm:   String(id.cm || ''),
			fam:  String(id.fam || ''),
			fi:   !!id.fi,			// the family is a guess from the name
			cls:  String(id.cls || 'unknown'),
			role: String(o.role || ''),
			sp:   String(o.sp || ''),
			d:    String(o.d || ''),
			c:    String(o.c || ''),
			t:    String(o.t || ''),
			dev:  String(o.dev || ''),
			at:   Math.floor(Number(o.at) || 0),
			hash: String(o.hash || ''),
			run:  String(o.run || ''),
			via:  o.via === 'command' ? 'command' : '',
		};
	}

	/// A message's records. A message's `prod` is ALWAYS a list -- one
	/// record for an answer, a fold, a mail row or a proposal, one per
	/// row for a changed-files note or a relay -- because the contract
	/// has no union type (`SetOf(Prod)`). Empty for a message that is
	/// no product, which is also what a message from before U1 reads as.
	function of(m) {
		return (m && Array.isArray(m.prod)) ? m.prod.filter(isProd) : [];
	}

	/// The same provenance as another product: a Pending proposal
	/// is the daimon answer it came from, filed under its own handle.
	function rekind(prod, k, handle) {
		if (!prod || typeof prod !== 'object') return null;
		var out = {};
		Object.keys(prod).forEach(function (key) { out[key] = prod[key]; });
		out.h = String(handle || '');
		out.k = String(k || '');
		return out;
	}

	/// A file's path as the reader sees it: from its Diamond's root (`id`), or from its chat's work
	/// folder (`chat:<id>`), so the app's own id is not shown. A path outside that root, or with
	/// nothing after the prefix, is returned whole.
	function rel(path, id) {
		var p = String(path || ''), k = String(id || '');
		var pre = k.indexOf('chat:') === 0 ? 'chats/' + k.slice(5) + '/work/' : 'diamonds/' + k + '/';
		return k && k !== 'chat:' && p.length > pre.length && p.indexOf(pre) === 0 ? p.slice(pre.length) : p;
	}

	/// Is this a product record this build can read?
	function isProd(p) {
		return !!(p && typeof p === 'object' && typeof p.h === 'string'
			&& p.h.indexOf(V + ':') === 0 && typeof p.k === 'string' && p.k);
	}

	// ── Derived when a rating is made ──────────────────────────

	/// The tool path of the answer `answerMid` to the user message
	/// `turnMid`: the `tool_log` names between the two, in call
	/// order, runs of one tool collapsed to one. Without an answer
	/// mid it runs to the end of the transcript.
	function toolPath(messages, turnMid, answerMid) {
		var out = [], on = false;
		var msgs = messages || [];
		for (var i = 0; i < msgs.length; i++) {
			var m = msgs[i];
			if (!m) continue;
			if (!on) {
				if (m.role === 'user' && String(m.mid) === String(turnMid)) on = true;
				continue;
			}
			if (answerMid != null) {
				if (String(m.mid) === String(answerMid)) break;
			} else if (m.role === 'user') {
				break;						// the next turn
			}
			if (m.role === 'tool_log' && m.name && out[out.length - 1] !== m.name) out.push(String(m.name));
		}
		return out;
	}

	/// Characters of a product's text, counted as a reader counts them
	/// (code points, not UTF-16 halves).
	function lenOf(content) {
		return Array.from(String(content == null ? '' : content)).length;
	}

	window.DaimondProvenance = {
		h:        h,
		stamp:    stamp,
		of:       of,
		rekind:   rekind,
		isProd:   isProd,
		rel:      rel,
		toolPath: toolPath,
		lenOf:    lenOf,
	};
})();
