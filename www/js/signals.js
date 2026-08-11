/* ============================================================
   Daimond — the signal index (DaimondSignals)
   ============================================================

   What the Optimiser reads. A continuously-maintained local index
   of how this account actually works, kept as counters and rolling
   windows rather than as a pile of transcripts to be re-read.

   The order matters and is the whole design: index first, findings
   second, a model last and only on what the index flagged. Steps
   one to three of that need no model at all, so they are free,
   instant, and nothing leaves the device.

   ── The signal nobody instruments ──────────────────────────

   The user's own reaction is the only ground truth an agent app
   has about whether a turn was any good, and it arrives constantly,
   unprompted, for nothing. A message that swears, shouts, repeats an
   instruction, or collapses to three cross words is a NEGATIVE LABEL
   on the assistant turn before it. Aggregate those labels by model,
   by tool, by context length, by Diamond, and you can answer
   questions nobody currently can: which model irritates this person,
   which tool wastes their time, when a thread should have folded.

   Detection is cheap. Rate of strong language, capitals, runs of
   `?!`, correction phrases, and a message far shorter than this
   person's own norm -- counted here, against THIS user's baseline,
   never sent anywhere.

   ── The rule this module is written around ─────────────────

   **The detection channel is not the presentation channel.**

   This module may read irritation. Nothing built on it may ever
   MENTION it. "You seem frustrated" is the fastest possible way to
   get an Optimiser deleted, and it is also useless: the reader knows.
   What surfaces is the defect the irritation pointed AT --
   "six requests to open a page opened a browser window instead" --
   with the affect used only to find it and then dropped.
   `digest()` is written to that rule and `verify_signals` asserts it.

   So: no score, no gauge, no mood. If a number here ever reaches a
   surface a person reads, this module has been misused.

   ── What is stored, and where ──────────────────────────────

   Counters in `localStorage` under `daimond-signals`, per-account
   like every other `daimond-*` key. NO MESSAGE TEXT is kept -- a
   message is scored, the counters move, and the text is dropped. The
   index cannot leak what it does not hold.

   A digest is written into the workspace at `system/usage/digest.md`,
   where the Optimiser reads it with the file tools it already has.
   That is the answer to notes2 #51: the Optimiser cannot be given a
   SCOPE over the ledger or over chats, because neither is a folder --
   so what it needs is put into a folder instead.

   Attaches a single global, `window.DaimondSignals`. Also exported
   for Node, so the scoring can be tested without a browser.
   ============================================================ */
