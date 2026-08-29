/* ============================================================
   Daimond — drafting from the whole list of notes (triage.js)
   ------------------------------------------------------------
   ONE VERB WHOSE OBJECT IS THE WHOLE LIST. Every other control
   in the Notes view takes ONE note: Send, Copy, Delete. That is
   the defect this file exists to fix, and it was reported in the
   panel's own words:

       "I started using Social > Notes and had no choice but to
        repeatedly select 'Keep'. But what is the purpose of
        this? My intention was for a model to process such input
        and turn it into either a new proposal or a revision of
        an existing proposal. So such a model needs to work at
        the global level, and keeping the notes themselves is not
        really the goal."

   ── WHY ONE REPORT IS NOT ONE UNIT OF WORK ──────────────────

   `dev/IMPROVE_CONTRACT.md` §2 made a deliberate move called A
   NOTE IS A PROPOSAL NOW: the box opens a proposal directly,
   first line the title and the rest the body. It was made to kill
   a real failure -- `/api/note` answered 404 and the shipped
   proposals file was permanently empty, so the two halves of the
   feature never met -- and it is right about the wire. What it
   smuggles in is a false identity. A report is shaped like
   EXPERIENCE; work is shaped like CHANGE, and the map between
   them is many-to-many:

     - several people hit one fault: one proposal, several
       corroborations;
     - one note holds two faults: two proposals, because the
       guide already says one holding both "cannot be finished,
       since half of it is fixed and half is not";
     - a note that lands against an open proposal is a COMMENT;
     - a note showing a proposal's statement was wrong is a
       REVISION.

   The panel handled exactly the first line of the first case.
   This file is the step between the note and the forge, and it is
   the thing §5.6 of the contract conceded when it rejected
   daimon-written proposals AS THE MECHANISM -- "voting needs one
   shared list" -- and then wrote: "Worth building later on top of
   this." This is on top of it. The shared list is untouched: what
   a draft becomes is an ordinary proposal, opened at the ordinary
   door, voted on by everybody.

   ── THE ONE RULE SURVIVES, AND THIS IS THE ARGUMENT ─────────

   THE NEXT READER OF THIS FILE WILL ASSUME THE RULE IS BROKEN
   HERE AND DELETE THE FEATURE. It is not broken. §4 says:

       "A note leaves this device only when a person presses Send
        on that one note, and what leaves is exactly the
        characters that are on the screen at that moment."

   That constrains THE SENDER. It says nothing about the AUTHOR,
   and it cannot: the panel has never asked who wrote the
   characters in the box, only that a person read them and pressed
   the button beside them. A model-drafted proposal shown in a box
   and pressed is exactly as compliant as a hand-typed one -- the
   same one act, the same one press, the same reading of the same
   screen at the same moment. `send()` below reads the textarea's
   value at the instant of the press and cuts it, exactly as
   `improve.js`'s `outgoing()` and `split()` do, and it goes
   through THAT file's door rather than opening a second one.

   What DOES change, and is amended honestly in the contract
   rather than quietly, is two lines of §6: "No daimon
   involvement" and "Nothing in this panel costs money". Both were
   scoped to a build with no such feature. See §11 there.

   A NOTE IS STILL NEVER SENT BY THIS FILE. What leaves is a
   DRAFT: characters composed by a model, shown to a person, and
   pressed by them. The notes themselves stay on the device, and
   `improve.js`'s `fold()` marks them folded rather than sent for
   exactly that reason -- the forge holds the drafting, not the
   words, and where five notes went into one proposal it holds a
   fragment of each. A folded note is still the only copy of what
   somebody wrote and is never evicted to make room.

   ── AND NOTHING RUNS ON ITS OWN ─────────────────────────────

   One press to draft, a review, then one press per draft. No
   timer, no panel-open trigger, no "while you were away". The
   cost is said BEFORE the press and as a CEILING, because a
   figure a person reads after the money is gone is not consent.

   Attaches `window.DaimondTriage`.
   ============================================================ */
