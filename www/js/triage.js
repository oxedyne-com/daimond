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
   same one act, the same reading of the same screen at the moment
   of the press. THIS FILE NO LONGER HOLDS THAT PRESS. It drafts a
   plan and hands the drafts to js/approvelist.js -- the one review
   surface, where each draft is edited, ticked and sent, reading the
   textarea at the instant of the press exactly as `improve.js`'s
   `outgoing()`/`split()` do, through improve.js's forge door rather
   than a second one. The rule is kept there now; there is no second
   place it could be got wrong.

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

   One press to draft, then the drafts wait in the queue for the
   ticks and the one "Send selected" press below. No timer, no
   panel-open trigger, no "while you were away". The cost is said
   BEFORE the drafting press and as a CEILING, because a figure a
   person reads after the money is gone is not consent.

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

	/// Hand a plan's drafts to the approve-list, which is the ONE place a draft
	/// is reviewed, edited, ticked and sent. This file GENERATES a plan from the
	/// whole list of notes; it does not send. The queue does, in one press, and
	/// folds the notes a sent draft was written from -- so there is one door and
	/// one review surface, not two.
	function toQueue(drafts) {
		try { if (window.DaimondApproveList) DaimondApproveList.enqueue(drafts); }
		catch (e) { log('the drafts would not reach the queue', e); }
	}

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

	/// Which model this would run on: the DRAFTING model, which is the chat model
	/// until the user sets one of its own in AI settings. On their own key either
	/// way. Null when nothing is configured, which is a reason not to offer the
	/// control at all rather than a reason to offer one that fails. `resolveDraft`
	/// answers the same shape as `resolve`, so the estimate and the cost line below
	/// price whichever model this actually is.
	function pick() {
		try {
			if (!window.DaimondModels) return null;
			return DaimondModels.resolveDraft();
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
			toQueue(read.drafts);
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

	// ── There is no press here any more ────────────────────────
	//
	// A draft used to be sent by its own press in this file's own plan view, and
	// every note it was written from was folded here. BOTH MOVED TO THE QUEUE.
	// js/approvelist.js is the one surface a draft is reviewed, edited, ticked and
	// sent on, and it folds the notes at the moment it sends -- so `boxed`, `cut`,
	// `send` and `drop` are gone rather than kept beside a second door. This file
	// GENERATES a plan and hands its drafts to `toQueue`; it reads no textarea and
	// puts nothing on the wire. Removing the surface rather than hiding it is the
	// no-back-compat rule: two review surfaces is exactly the confusion the unify
	// was asked for.

	/// Forget this run's summary. The drafts are in the queue, where they stay;
	/// this only clears the line above the queue that says how the run went.
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

	/// The plan's SUMMARY, not the drafts: how the run went. The drafts themselves
	/// went to the approve-list below, which is where they are read, edited,
	/// ticked and sent. What stays here is the count, anything dropped, and the
	/// notes that landed in no draft -- feedback the queue does not carry.
	function drawPlan(notes) {
		var wrap = document.createElement('div');
		wrap.className = 'trg-plan';
		var byId = {};
		notes.forEach(function (r) { byId[r.id] = r; });

		wrap.appendChild(line('imp-asat trg-asat', tOr('social.triage_plan',
			'{n} drafts from your notes, by {model}. '
			+ 'Edit any, send the ones you want. Nothing has left this device.',
			{ n: _plan.drafts.length, model: _plan.model })));

		if (_plan.dropped) {
			wrap.appendChild(line('rail-note trg-dropped', tOr('social.triage_dropped',
				'{n} more came back in a shape this panel could not read, and are not shown.',
				{ n: _plan.dropped })));
		}

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

	// The kind word, the draft box, the per-draft Send and the author-only
	// `sendable` gate all MOVED TO js/approvelist.js, which draws the drafts now.
	// The revision gate in particular -- a REVISION is dark until the forge says
	// this asker may amend -- lives there, on the same argument it lived here:
	// a control that reached a route this asker may not use is the defect the
	// panel was rewritten to remove. One review surface, one copy of that rule.

	// ── Wiring ─────────────────────────────────────────────────

	document.addEventListener('click', function (e) {
		var host = e.target && e.target.closest ? e.target.closest('#improve-triage') : null;
		if (!host) return;
		var b = e.target.closest('[data-act]');
		if (!b) return;
		var act = b.dataset.act;
		if (act === 'triage-run')   { e.preventDefault(); run(); return; }
		if (act === 'triage-clear') { e.preventDefault(); clear(); return; }
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
		/// The one press: read every kept note and the public proposals, draft a
		/// plan, and hand its drafts to the approve-list. Nothing is sent -- the
		/// queue sends, in one press, on the user's tick.
		run:      run,
		/// Forget this run's summary. The drafts stay in the queue.
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
			// The same hand-off a real run makes, so a verifier drives the queue the
			// run would have filled rather than a second path written for it.
			toQueue(read.drafts);
			draw();
			return JSON.parse(JSON.stringify(_plan));
		},
		/// Whether a run is in flight.
		busy:     function () { return _busy; },
		/// For a verifier that wants a cold panel.
		reset:    function () { _plan = null; _say = ''; _busy = false; },
	};
})();