(function () {
	'use strict';

	var KEY = 'daimond-signals';
	var DAY_MS = 24 * 60 * 60 * 1000;
	var RETAIN_DAYS = 60;
	// A run of days kept for rates; enough to see a change of habit and not so
	// much that the record becomes a history of the user's year.
	var MAX_DAYS = RETAIN_DAYS;

	// ── Scoring ────────────────────────────────────────────────
	//
	// Composite, and deliberately not a word list alone: some people swear
	// cheerfully in every message and some never do, so a raw count says more
	// about the person than about the turn. What is measured is a DEPARTURE
	// from this user's own norm, and strong language is one of five inputs.

	// Kept short and unambiguous. A longer list buys nothing -- this is one
	// input among five and the composite carries the decision.
	var STRONG = /\b(fuck\w*|shit\w*|bloody|bollocks|christ|wtf|damn\w*)\b/i;
	// What a person writes when the last answer missed: they say so.
	var CORRECTION = /\b(no,? i (said|asked|told)|that('s| is) not what|as i (already )?(said|told)|why would you|i already|again[,.!?]|still (wrong|broken|not))\b/i;
	// A run of marks is shouting in punctuation.
	var RUNS = /[!?]{2,}/;

	/// Score one user message for the signs that the turn before it missed.
	///
	/// Returns the count of independent signals present, 0 to 5. Nothing here
	/// is a judgement about the person: each is a way of saying "that was not
	/// it" and the count is only how many of them arrived at once.
	///
	/// # Arguments
	/// * `text` - What the user typed.
	/// * `norm` - Their usual message length, for the terseness signal.
	function score(text, norm) {
		var s = String(text == null ? '' : text);
		var trimmed = s.trim();
		if (!trimmed) return 0;
		var n = 0;
		if (STRONG.test(trimmed)) n++;
		if (CORRECTION.test(trimmed)) n++;
		if (RUNS.test(trimmed)) n++;
		// Capitals, but only where there is enough text for it to be a choice.
		// A three-letter "NO" is caught by terseness below.
		var letters = trimmed.replace(/[^A-Za-z]/g, '');
		if (letters.length >= 12) {
			var caps = trimmed.replace(/[^A-Z]/g, '').length;
			if (caps / letters.length > 0.6) n++;
		}
		// Terseness, against this user's own norm rather than a fixed number:
		// somebody whose messages run to a paragraph saying "no" is a signal;
		// somebody who always writes six words is not.
		if (norm && norm >= 40 && trimmed.length <= Math.min(20, norm * 0.15)) n++;
		return n;
	}

	/// Two or more independent signals. One alone is noise -- a person may
	/// swear at the weather, or write "again." meaning "once more please".
	function missed(text, norm) { return score(text, norm) >= 2; }

	// ── The index ──────────────────────────────────────────────

	function blank() {
		return {
			v: 1,
			// Rolling message-length mean, so terseness has a baseline. Kept as
			// a sum and a count rather than as a mean, so it can be widened
			// without rescaling anything.
			len: { sum: 0, n: 0 },
			// Per Diamond: turns, spend, the last time it was worked, how many
			// turns were followed by a sign that they missed, and which tools
			// were called and how many refused.
			diamonds: {},
			// Per model, the same question: does this one miss more often?
			models: {},
			// Per tool name: calls, failures, and misses that FOLLOWED a turn
			// that used it. The last is the one nothing else can see.
			tools: {},
			// Per day: turns and misses, so a change of habit is visible as a
			// change rather than as a total.
			days: {},
			// Intents seen more than once, as HASHES of the normalised text --
			// never the text. Enough to say "you have asked for this eleven
			// times", never enough to reconstruct what was asked.
			intents: {},
		};
	}

	function load() {
		try {
			var raw = localStorage.getItem(KEY);
			if (!raw) return blank();
			var o = JSON.parse(raw);
			return (o && o.v === 1) ? o : blank();
		} catch (e) { return blank(); }
	}
	function save(ix) {
		try { localStorage.setItem(KEY, JSON.stringify(ix)); }
		catch (e) { /* full or private: the index is best-effort by design */ }
	}
	function day(ts) { return new Date(ts || Date.now()).toISOString().slice(0, 10); }

	function bump(map, key, field, by) {
		if (!key) return;
		var row = map[key] || (map[key] = {});
		row[field] = (row[field] || 0) + (by == null ? 1 : by);
	}

	/// A stable, non-reversible handle for an intent.
	///
	/// The text is lowercased, stripped of punctuation and of the twenty
	/// commonest English filler words, then hashed. Two ways of asking the same
	/// thing land together often enough to be useful, and the hash means the
	/// index can say "eleven times" while holding none of the eleven.
	var FILLER = /\b(the|a|an|and|or|of|to|in|is|it|for|on|with|that|this|please|can|you|i|me|my)\b/g;
	function intentHash(text) {
		var s = String(text || '').toLowerCase()
			.replace(/[^a-z0-9\s]/g, ' ')
			.replace(FILLER, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		if (s.length < 12) return '';       // too short to mean anything twice
		var h = 5381;
		for (var i = 0; i < s.length; i++) { h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; }
		return h.toString(36);
	}

	/// Note that the user said something to a Diamond.
	///
	/// This is where the label is made: the message is scored, the counters for
	/// whatever ran BEFORE it move, and the text is dropped.
	///
	/// # Arguments
	/// * `ev` - `{ diamondId, text, prevModel, prevTools }`, where the two
	///   `prev` fields describe the turn this message is reacting to.
	function noteUserMessage(ev) {
		ev = ev || {};
		var ix = load();
		var text = String(ev.text || '');
		var norm = ix.len.n ? (ix.len.sum / ix.len.n) : 0;
		var bad = missed(text, norm);

		ix.len.sum += text.trim().length;
		ix.len.n += 1;

		var d = day();
		var dayRow = ix.days[d] || (ix.days[d] = { turns: 0, missed: 0 });
		dayRow.turns++;
		if (bad) dayRow.missed++;

		if (bad) {
			bump(ix.diamonds, ev.diamondId, 'missed');
			bump(ix.models, ev.prevModel, 'missed');
			(ev.prevTools || []).forEach(function (name) {
				bump(ix.tools, name, 'missedAfter');
			});
		}

		// A repeated ask is a missing skill or a missing line in a crystal.
		var h = intentHash(text);
		if (h) {
			var row = ix.intents[h] || (ix.intents[h] = { n: 0, words: 0, last: 0 });
			row.n++;
			row.words = Math.min(12, text.trim().split(/\s+/).length);
			row.last = Date.now();
		}

		prune(ix);
		save(ix);
		return bad;
	}

	/// Note a completed turn: what it cost, what it ran on, what it called.
	function noteTurn(ev) {
		ev = ev || {};
		var ix = load();
		bump(ix.diamonds, ev.diamondId, 'turns');
		bump(ix.diamonds, ev.diamondId, 'usd', ev.usd || 0);
		if (ev.diamondId) {
			var row = ix.diamonds[ev.diamondId];
			row.last = Math.max(row.last || 0, ev.ts || Date.now());
		}
		bump(ix.models, ev.model, 'turns');
		bump(ix.models, ev.model, 'usd', ev.usd || 0);
		save(ix);
	}

	/// Note one tool call and whether it refused.
	function noteTool(name, ok) {
		if (!name) return;
		var ix = load();
		bump(ix.tools, name, 'calls');
		if (!ok) bump(ix.tools, name, 'failed');
		save(ix);
	}

	/// Drop what is older than the retention window, and the intents that never
	/// came back. An index that only grows becomes a history rather than a
	/// picture of how things are now.
	function prune(ix) {
		var days = Object.keys(ix.days).sort();
		while (days.length > MAX_DAYS) { delete ix.days[days.shift()]; }
		var cutoff = Date.now() - RETAIN_DAYS * DAY_MS;
		Object.keys(ix.intents).forEach(function (h) {
			var r = ix.intents[h];
			if (r.n < 2 && r.last < cutoff) delete ix.intents[h];
		});
		return ix;
	}

	// ── Findings ───────────────────────────────────────────────
	//
	// Each is a defect with a number behind it and something the reader could
	// DO. A finding with no action is a complaint, and a finding without its
	// evidence is astrology, so each carries both.
	//
	// None of them mentions the affect signal. Where irritation is what found
	// the thing, the finding names the thing.

	/// What the index can say without a model, given the Diamonds it is handed.
	///
	/// # Arguments
	/// * `diamonds` - `[{ id, name }]`, so a finding can name a Diamond rather
	///   than an id nobody recognises.
	/// * `now` - Milliseconds, injectable so this is testable.
	function findings(diamonds, now) {
		var ix = load();
		now = now || Date.now();
		var byId = {};
		(diamonds || []).forEach(function (d) { byId[d.id] = d.name || d.id; });
		var out = [];

		// A tool that refuses often is a broken tool, whatever the user thinks
		// they did wrong.
		Object.keys(ix.tools).forEach(function (name) {
			var r = ix.tools[name];
			if ((r.calls || 0) >= 5 && (r.failed || 0) / r.calls > 0.25) {
				out.push({
					kind: 'tool-failing',
					what: name + ' refused ' + r.failed + ' of ' + r.calls + ' calls.',
					do_: 'Look at what it is being asked for before asking it again.',
				});
			}
			// The one nothing else can see: the tool whose turns keep being
			// followed by the user saying it missed.
			if ((r.calls || 0) >= 5 && (r.missedAfter || 0) >= 3) {
				out.push({
					kind: 'tool-misses',
					what: r.missedAfter + ' of your turns using ' + name
						+ ' needed correcting afterwards.',
					do_: 'It answers, but with the wrong thing. Check what it returns.',
				});
			}
		});

		// A model that costs more and lands less often.
		Object.keys(ix.models).forEach(function (m) {
			var r = ix.models[m];
			if ((r.turns || 0) >= 10 && (r.missed || 0) / r.turns > 0.3) {
				out.push({
					kind: 'model-misses',
					what: Math.round(100 * r.missed / r.turns) + '% of turns on ' + m
						+ ' needed correcting (' + r.missed + ' of ' + r.turns + ').',
					do_: 'Try a different model on whatever uses this one most.',
				});
			}
		});

		// Dormant, and costing nothing but sitting in the way.
		Object.keys(ix.diamonds).forEach(function (id) {
			var r = ix.diamonds[id];
			var idle = r.last ? (now - r.last) / DAY_MS : null;
			if (idle !== null && idle > 45 && (r.turns || 0) > 0) {
				out.push({
					kind: 'dormant',
					what: (byId[id] || id) + ' has not been worked for '
						+ Math.round(idle) + ' days.',
					do_: 'Fold it into another Diamond, or delete it.',
				});
			}
		});

		// The repeated ask: a missing skill, or a line missing from a crystal.
		Object.keys(ix.intents).forEach(function (h) {
			var r = ix.intents[h];
			if ((r.n || 0) >= 5) {
				out.push({
					kind: 'repeated',
					what: 'You have asked for the same thing ' + r.n + ' times.',
					do_: 'Put it in the crystal, or make it a skill.',
				});
			}
		});

		return out;
	}

	/// The digest the Optimiser reads, as markdown.
	///
	/// Written to be read by a model AND by a person, because the same file is
	/// the evidence behind anything the Optimiser proposes. It states what it
	/// does not know: an index that reports only what it has looks complete.
	function digest(diamonds, now) {
		var ix = load();
		now = now || Date.now();
		var L = [];
		L.push('# How this account is being used');
		L.push('');
		L.push('Counted on this device. No message text is kept and none of this has');
		L.push('been sent anywhere. Numbers are from the last ' + RETAIN_DAYS + ' days.');
		L.push('');

		var byId = {};
		(diamonds || []).forEach(function (d) { byId[d.id] = d.name || d.id; });

		L.push('## Diamonds');
		L.push('');
		var ids = Object.keys(ix.diamonds);
		if (!ids.length) {
			L.push('Nothing recorded yet.');
		} else {
			L.push('| Diamond | turns | spend (USD) | last worked |');
			L.push('|---|---|---|---|');
			ids.sort(function (a, b) {
				return (ix.diamonds[b].turns || 0) - (ix.diamonds[a].turns || 0);
			}).forEach(function (id) {
				var r = ix.diamonds[id];
				L.push('| ' + (byId[id] || id) + ' | ' + (r.turns || 0) + ' | '
					+ (r.usd || 0).toFixed(4) + ' | '
					+ (r.last ? Math.round((now - r.last) / DAY_MS) + 'd ago' : 'never') + ' |');
			});
		}
		L.push('');

		L.push('## Models');
		L.push('');
		var ms = Object.keys(ix.models);
		if (!ms.length) { L.push('Nothing recorded yet.'); }
		else {
			L.push('| Model | turns | spend (USD) |');
			L.push('|---|---|---|');
			ms.forEach(function (m) {
				var r = ix.models[m];
				L.push('| ' + m + ' | ' + (r.turns || 0) + ' | ' + (r.usd || 0).toFixed(4) + ' |');
			});
		}
		L.push('');

		L.push('## Tools');
		L.push('');
		var ts = Object.keys(ix.tools);
		if (!ts.length) { L.push('Nothing recorded yet.'); }
		else {
			L.push('| Tool | calls | refused |');
			L.push('|---|---|---|');
			ts.forEach(function (n) {
				var r = ix.tools[n];
				L.push('| ' + n + ' | ' + (r.calls || 0) + ' | ' + (r.failed || 0) + ' |');
			});
		}
		L.push('');

		L.push('## What stands out');
		L.push('');
		var f = findings(diamonds, now);
		if (!f.length) {
			// Silence is a valid week. An Optimiser that always finds three
			// things is inventing them.
			L.push('Nothing. This section is empty because nothing stood out.');
		} else {
			f.forEach(function (x) { L.push('- **' + x.what + '** ' + x.do_); });
		}
		L.push('');
		L.push('## What this does not know');
		L.push('');
		L.push('- What any conversation was about. Only that turns happened.');
		L.push('- Whether a turn achieved anything, except where it had to be redone.');
		L.push('- Anything at all about work done on another device.');
		return L.join('\n');
	}

	function snapshot() { return load(); }
	function reset() { try { localStorage.removeItem(KEY); } catch (e) {} }

	var api = {
		// Scoring, exported so it can be tested and so nothing else re-implements it.
		score:            score,
		missed:           missed,
		intentHash:       intentHash,
		// Recording.
		noteUserMessage:  noteUserMessage,
		noteTurn:         noteTurn,
		noteTool:         noteTool,
		// Reading.
		findings:         findings,
		digest:           digest,
		snapshot:         snapshot,
		reset:            reset,
		RETAIN_DAYS:      RETAIN_DAYS,
	};

	if (typeof window !== 'undefined') window.DaimondSignals = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