(function () {
	'use strict';

	// ── Saying things ──────────────────────────────────────────

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// A string with the English written at the call site as its fallback, on
	/// the same terms improve.js states: `t` answers with the KEY when the table
	/// has no entry, and every string this file adds is new.
	function tOr(k, fallback, v) {
		var s = t(k, v);
		if (s !== k) return s;
		if (!v) return fallback;
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, name) {
			return v[name] != null ? String(v[name]) : whole;
		});
	}

	function log(/* ...args */) {
		try { if (window.console && console.debug) console.debug.apply(console, ['[triage]'].concat([].slice.call(arguments))); }
		catch (e) { /* no console */ }
	}

	function el(id) { return document.getElementById(id); }

	function panel() { return window.DaimondImprove || null; }

	// ── What the drafting is given, and what it may answer ─────
	//
	// The prompt is HERE rather than in `src/prompts.rs` because it is not a
	// role: nobody dispatches a triage, it holds no tools, it reads no
	// workspace, and it lives exactly as long as one press. The three roles that
	// are in Rust -- daimon, worker, reducer -- are all things a user may
	// rewrite in `prompts/<role>.md`, and putting a fourth there would offer an
	// edit to a prompt whose output has a fixed shape this file then parses.

	/// How many drafts are worth drawing. A ceiling rather than a target: a plan
	/// nobody can read through is a plan nobody presses.
	var MAX_DRAFTS = 40;

	/// The output allowance, and therefore the ceiling in the cost line. Roughly
	/// forty drafts of a title, a short body and a sentence of reasoning.
	var OUT_MAX = 8000;

	/// Characters per token, for the estimate only. Deliberately pessimistic:
	/// a cost line that under-states is worse than one that over-states, because
	/// the second is a promise kept.
	var CHARS_PER_TOKEN = 3.5;

	/// The whole of what the drafting is told. Long, and every paragraph in it
	/// is a rule some plan broke.
	var SYSTEM = [
		'You are triaging one person\'s notes about an application called Daimond into units of work.',
		'',
		'A NOTE is a report shaped like experience: where they were, what they expected, what happened.',
		'A PROPOSAL is one change, stated so it can be agreed with, disagreed with, and FINISHED.',
		'The map between them is many-to-many and all four of these happen:',
		'  - several notes describe one fault: ONE proposal, and the other notes corroborate it;',
		'  - one note holds two faults: TWO proposals, because a proposal holding both cannot be',
		'    finished -- half of it ships and half does not;',
		'  - a note that lands against a proposal already open is a COMMENT on it;',
		'  - a note showing an open proposal\'s statement was wrong is a REVISION of it.',
		'',
		'Rules you are judged on:',
		'1. DO NOT MERGE TWO FAULTS BECAUSE THEY TOUCH THE SAME PANEL, the same word, or the same',
		'   feeling. Two notes about losing text are two faults unless one cause explains both.',
		'   When two proposals plausibly share a cause, keep them apart and say so in the body.',
		'2. DO NOT SPLIT ONE FAULT INTO ITS SYMPTOMS. One statement, one change, one finish.',
		'3. INVENT NOTHING. Every claim in a draft must be traceable to a note or to a proposal you',
		'   were shown. You have not read the code and must not write as though you had.',
		'4. USE THE REPORTER\'S OWN WORDS wherever they are already precise. You are re-aiming a',
		'   report at a maintainer, not rewriting it.',
		'5. A title is ONE LINE and names the change, not the feeling. "Prompts to a second daimon',
		'   are queued behind the first" -- not "Queueing problem".',
		'6. A REVISION restates the whole proposal, title and body, as it should now read.',
		'7. Every note must appear in at least one draft\'s `from`, or in `left` with a reason.',
		'   A note holding two faults appears in two, which is the whole of rule 2\'s exception.',
		'8. ORDER THE DRAFTS WITH THE MOST SERIOUS FIRST -- lost work, then wrong behaviour, then',
		'   missing behaviour, then wording and documentation. A plan of twenty in the order the',
		'   notes happened to be written is a plan nobody reads to the end of.',
		'',
		'Answer with ONE JSON object and nothing else -- no prose around it, no code fence:',
		'{',
		'  "drafts": [',
		'    { "kind": "new",      "title": "...", "body": "...", "from": ["<note id>", ...], "why": "..." },',
		'    { "kind": "comment",  "n": 12, "body": "...", "from": ["<note id>"], "why": "..." },',
		'    { "kind": "revision", "n": 12, "title": "...", "body": "...", "from": ["<note id>"], "why": "..." }',
		'  ],',
		'  "left": [ { "id": "<note id>", "why": "..." } ]',
		'}',
		'',
		'`why` is one sentence to the person who wrote the notes, saying why this draft is one unit',
		'of work and not two, or why it belongs on a proposal that already exists.',
	].join('\n');

	/// One note, as the drafting reads it. The id goes FIRST and verbatim,
	/// because it is what every draft is aimed with and a model that paraphrases
	/// it produces a plan that folds nothing.
	function sayNote(rec) {
		return 'id ' + rec.id + '\n' + rec.text;
	}

	/// One proposal, as the drafting reads it. The number first, for the same
	/// reason -- and the state, because a note landing against a DONE proposal
	/// is a new proposal and not a comment on a finished one.
	function sayProp(p) {
		var out = '#' + p.n + ' [' + p.state + '] ' + (p.title || '(no title)');
		if (p.body) out += '\n' + p.body;
		return out;
	}

	/// Everything the drafting is given, as the two messages it is given it in.
	///
	/// PURE, and published, so a verifier can assert that all eighteen notes and
	/// the whole proposal list actually reached the model rather than inferring
	/// it from a plan that mentions them. A brief that quietly dropped the
	/// oldest half would still produce a plausible plan.
	function brief(notes, props) {
		var parts = [];
		parts.push('THE NOTES ON THIS DEVICE (' + notes.length + '), oldest first.');
		parts.push('');
		// Oldest first: the person wrote them in that order and the later ones
		// lean on the earlier ones. The panel draws them newest first because
		// that is how somebody reads their own writing back.
		notes.slice().sort(function (a, b) { return a.at - b.at; })
			.forEach(function (rec) { parts.push(sayNote(rec)); parts.push(''); });
		parts.push('THE PROPOSALS ALREADY ON THE FORGE (' + props.length + '), newest first.');
		parts.push('');
		if (!props.length) {
			parts.push('There are none. Every draft is therefore a new proposal; there is nothing '
				+ 'to comment on and nothing to revise.');
		} else {
			props.forEach(function (p) { parts.push(sayProp(p)); parts.push(''); });
		}
		parts.push('Triage these notes now.');
		return { system: SYSTEM, user: parts.join('\n') };
	}

	// ── What it will cost, said before it runs ─────────────────
	//
	// A CEILING, not a guess. The input is known exactly; the output is bounded
	// by `OUT_MAX`, which is what the client is built with, so the figure is one
	// the run cannot exceed. A cost line that under-states is worse than none:
	// the person who reads it has already decided by the time it is wrong.

	/// Which model this would run on: the user's own default, on their own key.
	/// Null when nothing is configured, which is a reason not to offer the
	/// control at all rather than a reason to offer one that fails.
	function pick() {
		try {
			if (!window.DaimondModels) return null;
			return DaimondModels.resolve('', '');
		} catch (e) { return null; }
	}

	/// What one run would cost at most, in the user's own money.
	///
	/// `known` is false when nothing prices the model. The line then says the
	/// token counts and says the price is not known, which is true, rather than
	/// showing a fallback rate as though it were the model's.
	function estimate(notes, props) {
		var got = pick();
		var b   = brief(notes, props || []);
		var inTok = Math.ceil((b.system.length + b.user.length) / CHARS_PER_TOKEN);
		var out   = { model: got ? got.model : '', provider: got ? got.provider : '',
			inTok: inTok, outTok: OUT_MAX, usd: 0, known: false };
		if (!got) return out;
		try {
			var r = DaimondPricing.rate(got.model, got.provider);
			if (!r) return out;
			var p = DaimondPricing.priceFor(got.model, inTok, OUT_MAX, 0, got.provider);
			out.usd   = p ? p.usd : 0;
			out.known = !!p;
		} catch (e) { /* nothing prices it; the line says so */ }
		return out;
	}

	/// The cost line, in the characters the person reads before pressing.
	///
	/// EVERY BRANCH CARRIES A QUANTITY AND THE SAME PROMISE. An unpriced model is
	/// a reason not to name a figure in money; it is not a reason to say nothing
	/// measurable, so the token counts stand in -- they are exact, where a
	/// fallback rate drawn as though it were the model's own would not be. And
	/// the sentence about nothing leaving until a press is in both branches,
	/// because it is a promise about the feature and not a fact about the price.
	function costLine(est, n) {
		if (!est.model) {
			return tOr('social.triage_nomodel',
				'Set a model in AI before drafting from your notes.');
		}
		var stop = ' ' + tOr('social.triage_cost_stop',
			'Nothing is sent until you Send a draft.');
		if (!est.known) {
			return tOr('social.triage_cost_unknown',
				'All {n} notes on {model}, your key: ~{in} tokens in, up to {out} out. '
				+ 'This model is not priced, so the cost is not known first.',
				{ n: n, model: est.model, in: est.inTok, out: est.outTok }) + stop;
		}
		return tOr('social.triage_cost',
			'All {n} notes on {model}, your key: ~{in} tokens in, up to {out} out — at most {usd}.',
			{ n: n, model: est.model, in: est.inTok, out: est.outTok, usd: money(est.usd) }) + stop;
	}

	/// A price a person can read. Small figures keep their digits: rounding
	/// $0.004 to "$0.00" would say the run is free.
	function money(usd) {
		var v = Math.max(0, Number(usd) || 0);
		if (v >= 1)    return '$' + v.toFixed(2);
		if (v >= 0.01) return '$' + v.toFixed(3);
		return '$' + v.toFixed(4);
	}

	// ── Reading the answer ─────────────────────────────────────

	var KINDS = { 'new': 1, comment: 1, revision: 1 };

	/// The plan the drafting answered, defended against whatever came back.
	///
	/// A model asked for one JSON object commonly wraps it in a fence or a
	/// sentence, and the run has already been paid for by the time this is
	/// called, so the parse takes the outermost braces rather than refusing.
	/// What it will NOT do is repair the shape: a draft with no kind this build
	/// knows, or a comment with no proposal number, is dropped, and the count of
	/// what was dropped is shown -- because a plan quietly one draft short is a
	/// note quietly lost.
	function parse(text) {
		var raw = String(text || '');
		var i = raw.indexOf('{'), j = raw.lastIndexOf('}');
		if (i === -1 || j <= i) return { drafts: [], left: [], dropped: 0, err: 'shape' };
		var obj = null;
		try { obj = JSON.parse(raw.slice(i, j + 1)); }
		catch (e) { return { drafts: [], left: [], dropped: 0, err: 'shape' }; }
		if (!obj || typeof obj !== 'object') return { drafts: [], left: [], dropped: 0, err: 'shape' };

		var drafts = [], dropped = 0;
		(Array.isArray(obj.drafts) ? obj.drafts : []).forEach(function (d) {
			if (drafts.length >= MAX_DRAFTS) { dropped++; return; }
			var got = cleanDraft(d);
			if (got) drafts.push(got); else dropped++;
		});
		var left = [];
		(Array.isArray(obj.left) ? obj.left : []).forEach(function (l) {
			if (!l || typeof l !== 'object') return;
			var id = (typeof l.id === 'string') ? l.id : '';
			if (!id) return;
			left.push({ id: id, why: (typeof l.why === 'string') ? l.why.slice(0, 400) : '' });
		});
		return { drafts: drafts, left: left, dropped: dropped, err: '' };
	}

	/// One draft, or null. Every field is taken by type and length; nothing here
	/// is drawn as markup and nothing is a URL.
	function cleanDraft(d) {
		if (!d || typeof d !== 'object') return null;
		var kind = (typeof d.kind === 'string') ? d.kind : '';
		if (!KINDS[kind]) return null;
		var n = (typeof d.n === 'number' && isFinite(d.n)) ? Math.floor(d.n) : 0;
		if ((kind === 'comment' || kind === 'revision') && n < 1) return null;
		var title = (typeof d.title === 'string') ? d.title.replace(/[\r\n]+/g, ' ').trim() : '';
		var body  = (typeof d.body  === 'string') ? d.body  : '';
		if (kind !== 'comment' && !title) return null;
		if (kind === 'comment' && !body.trim()) return null;
		var from = [];
		(Array.isArray(d.from) ? d.from : []).forEach(function (id) {
			if (typeof id === 'string' && id && from.indexOf(id) === -1 && from.length < 64) from.push(id);
		});
		return {
			kind:  kind,
			n:     n,
			title: title.slice(0, 300),
			body:  body.slice(0, 16000),
			from:  from,
			why:   (typeof d.why === 'string') ? d.why.slice(0, 400) : '',
			// Filled in when the forge takes it. `sent` is the proposal number a
			// press produced; `err` is the panel's own sentence about why it did
			// not go, drawn beside the draft and never retried.
			sent:  0,
			err:   '',
		};
	}

	// ── The run ────────────────────────────────────────────────

	var PKG = '../pkg/oxedyne_daimond.js';

	var _plan = null;			// the plan on screen, or null before a run
	var _busy = false;			// a run is in flight
	var _say  = '';				// one line under the control

	/// The client one run uses. TOOLS OFF, and that is not a tidiness measure:
	/// a drafting that could read the workspace would be a drafting whose answer
	/// depended on files nobody showed the user, and the whole consent argument
	/// here rests on the person having read everything that went in. The brief
	/// is the brief.
	async function client(got) {
		var mod = await import(PKG);
		return new mod.DaimondApp(got.baseUrl, got.apiKey, got.model, OUT_MAX, SYSTEM, false);
	}

	/// Draft a plan from every kept note and the public proposal list.
	///
	/// THE PROPOSALS ARE READ UNVOICED, which is why this works before anybody
	/// is enrolled: `improve.js` reads a public repository with no voice at all,
	/// deliberately, and this asks it to do exactly that rather than opening a
	/// second reader.
	async function run() {
		var p = panel();
		if (!p || _busy) return null;
		var got = pick();
		if (!got) { _say = costLine(estimate([], []), 0); draw(); return null; }

		_busy = true; _say = ''; _plan = null; draw();
		try {
			// The listing first, and a failure to read it is NOT a failure to
			// draft: a forge nobody can reach means every draft is a new proposal,
			// which is the honest plan for that situation rather than no plan.
			try { await p.forge.list(false); } catch (e) { log('the proposals would not read', e); }
			var notes = p.notes().filter(function (r) { return !r.sent; });
			var props = p.forge.props();
			if (!notes.length) {
				_say = tOr('social.triage_nonotes', 'There are no kept notes to draft from.');
				return null;
			}
			var b   = brief(notes, props);
			var app = await client(got);
			var text = '';
			await app.run_turn(b.user, function (ev) {
				if (ev && ev.type === 'text' && typeof ev.content === 'string') text += ev.content;
			});
			meter(app, got);
			var read = parse(text);
			if (read.err || !read.drafts.length) {
				_say = tOr('social.triage_unread',
					'The model did not return a readable plan. Nothing was sent; your notes are untouched.');
				return null;
			}
			_plan = { at: Date.now(), drafts: read.drafts, left: read.left, dropped: read.dropped,
				model: got.model };
			return _plan;
		} catch (e) {
			_say = tOr('social.triage_failed', 'The drafting did not finish: {why}',
				{ why: (e && e.message) ? String(e.message) : String(e) });
			return null;
		} finally {
			_busy = false;
			draw();
		}
	}

	/// Book what the run cost against the account's own ledger.
	///
	/// Through `DaimondLedger` and `DaimondGovernor` rather than through
	/// daimond.js's `recordSpend`, which is not published on any global -- the
	/// two calls here are the two that apply. A triage bills no Diamond (it is
	/// the account's own money and belongs to no conversation), so there is no
	/// `DaimondSignals.noteTurn` to make. Reported as a seam in
	/// `dev/IMPROVE_CONTRACT.md` §11: one exported line would be better than
	/// two calls kept in step by hand.
	function meter(app, got) {
		var pt = 0, ct = 0, ca = 0, usd = 0;
		try {
			pt  = app.prompt_tokens     || 0;
			ct  = app.completion_tokens || 0;
			ca  = app.cached_tokens     || 0;
			usd = app.cost_usd          || 0;
		} catch (e) { return; }
		if ((pt + ct) <= 0) return;
		var entry = null;
		try {
			if (window.DaimondLedger) {
				entry = DaimondLedger.record({ ts: Date.now(), model: got.model,
					promptTokens: pt, completionTokens: ct, cachedTokens: ca,
					costUsd: usd, provider: got.provider || '' });
			}
		} catch (e) { /* the ledger is best-effort; the drafting is not */ }
		try { if (entry && window.DaimondGovernor) DaimondGovernor.observe(entry); }
		catch (e) { /* likewise */ }
	}

	// ── One press per draft ────────────────────────────────────

	/// The characters in one draft's box, RIGHT NOW.
	///
	/// THE ONE FUNCTION THAT DECIDES WHAT LEAVES, and the twin of
	/// `improve.js`'s `outgoing()`. It reads the textarea and nothing else: not
	/// the record the model answered, not what was drawn a moment ago. A person
	/// who edited the box before pressing sends what they edited, which is the
	/// only reading of §4 that is true of a box somebody can type in.
	function boxed(i) {
		var box = document.querySelector('.trg-draft[data-draft="' + i + '"] .trg-box');
		return box ? String(box.value || '') : '';
	}

	/// A draft cut into the two fields a proposal is made of, by the same rule.
	/// A cut and never an addition: `title + '\n' + body` is what was on screen.
	function cut(text) {
		var i     = text.indexOf('\n');
		var title = (i < 0) ? text : text.slice(0, i);
		var body  = (i < 0) ? ''   : text.slice(i + 1);
		if (!title.trim()) return null;
		return { title: title, body: body };
	}

	/// Send one draft. One press, one publication, and no retry.
	///
	/// NO `build` FIELD. `improve.js` sends one because the box's own "What goes
	/// with it" row shows those same characters, and closing that row takes them
	/// off the wire. There is no such row here, and every note that went into the
	/// brief already carries its own build in its text -- so a `build` here would
	/// be a field the person could not see, which is exactly what §4's field-set
	/// check exists to make impossible.
	async function send(i) {
		var p = panel();
		if (!p || !_plan) return false;
		var d = _plan.drafts[i];
		if (!d || d.sent) return false;
		var text = boxed(i);
		if (!text.trim()) { d.err = tOr('social.nothing', 'Write something first.'); draw(); return false; }

		var a;
		if (d.kind === 'comment') {
			a = await p.forge.say(d.n, text);
		} else {
			var parts = cut(text);
			if (!parts) {
				d.err = tOr('social.no_title', 'First line is the title — write one, then what happened.');
				draw();
				return false;
			}
			a = (d.kind === 'revision') ? await p.forge.amend(d.n, parts) : await p.forge.open(parts);
		}
		if (!a || !a.ok) {
			d.err = p.forge.saying(a) + ' ' + tOr('social.triage_kept',
				'Nothing sent, nothing retried. Your notes are untouched.');
			draw();
			return false;
		}
		d.err  = '';
		// A comment and a revision land on the proposal they named; a new one on
		// whatever number the forge gave it. Read from the ANSWER, never assumed:
		// the answer is the detail shape of the record that changed.
		d.sent = Math.max(0, (a.data && typeof a.data.number === 'number') ? Math.floor(a.data.number) : 0)
			|| d.n;
		// Folded, which is not sent. `improve.js` decides what that means for
		// the cap; this file only says which notes and which proposal.
		try { p.fold(d.from, d.sent); } catch (e) { log('the notes would not be marked', e); }
		try { p.render(); } catch (e) { draw(); }
		return true;
	}

	/// Take one draft off the plan. Nothing is sent and no note is touched: a
	/// plan is a proposal about proposals, and refusing one of them is free.
	function drop(i) {
		if (!_plan || !_plan.drafts[i]) return false;
		_plan.drafts.splice(i, 1);
		draw();
		return true;
	}

	/// Forget the whole plan. The notes are where they were.
	function clear() { _plan = null; _say = ''; draw(); }

	// ── Drawing ────────────────────────────────────────────────
	//
	// Into `#improve-triage`, which sits between the note box and the list of
	// notes. Everything below is built here rather than in the markup, on the
	// same argument `drawVoice` makes in improve.js: the markup is another
	// lane's file and every part of this row is drawn from this one anyway.

	function button(cls, act, text, title) {
		var b = document.createElement('button');
		b.type = 'button';
		b.className = cls;
		if (act) b.dataset.act = act;
		b.textContent = text;
		if (title) b.title = title;
		return b;
	}

	function line(cls, text) {
		var s = document.createElement('div');
		s.className = cls;
		s.textContent = text;
		return s;
	}

	function hasVoice() {
		try { return !!(window.DaimondVoice && DaimondVoice.has()); } catch (e) { return false; }
	}

	function draw() {
		var host = el('improve-triage');
		if (!host) return;
		host.innerHTML = '';
		var p = panel();
		if (!p) return;
		var notes = p.notes().filter(function (r) { return !r.sent; });

		host.appendChild(drawControl(notes));
		if (_say) host.appendChild(line('rail-note trg-say', _say));
		if (_plan) host.appendChild(drawPlan(notes));
	}

	/// The one control, and the sentence that says what pressing it costs.
	function drawControl(notes) {
		var box = document.createElement('div');
		box.className = 'trg-row';
		var est = estimate(notes, panel() ? panel().forge.props() : []);

		box.appendChild(line('imp-as trg-cost', costLine(est, notes.length)));

		var acts = document.createElement('div');
		acts.className = 'imp-acts trg-acts';
		if (est.model && notes.length) {
			var b = button('imp-send trg-run', 'triage-run',
				_busy ? tOr('social.triage_running', 'Reading your notes…')
					: tOr('social.triage_run', 'Draft from all {n} notes', { n: notes.length }),
				tOr('social.triage_run_help',
					'Reads your kept notes and the forge, and drafts a plan. Nothing is sent until you Send a draft.'));
			if (_busy) b.disabled = true;
			acts.appendChild(b);
		}
		if (_plan) {
			acts.appendChild(button('imp-note-copy trg-clear', 'triage-clear',
				tOr('social.triage_clear', 'Forget this plan'),
				tOr('social.triage_clear_help', 'Clear the drafts. Nothing is sent.')));
		}
		box.appendChild(acts);
		return box;
	}

	/// The plan: one box per draft, each sent by its own press.
	function drawPlan(notes) {
		var wrap = document.createElement('div');
		wrap.className = 'trg-plan';
		var byId = {};
		notes.forEach(function (r) { byId[r.id] = r; });

		wrap.appendChild(line('imp-asat trg-asat', tOr('social.triage_plan',
			'{n} drafts from your notes, by {model}. Edit any, send the ones you want. '
			+ 'Nothing has left this device.',
			{ n: _plan.drafts.length, model: _plan.model })));

		if (_plan.dropped) {
			wrap.appendChild(line('rail-note trg-dropped', tOr('social.triage_dropped',
				'{n} more came back in a shape this panel could not read, and are not shown.',
				{ n: _plan.dropped })));
		}

		_plan.drafts.forEach(function (d, i) {
			wrap.appendChild(drawDraft(d, i, byId));
		});

		if (_plan.left.length) {
			var left = document.createElement('div');
			left.className = 'trg-left';
			left.appendChild(line('imp-as', tOr('social.triage_left',
				'{n} notes are in no draft:', { n: _plan.left.length })));
			_plan.left.forEach(function (l) {
				var rec = byId[l.id];
				left.appendChild(line('rail-note trg-left-one',
					(rec ? firstLine(rec.text) : l.id) + (l.why ? ' — ' + l.why : '')));
			});
			wrap.appendChild(left);
		}
		return wrap;
	}

	/// The first line of a note, for naming it in a list where the whole of it
	/// would drown the plan.
	function firstLine(text) {
		var s = String(text || '').split('\n')[0];
		return s.length > 90 ? (s.slice(0, 89) + '…') : s;
	}

	/// The word a draft's kind is read as, and the whole of what it promises.
	function kindWord(d) {
		if (d.kind === 'comment')  return tOr('social.triage_kind_comment', 'Comment on #{n}', { n: d.n });
		if (d.kind === 'revision') return tOr('social.triage_kind_revision', 'Revision of #{n}', { n: d.n });
		return tOr('social.triage_kind_new', 'New proposal');
	}

	/// One draft, in a box somebody can read, edit and press.
	function drawDraft(d, i, byId) {
		var row = document.createElement('div');
		row.className = 'trg-draft';
		row.dataset.draft = String(i);
		row.dataset.kind  = d.kind;

		var head = document.createElement('div');
		head.className = 'trg-head';
		var kind = document.createElement('span');
		kind.className = 'trg-kind';
		kind.textContent = kindWord(d);
		head.appendChild(kind);
		// A separator in the DOM rather than a margin in a stylesheet. It was put
		// here because improve.css belonged to another lane that week and a head
		// reading "New proposalfrom 1 note" is wrong on the screen today; the
		// file is free now and this is still the right place for it, since what
		// separates two words is a character and not a box.
		var gap = document.createElement('span');
		gap.className = 'imp-as trg-gap';
		gap.textContent = ' \u00b7 ';
		head.appendChild(gap);
		var from = document.createElement('span');
		from.className = 'imp-note-state trg-from';
		from.textContent = d.from.length === 1
			? tOr('social.triage_from_one', 'from 1 note')
			: tOr('social.triage_from', 'from {n} notes', { n: d.from.length });
		from.title = d.from.map(function (id) {
			return byId[id] ? firstLine(byId[id].text) : id;
		}).join('\n');
		head.appendChild(from);
		row.appendChild(head);

		if (d.why) row.appendChild(line('imp-as trg-why', d.why));

		if (d.sent) {
			// What happened, and the draft's own characters kept beside it: a row
			// that replaced the words with "Sent" would take the only reading of
			// what was published off the screen.
			row.appendChild(line('imp-note-state trg-sent', d.kind === 'comment'
				? tOr('social.triage_said', 'Said on proposal #{n}.', { n: d.sent })
				: (d.kind === 'revision'
					? tOr('social.triage_revised', 'Proposal #{n} is revised.', { n: d.sent })
					: tOr('social.triage_opened', 'Opened as proposal #{n}.', { n: d.sent }))));
			row.appendChild(line('imp-note-text trg-was', bodyOf(d)));
			return row;
		}

		var box = document.createElement('textarea');
		box.className = 'imp-box trg-box';
		box.rows = d.kind === 'comment' ? 3 : 6;
		box.value = bodyOf(d);
		box.setAttribute('aria-label', kindWord(d));
		row.appendChild(box);

		if (d.err) row.appendChild(line('rail-note imp-err trg-err', d.err));

		var acts = document.createElement('div');
		acts.className = 'imp-acts trg-draft-acts';
		var can = sendable(d);
		if (can === 'yes') {
			acts.appendChild(button('imp-send trg-send', 'triage-send',
				tOr('social.send', 'Send'),
				tOr('social.triage_send_help',
					'Sends exactly what is in the box. Nothing else.')));
		} else if (can === 'novoice') {
			acts.appendChild(line('imp-as', tOr('social.as_novoice',
				'No voice yet — a note can only be kept here.')));
		}
		// `can === 'dark'` draws NOTHING. See `sendable`.
		acts.appendChild(button('imp-note-copy trg-drop', 'triage-drop',
			tOr('social.triage_drop', 'Not this one'),
			tOr('social.triage_drop_help', 'Drop this draft. Nothing is sent.')));
		row.appendChild(acts);
		return row;
	}

	/// The characters a draft's box starts with: the same cut, put back
	/// together, so what is read is what would leave.
	function bodyOf(d) {
		if (d.kind === 'comment') return d.body;
		return d.body ? (d.title + '\n' + d.body) : d.title;
	}

	/// Whether this draft can be sent, and if not, whether to say so.
	///
	/// THREE ANSWERS AND THE THIRD IS SILENCE. `dark` is a REVISION on a forge
	/// that has not said this asker may revise -- and the flag is ABSENT rather
	/// than false when no voice asked, so `mayAmend` is false for both "not
	/// allowed" and "never asked". A button there would reach a route that does
	/// not exist yet, which is exactly the defect improve.js was rewritten to
	/// remove; a DISABLED button, or a sentence explaining the absence, would be
	/// a promise about a feature nobody has been given. So nothing is drawn, on
	/// the same terms the vote control is not drawn, and the day the forge
	/// answers the flag this lights up with no edit here.
	function sendable(d) {
		if (!hasVoice()) return 'novoice';
		if (d.kind !== 'revision') return 'yes';
		var p = panel();
		try { return (p && p.forge.mayAmend(d.n)) ? 'yes' : 'dark'; }
		catch (e) { return 'dark'; }
	}

	// ── Wiring ─────────────────────────────────────────────────

	document.addEventListener('click', function (e) {
		var host = e.target && e.target.closest ? e.target.closest('#improve-triage') : null;
		if (!host) return;
		var b = e.target.closest('[data-act]');
		if (!b) return;
		var act = b.dataset.act;
		if (act === 'triage-run')   { e.preventDefault(); run(); return; }
		if (act === 'triage-clear') { e.preventDefault(); clear(); return; }
		var row = b.closest('.trg-draft');
		if (!row) return;
		var i = Number(row.dataset.draft);
		if (act === 'triage-send') { e.preventDefault(); send(i); return; }
		if (act === 'triage-drop') { e.preventDefault(); drop(i); return; }
	});

	// Say this row's words again in a new language, on the same surface
	// improve.js registers -- a redraw of the panel redraws this with it.
	try {
		DaimondI18n.surface(function () { return document.getElementById('improve-triage'); },
			function () { draw(); });
	} catch (e) { /* no i18n in this build */ }

	window.DaimondTriage = {
		/// Drawn by improve.js's `render()`, so the row and the notes it counts
		/// can never disagree.
		draw:     draw,
		/// The one press: read every kept note and the public proposals, and
		/// draft a plan. Nothing is sent.
		run:      run,
		/// One press per draft. Sends exactly the characters in that box.
		send:     send,
		drop:     drop,
		clear:    clear,
		/// Everything the model is given, PURE, so a verifier can assert that all
		/// of it arrived rather than inferring it from a plausible plan.
		brief:    brief,
		/// What one run would cost at most, before it runs.
		estimate: estimate,
		/// The parse, for a verifier that wants to press a malformed answer
		/// through it without paying for one.
		parse:    parse,
		/// The plan on screen, or null. A copy.
		plan:     function () { return _plan ? JSON.parse(JSON.stringify(_plan)) : null; },
		/// Put a plan on the screen without paying for a turn, so a verifier
		/// drives the DRAWING it would have drawn rather than a second one
		/// written for it. It goes through `parse()` like any answer, so a shape
		/// this build would have refused is refused here too.
		hold:     function (text) {
			var read = parse(typeof text === 'string' ? text : JSON.stringify(text));
			if (read.err || !read.drafts.length) { _plan = null; draw(); return null; }
			var got = pick();
			_plan = { at: Date.now(), drafts: read.drafts, left: read.left,
				dropped: read.dropped, model: got ? got.model : '' };
			draw();
			return JSON.parse(JSON.stringify(_plan));
		},
		/// Whether a run is in flight.
		busy:     function () { return _busy; },
		/// For a verifier that wants a cold panel.
		reset:    function () { _plan = null; _say = ''; _busy = false; },
	};
})();
