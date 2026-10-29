// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
import { AGENT_LENS_KEY, agentSearch, chatInput, chatOutput, chatStop, diamondSearch, newDiamondBtn,
	newSessionBtn, pg } from './state.js';
import { CFG_KEY, PROVIDERS, authHeadersFor, autoMaxOut, fmtTok, getSecret, hideSecret,
	maxOutCeiling, modelsUrl, providerForUrl, readJson, setSecret, syncCfgFromModels, t, tn } from './util.js';
import { closeSkillMenu, daimonPrior, ensureApp, fitComposer, openSkillMenu, sendUserMessage,
	syncConciseChip, toggleConcise } from './send.js';
import { stopGeneration } from './steer.js';
import { Workers } from './workers.js';
import { Files } from './files_view.js';
import { DaimondAdmin } from './admin.js';
import { DaimondPanels, isMobile } from './layout.js';
import { turnModelOf } from './rating.js';
import { toast } from './passkey_phrase.js';
import { Doorbell } from './termpanel.js';
import { TICK_SVG, _selectMode, buildTile, copyToClipboard, jumpBack, jumpEnd, makeRollup,
	outcomeOfStoredText, pickAll, pickedTurns, rollUpdate, sayQuietly, setAllTurnsOpen, setSelectMode,
	syncJumps, tilePeek } from './turns.js';
import { noticeDialog } from './consent.js';
import { bindSend, foldChatInto, newChat, openChatsMenu, openFoldPicker, syncSendMode } from './chats.js';
import { CONTEXT_CAP_MAX, CONTEXT_CAP_MIN, DEFAULT_CONTEXT_CAP, DEFAULT_FOLD_AT, DEFAULT_SPEND_CAP,
	FOLD_AT_MAX, FOLD_AT_MIN, SPEND_CAP_MAX, SPEND_CAP_MIN, chatDisplayName, openAbout } from './tilestyle.js';
import { PENDING_KEY, Pending, Prompts } from './pending.js';
import { _diamondAppProvider, daimonApp, diamondApp, diamondVisionModel, diamondWorkerModel,
	everyDiamondClient, resetDiamondApps } from './diamonds.js';
import { createDiamond, renderAgentGrid, renderDiamondList, selectDiamond, setDiamondQuery } from './agentspanel.js';
import { crystalFull, crystalLib, overlayUp, setCrystalFull } from './crystal.js';
import { rebuildChatApp } from './marks.js';
// page-split: end imports
export let jumpBtn, endBtn; // page-split: hoisted
let guideBtn, impInfo, aboutBtn, chatsMenuBtn, pendSort, crystalFullBtn, linkGraphBtn,
	railSearchLive, agentLensBox, agentsClearBtn, agentsPauseBtn, agentsPlayBtn, agentsStopBtn,
	toolsHidden, stepsBtn, expandAllBtn, copyAllBtn, _wireEnc, conciseChip, chatFoldBtn, selAllBtn,
	selNoneBtn, selFoldBtn; // page-split: hoisted

// ── Settings modal ─────────────────────────────────────────
// Show the raw base-URL row only for the Custom provider; curated
// providers fill the URL behind the scenes.
function applyProviderChoice(id, keepUrl) {
	var urlRow = document.getElementById('cfg-url-row');
	var urlInput = document.getElementById('cfg-base-url');
	if (id === 'custom') {
		urlRow.style.display = '';
		if (!keepUrl && providerForUrl(urlInput.value) !== 'custom') urlInput.value = '';
	} else if (id && PROVIDERS[id]) {
		urlRow.style.display = 'none';
		urlInput.value = PROVIDERS[id].url;
	} else {
		urlRow.style.display = 'none';
		if (!keepUrl) urlInput.value = '';
	}
}

// Model <select> helpers. The dropdown is the naive path; an "Other…"
// option reveals a text box for manual entry or providers that don't list.
var MODEL_OTHER = '__other__';
function setModelOptions(opts, selected) {
	var sel = document.getElementById('cfg-model');
	sel.innerHTML = '';
	opts.forEach(function (o) {
		var el = document.createElement('option');
		el.value = o.value;
		el.textContent = o.label;
		if (o.disabled) el.disabled = true;
		// "Other…" is the way out for a model the provider does not list, so the
		// filter never takes it off the list.
		if (o.value === MODEL_OTHER) el.dataset.keep = '1';
		sel.appendChild(el);
	});
	if (selected != null) sel.value = selected;
	syncModelCustom();
}
function syncModelCustom() {
	var sel = document.getElementById('cfg-model');
	document.getElementById('cfg-model-custom').style.display = (sel.value === MODEL_OTHER) ? '' : 'none';
}
function currentModel() {
	var sel = document.getElementById('cfg-model');
	return sel.value === MODEL_OTHER ? document.getElementById('cfg-model-custom').value.trim() : sel.value;
}
// Auto-load the provider's live model list into the dropdown the moment a
// provider and key are both present — no button, it just happens.
var _modelFetchSeq = 0;
var _modelFetchFor = '';        // the provider+url+key the dropdown already reflects
var _keyRejectedFor = '';       // a provider+url+key the provider has answered 401/403 to
function fetchModels() {
	var prov = document.getElementById('cfg-provider').value;
	var base = document.getElementById('cfg-base-url').value.trim();
	var key = getSecret(document.getElementById('cfg-api-key'));
	if (!prov) { setModelOptions([{ value: '', label: 'Choose a provider first…' }]); return; }
	if (!base || !key) { setModelOptions([{ value: '', label: 'Enter your API key to load models…' }]); return; }
	// Asking the same provider about the same key twice cannot tell us
	// anything new — and it is not free. `input` (debounced), `change` and
	// `blur` all land on this, so clicking Save & start fired one more fetch
	// on the way in: it reset the dropdown to "Loading…", hid the manual-model
	// box, and the form SHRANK between the mousedown and the mouseup. The
	// button moved out from under the pointer and the click was never
	// delivered — Save & start did nothing at all, and said nothing either.
	var want = prov + '\u0000' + base + '\u0000' + key;
	if (want === _modelFetchFor) return;
	_modelFetchFor = want;
	var prevSel = currentModel();	// preserve the user's current pick across a reload
	var seq = ++_modelFetchSeq;
	var _msel = document.getElementById('cfg-model');
	var _hasReal = Array.prototype.some.call(_msel.options, function (o) { return o.value && o.value !== MODEL_OTHER; });
	if (!_hasReal) setModelOptions([{ value: '', label: 'Loading models…' }]);
	fetch(modelsUrl(base), { headers: authHeadersFor(base, key) })
		.then(function (r) { return r.ok ? r.json() : r.text().then(function () { throw new Error('HTTP ' + r.status); }); })
		.then(function (j) {
			if (seq !== _modelFetchSeq) return;	// superseded by a newer fetch
			var listed = (j && j.data) ? j.data : (Array.isArray(j) ? j : []);
			var ids = listed.map(function (m) { return typeof m === 'string' ? m : m.id; }).filter(Boolean)
				// Drop non-chat models (image, embedding, audio, rerank) so a
				// naive user cannot pick one and hit a confusing error.
				.filter(function (id) { return !/flux|stable-?diffusion|sdxl|playground|embed|nomic|bge-|whisper|tts|rerank|moderation|vision-only|image|dall-?e|imagen|midjourney|upscal|inpaint|speech|audio|transcri|guard/i.test(id); })
				.sort();
			try { localStorage.setItem('daimond-models', JSON.stringify(ids)); } catch (e) {}
			var opts = ids.map(function (id) { return { value: id, label: id }; });
			opts.push({ value: MODEL_OTHER, label: t('models.other') });
			var want = (prevSel && ids.indexOf(prevSel) !== -1) ? prevSel
				: (pg.cfg.model && ids.indexOf(pg.cfg.model) !== -1) ? pg.cfg.model
				: (ids.length ? ids[0] : MODEL_OTHER);
			setModelOptions(opts, want);
			if (want === MODEL_OTHER && pg.cfg.model) document.getElementById('cfg-model-custom').value = pg.cfg.model;
			document.getElementById('byok-note').textContent = '';
			_keyRejectedFor = '';   // the key just listed models, so it works
		})
		.catch(function (err) {
			if (seq !== _modelFetchSeq) return;
			setModelOptions([{ value: MODEL_OTHER, label: t('models.other') }], MODEL_OTHER);
			if (pg.cfg.model) document.getElementById('cfg-model-custom').value = pg.cfg.model;
			var es = String(err && err.message ? err.message : err), note = document.getElementById('byok-note');
			if (/\b401\b|\b403\b/.test(es)) {
				// The real cause is the key, not model listing — say so, and
				// remember it, so Save cannot then report this same key connected.
				note.textContent = t('models.key_rejected');
				document.getElementById('cfg-api-key').focus();
				_keyRejectedFor = prov + ' ' + base + ' ' + key;
			} else {
				note.textContent = t('models.list_failed');
			}
		});
}

export function fillSettings() {
	var prov = providerForUrl(pg.cfg.baseUrl || '');
	document.getElementById('cfg-provider').value = prov;
	document.getElementById('cfg-base-url').value = pg.cfg.baseUrl || '';
	setSecret(document.getElementById('cfg-api-key'), pg.cfg.apiKey || '');
	applyProviderChoice(prov, true);
	// Seed the model dropdown with the saved model, then refresh from the
	// provider if we have a key.
	if (pg.cfg.model) {
		setModelOptions([{ value: pg.cfg.model, label: pg.cfg.model },
			{ value: MODEL_OTHER, label: t('models.other') }], pg.cfg.model);
	} else {
		setModelOptions([{ value: '',
			label: t(prov ? 'models.enter_key_first' : 'models.choose_provider_first') }]);
	}
	if (prov && pg.cfg.apiKey) fetchModels();
}

/// Draw every row of Settings > Limits, to what is stored.
///
/// `DaimondAdmin` paints the Limits view with this when it opens and when the
/// language changes. Every row writes its own strings HERE rather than where it
/// is built: each builds itself once and returns early ever after, so a string
/// set at build time is a string in whatever language the panel was first
/// opened in -- which is what left six labels and their notes in English behind
/// a switch to German, and behind every switch since they were added.
///
/// The order of the calls is the order on screen, since each row is placed
/// before `limits-end` when it is first built.
export function renderLimitRows() {
	// The reply-length row reads the starred model's ceiling, so it is redrawn
	// whenever the limits are, not only when it is first built.
	ReplyLength.render();
	RoundLimit.render();
	FoldPoint.render();
	ContextCap.render();
	SpendCap.render();
	CrystalCap.render();
	CrystalPageCap.render();
	CrystalHotCap.render();
	VersionsCap.render();
	DeleteAsk.render();
}
/// A string from the table, or the English written here when the table has no
/// entry for it yet.
///
/// The reply-length row ships before its i18n keys do — `www/js/i18n/en.js` is
/// not this file's to write — and a settings control reading
/// "settings.max_tokens" is worse than one reading English. Once the keys land
/// the table wins and these fallbacks go unused; nothing needs changing here.
///
/// `vars` fills `{name}` placeholders in whichever of the two is used, so a
/// fallback carrying one does not ship the braces to the screen while it
/// waits for its key.
export function tOr(key, fallback, vars) {
	var s = t(key, vars);
	if (s !== key) return s;
	if (!vars) return fallback;
	return String(fallback).replace(/\{(\w+)\}/g, function (whole, k) {
		return vars[k] != null ? String(vars[k]) : whole;
	});
}

/// A row's text in the page's language: its `say` key (params `say.v`) when it carries one
/// (a native runner's error, vision, failed-answer and cut rows), else its content.
export function logRowText(m) {
	var content = m.content == null ? '' : String(m.content);
	if (!(m.say && m.say.k)) return content;
	var v = m.say.v;
	// A COUNTED key (`turn.rows_cut` {n}) is a plural pair in the table, `<k>.one` /
	// `<k>.other`, so it is said in the locale's form for the count (`tn`).
	if (v && typeof v.n === 'number') {
		var s = tn(m.say.k, v.n, v);
		if (s !== m.say.k + (v.n === 1 ? '.one' : '.other')) return s;
	}
	return tOr(m.say.k, content, v);
}

/// The round-limit setting: how many tool-call rounds one turn may take.
///
/// A sibling of the reply-length row and deliberately beside it, because the two are the
/// same kind of thing to a person: how far one answer is allowed to go. Reply length caps
/// how much a model may SAY in a round; this caps how many rounds it may take before the
/// turn stops and says so.
///
/// It earns a control rather than a constant because the right value is not knowable from
/// here. The default was 25, is now 150, and a turn asked to refactor forty files can want
/// more; a turn that has started looping wants less. Both are ordinary, and the person who
/// can tell them apart is the one watching it.
///
/// Unlike reply length there is no per-model ceiling to read: a round is Daimond's own unit,
/// not the provider's, so the ladder is the same everywhere.
/// What the engine falls back to when nobody has chosen: `compact::DEFAULT_MAX_ROUNDS`.
/// Named here only so the "Default" row can say the figure rather than leave it a mystery;
/// nothing is set from it, so the two cannot disagree about what is in force.
var DEFAULT_ROUNDS = 150;

var RoundLimit = {
	/// The ladder offered. The user's own figure is added when it is off the ladder, so
	/// opening the panel never silently changes their setting.
	STEPS: [25, 50, 150, 300, 600],

	/// Build the row once, under the reply-length row it belongs beside.
	mount: function () {
		if (document.getElementById('cfg-max-rounds')) return true;
		var end = document.getElementById('limits-end');	// Settings > Limits
		var section = end && end.parentNode;
		if (!section) return false;
		var lab = document.createElement('label');
		lab.className = 'cfg-fieldlabel';
		lab.setAttribute('for', 'cfg-max-rounds');
		var sel = document.createElement('select');
		sel.className = 'settings-select';
		sel.id = 'cfg-max-rounds';
		var note = document.createElement('p');
		note.className = 'cfg-fieldnote';
		note.id = 'cfg-max-rounds-note';
		section.insertBefore(lab, end);
		section.insertBefore(sel, end);
		section.insertBefore(note, end);
		sel.addEventListener('change', function () { RoundLimit.save(sel.value); });
		return true;
	},

	/// Fill the pulldown from what is stored, and say what the row is.
	render: function () {
		if (!this.mount()) return;
		var lab = document.querySelector('label[for="cfg-max-rounds"]');
		if (lab) lab.textContent = tOr('settings.max_rounds', 'Steps per turn');
		var rnote = document.getElementById('cfg-max-rounds-note');
		if (rnote) {
			rnote.textContent = tOr('settings.max_rounds_note',
				'How many tool-calls one turn may take.');
		}
		var sel = document.getElementById('cfg-max-rounds');
		// The rest -- what happens at the limit -- rides on the control's hover.
		sel.title = tOr('settings.max_rounds_help',
			'It says so when it stops, and you can tell it to carry on.');
		sel.innerHTML = '';
		var mine = pg.cfg.maxRounds || 0;
		var steps = this.STEPS.slice();
		if (mine > 0 && steps.indexOf(mine) === -1) steps.push(mine);
		steps.sort(function (a, b) { return a - b; });
		var mk = function (value, label) {
			var o = document.createElement('option');
			o.value = String(value); o.textContent = label;
			sel.appendChild(o);
		};
		mk(0, tOr('settings.max_rounds_auto', 'Default') + ' \u2014 ' + DEFAULT_ROUNDS);
		steps.forEach(function (n) { mk(n, String(n) + ' ' + tOr('settings.steps', 'steps')); });
		sel.value = String(mine);
		if (sel.selectedIndex === -1) sel.value = '0';
	},

	/// Record a choice and rebuild every agent, since the limit is put on an app when it is
	/// built and a chat holding an old one would go on using it.
	save: function (raw) {
		var n = Math.max(0, Math.round(Number(raw) || 0));
		pg.cfg.maxRounds = n;
		var stored = readJson(CFG_KEY, {}) || {};
		stored.maxRounds = n;
		try { localStorage.setItem(CFG_KEY, JSON.stringify(stored)); }
		catch (e) { /* quota or unavailable — the choice holds for this session */ }
		pg.chats.forEach(rebuildChatApp);
		resetDiamondApps();
		this.render();
	},
};

/// Where a conversation is folded, as a share of the model's context window.
///
/// A sibling of the round limit and drawn beside it, because both answer "how far does one
/// conversation get to run". The round limit bounds a single turn; this bounds the whole
/// thread before the provider does it for us.
///
/// It earns a control for the reason the round limit does: the right value is not knowable
/// from here. Folding early is cheap and loses detail the model may still want; folding late
/// keeps everything and risks a refusal, because the window a fold is measured against is one
/// this app usually only guessed at. Which of those matters is the user's to say.
///
/// The ladder is in PER CENT because that is how the context meter is read; the engine is
/// handed the fraction.
var FoldPoint = {
	/// The ladder offered, as percentages. The user's own figure is added when it is off the
	/// ladder, so opening the panel never silently changes their setting.
	STEPS: [50, 60, 65, 70, 80, 90],

	/// Build the row once, under the round-limit row it belongs beside.
	mount: function () {
		if (document.getElementById('cfg-fold-at')) return true;
		var end = document.getElementById('limits-end');	// Settings > Limits
		var section = end && end.parentNode;
		if (!section) return false;
		var lab = document.createElement('label');
		lab.className = 'cfg-fieldlabel';
		lab.setAttribute('for', 'cfg-fold-at');
		var sel = document.createElement('select');
		sel.className = 'settings-select';
		sel.id = 'cfg-fold-at';
		var note = document.createElement('p');
		note.className = 'cfg-fieldnote';
		note.id = 'cfg-fold-at-note';
		section.insertBefore(lab, end);
		section.insertBefore(sel, end);
		section.insertBefore(note, end);
		sel.addEventListener('change', function () { FoldPoint.save(sel.value); });
		return true;
	},

	/// Fill the pulldown from what is stored, and say what the row is.
	render: function () {
		if (!this.mount()) return;
		var lab = document.querySelector('label[for="cfg-fold-at"]');
		if (lab) lab.textContent = tOr('settings.fold_at', 'Fold the conversation at');
		var fnote = document.getElementById('cfg-fold-at-note');
		if (fnote) {
			fnote.textContent = tOr('settings.fold_at_note',
				'How full the context gets before earlier chat is summarised.');
		}
		var sel = document.getElementById('cfg-fold-at');
		// The trade-off between folding sooner and keeping more rides on hover.
		sel.title = tOr('settings.fold_at_help',
			'It says so in the thread when it folds. Lower folds sooner and more often; '
				+ 'higher keeps more of the conversation word for word.');
		sel.innerHTML = '';
		var mine = Math.round((pg.cfg.foldAt || 0) * 100);
		var steps = this.STEPS.slice();
		if (mine > 0 && steps.indexOf(mine) === -1) steps.push(mine);
		steps.sort(function (a, b) { return a - b; });
		var mk = function (value, label) {
			var o = document.createElement('option');
			o.value = String(value); o.textContent = label;
			sel.appendChild(o);
		};
		mk(0, tOr('settings.fold_at_auto', 'Default') + ' \u2014 '
			+ Math.round(DEFAULT_FOLD_AT * 100) + '%');
		steps.forEach(function (n) { mk(n, String(n) + '%'); });
		sel.value = String(mine);
		if (sel.selectedIndex === -1) sel.value = '0';
	},

	/// Record a choice and rebuild every agent, since the fraction is put on an app when it is
	/// built and a chat holding an old one would go on folding where it used to.
	save: function (raw) {
		var pct = Math.max(0, Math.round(Number(raw) || 0));
		// Held at the band the engine holds it at, so what the panel shows back is what is in
		// force. A zero is not clamped: it is how "the user has not chosen" travels.
		var f = pct ? Math.min(FOLD_AT_MAX, Math.max(FOLD_AT_MIN, pct / 100)) : 0;
		pg.cfg.foldAt = f;
		var stored = readJson(CFG_KEY, {}) || {};
		stored.foldAt = f;
		try { localStorage.setItem(CFG_KEY, JSON.stringify(stored)); }
		catch (e) { /* quota or unavailable — the choice holds for this session */ }
		pg.chats.forEach(rebuildChatApp);
		resetDiamondApps();
		this.render();
	},
};

/// The ceiling the fold fraction is held under, in tokens, and the reason the fraction alone
/// was never the whole answer.
///
/// `fold_at` is a FRACTION of the window, so on a model with a very large window it folds
/// near a very large number -- and a long agentic turn then re-sends a context grown to
/// hundreds of thousands of tokens on every one of its rounds, billed in full even though
/// almost all of it is a cache hit. That carry, and not any single message, is where a big
/// window's bill comes from. `compact::ABSOLUTE_CAP` has held it since the cap was written,
/// and until now it was a constant nothing in the product named: a reader watching the meter
/// had no way to know why a conversation on a million-token model folded at a tenth of it.
///
/// In THOUSANDS of tokens, because that is how a context window is quoted; the engine is
/// handed the count.
var ContextCap = {
	/// The ladder offered, in thousands of tokens. The user's own figure is added when it is
	/// off the ladder, so opening the panel never silently changes their setting.
	STEPS: [60, 90, 120, 160, 200, 400],

	/// Build the row once, under the fold-point row it belongs beside.
	mount: function () {
		if (document.getElementById('cfg-context-cap')) return true;
		var end = document.getElementById('limits-end');	// Settings > Limits
		var section = end && end.parentNode;
		if (!section) return false;
		var lab = document.createElement('label');
		lab.className = 'cfg-fieldlabel';
		lab.setAttribute('for', 'cfg-context-cap');
		var sel = document.createElement('select');
		sel.className = 'settings-select';
		sel.id = 'cfg-context-cap';
		var note = document.createElement('p');
		note.className = 'cfg-fieldnote';
		note.id = 'cfg-context-cap-note';
		section.insertBefore(lab, end);
		section.insertBefore(sel, end);
		section.insertBefore(note, end);
		sel.addEventListener('change', function () { ContextCap.save(sel.value); });
		return true;
	},

	/// Fill the pulldown from what is stored, and say what the row is.
	render: function () {
		if (!this.mount()) return;
		var lab = document.querySelector('label[for="cfg-context-cap"]');
		if (lab) lab.textContent = tOr('settings.context_cap', 'Carry at most');
		var note = document.getElementById('cfg-context-cap-note');
		if (note) {
			note.textContent = tOr('settings.context_cap_note',
				'The most one round carries, however big the model\u2019s window.');
		}
		var sel = document.getElementById('cfg-context-cap');
		// What moving it costs, either way, rides on hover: this is the setting that decides
		// what a long turn is billed, and neither direction is free.
		sel.title = tOr('settings.context_cap_help',
			'A long turn re-sends its whole conversation every round, so this is what it '
				+ 'costs. Lower carries less and folds more often; higher keeps more of the '
				+ 'work word for word.');
		sel.innerHTML = '';
		var mine = Math.round((pg.cfg.contextCap || 0) / 1000);
		var steps = this.STEPS.slice();
		if (mine > 0 && steps.indexOf(mine) === -1) steps.push(mine);
		steps.sort(function (a, b) { return a - b; });
		var mk = function (value, label) {
			var o = document.createElement('option');
			o.value = String(value); o.textContent = label;
			sel.appendChild(o);
		};
		mk(0, tOr('settings.context_cap_auto', 'Default') + ' \u2014 '
			+ Math.round(DEFAULT_CONTEXT_CAP / 1000) + 'k');
		steps.forEach(function (n) { mk(n, String(n) + 'k'); });
		sel.value = String(mine);
		if (sel.selectedIndex === -1) sel.value = '0';
	},

	/// Record a choice and rebuild every agent, for the reason `FoldPoint.save` gives: the
	/// ceiling is put on an app when it is built, so a chat holding an old one would go on
	/// carrying what it used to.
	save: function (raw) {
		var k = Math.max(0, Math.round(Number(raw) || 0));
		// Held at the band the engine holds it at, so what the panel shows back is what is in
		// force. A zero is not clamped: it is how "the user has not chosen" travels.
		var n = k ? Math.min(CONTEXT_CAP_MAX, Math.max(CONTEXT_CAP_MIN, k * 1000)) : 0;
		pg.cfg.contextCap = n;
		var stored = readJson(CFG_KEY, {}) || {};
		stored.contextCap = n;
		try { localStorage.setItem(CFG_KEY, JSON.stringify(stored)); }
		catch (e) { /* quota or unavailable \u2014 the choice holds for this session */ }
		pg.chats.forEach(rebuildChatApp);
		resetDiamondApps();
		this.render();
	},
};

/// What one TURN may spend before Daimond stops it, in US dollars.
///
/// **The ceiling that holds a runaway, and the round limit is not.** A turn that reaches the
/// round limit now carries itself on up to three times rather than handing the user a Continue
/// button, so the rounds no longer bound what a turn costs -- and the figure that does has to
/// be the payer's: five dollars is a day's work on a cheap model and two legs on an expensive
/// one, and nothing in the app can know which was meant.
///
/// It applies only where the provider reports what a round cost. Several report nothing and a
/// local model costs nothing, so a turn with no price is held by its rounds alone; see
/// `Agent::over_the_spend_cap` for why a guessed price would be worse than none.
export var SpendCap = {
	/// The ladder offered, in US dollars. The user's own figure is added when it is off the
	/// ladder, so opening the panel never silently changes their setting.
	STEPS: [0.5, 1, 2, 5, 10, 25, 50],

	/// Build the row once, under the context-ceiling row it belongs beside.
	mount: function () {
		if (document.getElementById('cfg-spend-cap')) return true;
		var end = document.getElementById('limits-end');	// Settings > Limits
		var section = end && end.parentNode;
		if (!section) return false;
		var lab = document.createElement('label');
		lab.className = 'cfg-fieldlabel';
		lab.setAttribute('for', 'cfg-spend-cap');
		var sel = document.createElement('select');
		sel.className = 'settings-select';
		sel.id = 'cfg-spend-cap';
		section.insertBefore(lab, end);
		section.insertBefore(sel, end);
		sel.addEventListener('change', function () { SpendCap.save(sel.value); });
		return true;
	},

	/// How a figure in dollars is written on the ladder. The cap is a dollar
	/// limit, so it says US dollars, with the reader's own currency beside it.
	money: function (usd) {
		return DaimondI18n.billed(usd);
	},

	/// Fill the pulldown from what is stored, and say what the row is.
	render: function () {
		if (!this.mount()) return;
		var lab = document.querySelector('label[for="cfg-spend-cap"]');
		if (lab) lab.textContent = tOr('settings.spend_cap', 'Stop a turn at');
		var sel = document.getElementById('cfg-spend-cap');
		// WHY THERE IS A CEILING AT ALL rides on hover, because the reason is not obvious from
		// the row: the round limit stopped being the thing that ends a runaway turn.
		sel.title = tOr('settings.spend_cap_help',
			'A turn that reaches the round limit carries itself on, so this is the ceiling '
				+ 'that holds a runaway. It applies only where the provider reports what a '
				+ 'round cost.');
		sel.innerHTML = '';
		var mine = Number(pg.cfg.spendCap || 0);
		var steps = this.STEPS.slice();
		if (mine > 0 && steps.indexOf(mine) === -1) steps.push(mine);
		steps.sort(function (a, b) { return a - b; });
		var mk = function (value, label) {
			var o = document.createElement('option');
			o.value = String(value); o.textContent = label;
			sel.appendChild(o);
		};
		mk(0, tOr('settings.spend_cap_auto', 'Default') + ' \u2014 '
			+ SpendCap.money(DEFAULT_SPEND_CAP));
		steps.forEach(function (n) { mk(n, SpendCap.money(n)); });
		sel.value = String(mine);
		if (sel.selectedIndex === -1) sel.value = '0';
	},

	/// Record a choice and rebuild every agent, for the reason `FoldPoint.save` gives: the
	/// ceiling is put on an app when it is built, so a chat holding an old one would go on
	/// spending what it used to.
	save: function (raw) {
		var usd = Math.max(0, Number(raw) || 0);
		// Held at the band the engine holds it at, so what the panel shows back is what is in
		// force. A zero is not clamped: it is how "the user has not chosen" travels.
		var n = usd ? Math.min(SPEND_CAP_MAX, Math.max(SPEND_CAP_MIN, usd)) : 0;
		pg.cfg.spendCap = n;
		var stored = readJson(CFG_KEY, {}) || {};
		stored.spendCap = n;
		try { localStorage.setItem(CFG_KEY, JSON.stringify(stored)); }
		catch (e) { /* quota or unavailable — the choice holds for this session */ }
		pg.chats.forEach(rebuildChatApp);
		resetDiamondApps();
		this.render();
	},
};

/// Put the user's round limit on a freshly built agent, where they have set one.
///
/// Zero means "leave the engine's own default alone", which is what `set_max_rounds`
/// already does with a zero — passed through rather than special-cased here so there is one
/// rule and it lives at the end that enforces it.
///
/// # Arguments
/// * `app` - The DaimondApp to bound.
export function applyRoundLimit(app) {
	if (!app || !pg.cfg.maxRounds || typeof app.set_max_rounds !== 'function') return;
	try { app.set_max_rounds(pg.cfg.maxRounds); } catch (e) { /* an older wasm build has no setter */ }
}

/// Put a test's liveness limit on a freshly built agent: `window.__livenessMs`, the most a turn
/// may go without its model making progress, in ms (U3a LV2).  Unset, the engine's own default
/// stands.  Only the verifiers set it (`dev/verify_livequiet.mjs`, `dev/verify_actor.mjs`
/// arm `ledger`); the chat, Diamond and worker builders all apply it (U3a END).
///
/// # Arguments
/// * `app` - The DaimondApp to set.
export function applyLiveness(app) {
	var ms = Number(window.__livenessMs || 0);
	if (!app || !(ms > 0) || typeof app.set_liveness_ms !== 'function') return;
	try { app.set_liveness_ms(ms); } catch (e) { /* an older wasm build has no setter */ }
}

/// What the engine falls back to when nobody has chosen: `tools::CRYSTAL_CAP_DEFAULT` and
/// `tools::CRYSTAL_PAGE_CAP_DEFAULT`. Named here only so each "Default" row can show its
/// figure; nothing is set from either.
///
/// THESE ARE A COPY AND A COPY GOES STALE. `DEFAULT_CRYSTAL_PAGE_KB` said 64 from 2026-08-13,
/// when the engine's figure went to 128, until 2026-08-28 -- so for a fortnight the one place
/// in the product that names the page ceiling named half of it, while the engine refused at
/// the real number and said so only to whoever read the refusal. The author of a capp that met
/// the ceiling had to find it by experiment and reported it as "~130kB", which is 131,072
/// bytes seen from outside. `dev/verify_crystalcap.mjs` now reads both sides and fails when
/// they disagree, so the next raise cannot leave this behind.
var DEFAULT_CRYSTAL_KB = 48;
var DEFAULT_CRYSTAL_HOT_KB = 16;	// tools::CRYSTAL_HOT_CAP_DEFAULT, raised 2026-09-14: 4 KiB lost two thirds of crystal_cold's answers
var DEFAULT_CRYSTAL_PAGE_KB = 512;

// ── The one-time doorbell notice ───────────────────────────
//
// Decision 11 turns the doorbell ON by default for a beta account. A default
// that sends mail on somebody's behalf has to be TOLD to them, and told
// before the first one goes -- otherwise the first they know of it is the
// email itself, which is the thing the notice exists to pre-empt.
//
// It is a NOTICE and not a consent gate, and the difference is deliberate: a
// gate would make dismissing it a decision, and a person who taps past a
// modal has not decided anything. This says what will happen, names where the
// switch is, and changes nothing whichever way it is dismissed.
//
// It can only be shown once there is a session, so it hangs off
// `daimond:authed` rather than a boot. In practice that IS before the first
// ring: a doorbell is armed by a message arriving, a message needs a
// correspondent, and a correspondent needs this app to have been opened.

/// Where the one showing is remembered. Per device, deliberately: the notice
/// is about mail leaving on this account's behalf, and a person who has read
/// it on their laptop does not need it again on their phone -- but a device
/// that cannot read the account's sync is still owed it.
var DOORBELL_TOLD = 'daimond-doorbell-told';

/// Tell them once, if the doorbell is on and they never chose it.
///
/// SILENT IN EVERY OTHER CASE. Somebody who turned it on themselves has been
/// told by the act of turning it on; somebody it cannot reach is told by the
/// settings row, which is where they can do something about it.
async function doorbellNotice() {
	try {
		if (localStorage.getItem(DOORBELL_TOLD)) return;
	} catch (e) { return; }			// private mode: no memory, so no repeat notice
	if (!window.DaimondPost || !DaimondPost.doorbell) return;
	var st = null;
	try { st = await DaimondPost.doorbell(); } catch (e) { return; }
	// `set` is the whole test. On-and-chosen needs no notice, and off needs
	// none either -- this is only ever about a default that sends.
	if (!st || !st.ok || !st.on || st.set) return;
	// And nothing that cannot ring. Telling somebody with no address on file
	// that we may email them would be a notice about something that will not
	// happen, which is its own kind of untrue.
	if (st.reach !== 'ready' && st.reach !== 'quiet') return;
	try { localStorage.setItem(DOORBELL_TOLD, '1'); }
	catch (e) { /* it will be shown again, which is the safe way to fail */ }
	await noticeDialog(
		tOr('doorbell.notice_title', 'One email, at most once a day'),
		tOr('doorbell.notice_body',
			'When somebody sends you a private message and you have no Daimond open, '
			+ 'we may send one email to the address on your account saying that '
			+ 'something is waiting. It carries no sender, no subject, no count and no '
			+ 'link to any message — and at most one in any 24 hours.\n\n'
			+ 'You can turn it off whenever you like: open Social, go to Settings, and '
			+ 'it is the row called “Email doorbell”. Turning it off also stops any that '
			+ 'is already waiting to go.'));
	// The row may be on screen behind the notice, and its state is now stale.
	// The cached answer is stale now, so the next time Settings is opened it
	// is read again. NOT `DaimondPanels.show('social')`: that OPENS the panel, and a
	// panel that springs open behind a notice somebody has just dismissed is
	// the app taking over the screen to show a control nobody asked for.
	Doorbell.st = null;
}
// page-split: install 123

var CrystalCap = {
	/// The ladder offered, in kilobytes. The user's own figure is added when it is off the
	/// ladder, so opening the panel never silently changes their setting.
	STEPS: [4, 8, 16, 32, 64, 128],

	/// Build the heading and the row once, beneath the round limit they sit beside.
	mount: function () {
		if (document.getElementById('cfg-crystal-cap')) return true;
		var end = document.getElementById('limits-end');	// Settings > Limits
		var section = end && end.parentNode;
		if (!section) return false;
		var head = document.createElement('h4');
		head.className = 'cfg-fieldhead';
		head.id = 'cfg-crystal-limits';
		var lab = document.createElement('label');
		lab.className = 'cfg-fieldlabel';
		lab.setAttribute('for', 'cfg-crystal-cap');
		var sel = document.createElement('select');
		sel.className = 'settings-select';
		sel.id = 'cfg-crystal-cap';
		section.insertBefore(head, end);
		section.insertBefore(lab, end);
		section.insertBefore(sel, end);
		sel.addEventListener('change', function () { CrystalCap.save(sel.value); });
		return true;
	},

	/// Fill the pulldown from what is stored, and say what the two rows are.
	render: function () {
		if (!this.mount()) return;
		var head = document.getElementById('cfg-crystal-limits');
		if (head) head.textContent = tOr('settings.crystal_limits', 'Size limits');
		var lab = document.querySelector('label[for="cfg-crystal-cap"]');
		if (lab) lab.textContent = tOr('settings.crystal_cap', 'Crystal size limit');
		var sel = document.getElementById('cfg-crystal-cap');
		sel.innerHTML = '';
		var mine = pg.cfg.crystalKb || 0;
		var steps = this.STEPS.slice();
		if (mine > 0 && steps.indexOf(mine) === -1) steps.push(mine);
		steps.sort(function (a, b) { return a - b; });
		var mk = function (value, label) {
			var o = document.createElement('option');
			o.value = String(value); o.textContent = label;
			sel.appendChild(o);
		};
		mk(0, tOr('settings.crystal_cap_auto', 'Default') + ' — ' + DEFAULT_CRYSTAL_KB + ' KB');
		steps.forEach(function (n) { mk(n, String(n) + ' KB'); });
		sel.value = String(mine);
		if (sel.selectedIndex === -1) sel.value = '0';
	},

	/// Record a choice and put it in force at once. The ceiling is engine-wide rather than
	/// per-agent, so it does not need the agents rebuilt the way the round limit does.
	save: function (raw) {
		var n = Math.max(0, Math.round(Number(raw) || 0));
		pg.cfg.crystalKb = n;
		var stored = readJson(CFG_KEY, {}) || {};
		stored.crystalKb = n;
		try { localStorage.setItem(CFG_KEY, JSON.stringify(stored)); }
		catch (e) { /* quota or unavailable — the choice holds for this session */ }
		applyCrystalCap(anyApp());
		this.render();
	},
};

/// The page ceiling: how large `crystal.html` may grow.
///
/// The page is presentation and is capped anyway, because it is snapshotted at every version
/// where it changed and shares `SYNC_DIAMONDS_MAX` -- 4 MB -- with the memory it draws.
/// Exempting it would void the data cap's stated purpose. A version costs the splices from
/// the version before it with one full copy every twenty, so what a raise here actually
/// doubles is the keyframes: a Diamond at the ceiling weighs about `(1 + versions / 20)`
/// pages in the parcel.
///
/// A twin of `CrystalCap` in every respect, including that zero means the engine's default.
/// It mounts UNDER that row, sharing its heading.
var CrystalPageCap = {
	/// The ladder offered, in kilobytes. Four times the data ladder: a page is markup, and
	/// the built-in one is already several kilobytes of it.
	///
	/// THE TOP RUNG IS ONE ABOVE THE DEFAULT, DELIBERATELY. The refusal a capp meets at the
	/// ceiling tells its author this limit is theirs to raise here, and a ladder whose
	/// maximum IS the default makes that sentence a dead end. 1024 arrived with the default
	/// moving to 512 on 2026-08-28, to keep the rung that has always been there.
	STEPS: [16, 32, 64, 128, 256, 512, 1024],

	mount: function () {
		if (document.getElementById('cfg-crystal-page-cap')) return true;
		var end = document.getElementById('limits-end');	// Settings > Limits
		var section = end && end.parentNode;
		if (!section) return false;
		// The data row carries the heading the two share, so this one cannot exist
		// without it and does not try.
		if (!CrystalCap.mount()) return false;
		var lab = document.createElement('label');
		lab.className = 'cfg-fieldlabel';
		lab.setAttribute('for', 'cfg-crystal-page-cap');
		var sel = document.createElement('select');
		sel.className = 'settings-select';
		sel.id = 'cfg-crystal-page-cap';
		section.insertBefore(lab, end);
		section.insertBefore(sel, end);
		sel.addEventListener('change', function () { CrystalPageCap.save(sel.value); });
		return true;
	},

	render: function () {
		if (!this.mount()) return;
		var lab = document.querySelector('label[for="cfg-crystal-page-cap"]');
		if (lab) lab.textContent = tOr('settings.crystal_page_cap', 'Page size limit');
		var sel = document.getElementById('cfg-crystal-page-cap');
		sel.innerHTML = '';
		var mine = pg.cfg.crystalPageKb || 0;
		var steps = this.STEPS.slice();
		if (mine > 0 && steps.indexOf(mine) === -1) steps.push(mine);
		steps.sort(function (a, b) { return a - b; });
		var mk = function (value, label) {
			var o = document.createElement('option');
			o.value = String(value); o.textContent = label;
			sel.appendChild(o);
		};
		mk(0, tOr('settings.crystal_cap_auto', 'Default') + ' — ' + DEFAULT_CRYSTAL_PAGE_KB + ' KB');
		steps.forEach(function (n) { mk(n, String(n) + ' KB'); });
		sel.value = String(mine);
		if (sel.selectedIndex === -1) sel.value = '0';
	},

	save: function (raw) {
		var n = Math.max(0, Math.round(Number(raw) || 0));
		pg.cfg.crystalPageKb = n;
		var stored = readJson(CFG_KEY, {}) || {};
		stored.crystalPageKb = n;
		try { localStorage.setItem(CFG_KEY, JSON.stringify(stored)); }
		catch (e) { /* quota or unavailable — the choice holds for this session */ }
		applyCrystalCap(anyApp());
		this.render();
	},
};

/// The hot ceiling: how much of a crystal rides in the daimon's prompt on every round.
///
/// The third row under the same heading, and the only one of the three that is a per-round
/// bill -- the memory's and the page's bound what the browser stores and syncs. A crystal
/// whose whole text is under this rides whole, so lowering it splits more Diamonds and
/// raising it splits fewer; nothing is ever lost either way, because the cold part is read
/// with `crystal_read` and searched with `recall`.
///
/// A twin of `CrystalCap`, including that zero means the engine's default. It mounts UNDER
/// the page row, sharing the heading both of those built.
var CrystalHotCap = {
	/// The ladder offered, in kilobytes, bracketing the 16 KB default: this is the one
	/// figure a user pays on every request, and the rungs are meant to make that visible.
	STEPS: [4, 8, 16, 24, 32, 48],

	mount: function () {
		if (document.getElementById('cfg-crystal-hot-cap')) return true;
		var end = document.getElementById('limits-end');	// Settings > Limits
		var section = end && end.parentNode;
		if (!section) return false;
		// The data row carries the heading all three share.
		if (!CrystalCap.mount()) return false;
		var lab = document.createElement('label');
		lab.className = 'cfg-fieldlabel';
		lab.setAttribute('for', 'cfg-crystal-hot-cap');
		var sel = document.createElement('select');
		sel.className = 'settings-select';
		sel.id = 'cfg-crystal-hot-cap';
		var note = document.createElement('p');
		note.className = 'cfg-fieldnote';
		note.id = 'cfg-crystal-hot-cap-note';
		section.insertBefore(lab, end);
		section.insertBefore(sel, end);
		section.insertBefore(note, end);
		sel.addEventListener('change', function () { CrystalHotCap.save(sel.value); });
		return true;
	},

	/// The engine's own default, in kilobytes, and the ceiling it is enforcing now.
	///
	/// ASKED OF THE ENGINE, not read from `DEFAULT_CRYSTAL_HOT_KB`. That constant is a
	/// hand-kept copy of `tools::CRYSTAL_HOT_CAP_DEFAULT` and `dev/verify_crystalcap.mjs`
	/// compares the two files on disk -- which cannot see the case that actually bit: a
	/// page whose wasm is older than its JavaScript, enforcing a ceiling the pane is
	/// naming a newer figure for. On 2026-09-14 a crystal write was refused at 4096 bytes
	/// with no setting holding a 4, and there was nowhere to read what the engine thought.
	/// The copy is the fallback, for a build with no getter.
	engine: function () {
		var app = anyApp();
		var out = { def: DEFAULT_CRYSTAL_HOT_KB, force: 0 };
		if (!app) return out;
		try {
			if (typeof app.crystal_hot_cap_default === 'function') {
				var d = Math.round(app.crystal_hot_cap_default() / 1024);
				if (d > 0) out.def = d;
			}
			if (typeof app.crystal_hot_cap === 'function') {
				out.force = Math.round(app.crystal_hot_cap() / 1024);
			}
		} catch (e) { /* an older wasm has neither */ }
		return out;
	},

	render: function () {
		if (!this.mount()) return;
		var lab = document.querySelector('label[for="cfg-crystal-hot-cap"]');
		if (lab) lab.textContent = tOr('settings.crystal_hot_cap', 'Always-present part');
		var eng = this.engine();
		var hnote = document.getElementById('cfg-crystal-hot-cap-note');
		if (hnote) {
			hnote.textContent = tOr('settings.crystal_hot_cap_note',
				'How much of a diamond’s memory rides in every round; the rest is read on demand.');
			// THE CEILING ACTUALLY IN FORCE, said only when it is not the one this row
			// claims. Silence is the normal state; a sentence here means the engine and
			// the panel disagree, which is exactly what nothing could see on 2026-09-14.
			var want = (pg.cfg.crystalHotKb || 0) || eng.def;
			if (eng.force && eng.force !== want) {
				hnote.textContent += ' This app is enforcing ' + eng.force
					+ ' KB, not ' + want + ' KB — reload the page, and say so if it persists.';
			}
		}
		var sel = document.getElementById('cfg-crystal-hot-cap');
		sel.innerHTML = '';
		var mine = pg.cfg.crystalHotKb || 0;
		var steps = this.STEPS.slice();
		if (mine > 0 && steps.indexOf(mine) === -1) steps.push(mine);
		steps.sort(function (a, b) { return a - b; });
		var mk = function (value, label) {
			var o = document.createElement('option');
			o.value = String(value); o.textContent = label;
			sel.appendChild(o);
		};
		mk(0, tOr('settings.crystal_cap_auto', 'Default') + ' — ' + eng.def + ' KB');
		steps.forEach(function (n) { mk(n, String(n) + ' KB'); });
		sel.value = String(mine);
		if (sel.selectedIndex === -1) sel.value = '0';
	},

	save: function (raw) {
		var n = Math.max(0, Math.round(Number(raw) || 0));
		pg.cfg.crystalHotKb = n;
		var stored = readJson(CFG_KEY, {}) || {};
		stored.crystalHotKb = n;
		try { localStorage.setItem(CFG_KEY, JSON.stringify(stored)); }
		catch (e) { /* quota or unavailable — the choice holds for this session */ }
		applyCrystalCap(anyApp());
		this.render();
	},
};

/// How much of a diamond's FILE history it keeps, in bytes on disk.
///
/// The fourth row under the same heading, and the only one that bounds a store
/// rather than a document: the three above it say how large a crystal, its page
/// and its hot part may be, and this says how much of what a diamond's files USED
/// to be is kept beside them. Past it the oldest turns are pruned first and the
/// user's own saved versions last (contract §4), so raising it buys depth and
/// lowering it buys parcel.
///
/// A twin of `CrystalCap`, including that zero means the engine's default. The
/// setter is on the MODULE and not on an app: the ceiling belongs to the wasm
/// instance, the way the three above it do.
var VersionsCap = {
	/// The ladder offered, in kilobytes, bracketing the 1 MiB default.
	STEPS: [512, 1024, 2048, 4096],

	mount: function () {
		if (document.getElementById('cfg-versions-cap')) return true;
		var end = document.getElementById('limits-end');	// Settings > Limits
		var section = end && end.parentNode;
		if (!section) return false;
		// The data row carries the heading all four share.
		if (!CrystalCap.mount()) return false;
		var lab = document.createElement('label');
		lab.className = 'cfg-fieldlabel';
		lab.setAttribute('for', 'cfg-versions-cap');
		var sel = document.createElement('select');
		sel.className = 'settings-select';
		sel.id = 'cfg-versions-cap';
		var note = document.createElement('p');
		note.className = 'cfg-fieldnote';
		note.id = 'cfg-versions-cap-note';
		section.insertBefore(lab, end);
		section.insertBefore(sel, end);
		section.insertBefore(note, end);
		sel.addEventListener('change', function () { VersionsCap.save(sel.value); });
		return true;
	},

	render: function () {
		// Not drawn at all on a build whose engine has no file versions: a
		// ceiling on something that is not kept is a setting that lies.
		if (!(window.DaimondVersions && DaimondVersions.ready())) return;
		if (!this.mount()) return;
		var lab = document.querySelector('label[for="cfg-versions-cap"]');
		if (lab) lab.textContent = t('versions.cap_label');
		var vnote = document.getElementById('cfg-versions-cap-note');
		if (vnote) vnote.textContent = t('versions.machine_note');
		var sel = document.getElementById('cfg-versions-cap');
		sel.innerHTML = '';
		var mine = pg.cfg.versionsKb || 0;
		var steps = this.STEPS.slice();
		if (mine > 0 && steps.indexOf(mine) === -1) steps.push(mine);
		steps.sort(function (a, b) { return a - b; });
		var mk = function (value, label) {
			var o = document.createElement('option');
			o.value = String(value); o.textContent = label;
			sel.appendChild(o);
		};
		mk(0, tOr('settings.crystal_cap_auto', 'Default') + ' — 1024 KB');
		steps.forEach(function (n) { mk(n, String(n) + ' KB'); });
		sel.value = String(mine);
		if (sel.selectedIndex === -1) sel.value = '0';
	},

	save: function (raw) {
		var n = Math.max(0, Math.round(Number(raw) || 0));
		pg.cfg.versionsKb = n;
		var stored = readJson(CFG_KEY, {}) || {};
		stored.versionsKb = n;
		try { localStorage.setItem(CFG_KEY, JSON.stringify(stored)); }
		catch (e) { /* quota or unavailable — the choice holds for this session */ }
		applyVersionsCap();
		this.render();
	},
};

/// Put the user's version ceiling on the engine. Zero is the engine's own
/// default, which the setter already understands.
///
/// ON THE APP, NOT ON THE MODULE. `set_versions_cap` is a method of `DaimondApp`,
/// beside the crystal ceilings it belongs with -- `Wasm` is the module namespace and
/// has never carried it, so this asked a question that was always answered no and
/// the pulldown moved nothing.
///
/// # Arguments
/// * `given` - The app to set it through, when the caller holds one; the setting is the
///   wasm instance's, so any app will do. See `applyCrystalCap` for why it must be passed.
function applyVersionsCap(given) {
	try {
		var app = given || diamondApp();
		if (app && typeof app.set_versions_cap === 'function') {
			app.set_versions_cap((pg.cfg.versionsKb || 0) * 1024);
		}
	} catch (e) { /* an older wasm build has no setter */ }
}

/// How many files one turn may delete from the folder the user opened on this computer
/// before it stops and asks them (see `DaimondDeletes`). Theirs to set, because it trades
/// a question against a bulk delete on their own disk; eight until they do. The engine
/// holds it at sixty-four at most, where its own per-turn bound stops a turn anyway.
var DeleteAsk = {
	/// The rungs offered. Zero asks before every delete there.
	STEPS: [0, 1, 4, 16, 32, 64],

	mount: function () {
		if (document.getElementById('cfg-delete-ask')) return true;
		var end = document.getElementById('limits-end');	// Settings > Limits
		var section = end && end.parentNode;
		if (!section) return false;
		if (!VersionsCap.mount()) return false;
		var lab = document.createElement('label');
		lab.className = 'cfg-fieldlabel';
		lab.setAttribute('for', 'cfg-delete-ask');
		var sel = document.createElement('select');
		sel.className = 'settings-select';
		sel.id = 'cfg-delete-ask';
		section.insertBefore(lab, end);
		section.insertBefore(sel, end);
		sel.addEventListener('change', function () { DeleteAsk.save(sel.value); });
		return true;
	},

	render: function () {
		// Not drawn on an engine that cannot hold a turn's deletes for the person: a
		// setting for a question nothing asks is a setting that lies.
		var app = null;
		try { app = diamondApp(); } catch (e) { app = null; }
		if (!app || typeof app.set_open_deletes_ask !== 'function') return;
		if (!this.mount()) return;
		var lab = document.querySelector('label[for="cfg-delete-ask"]');
		if (lab) lab.textContent = t('deletes.ask_label');
		var sel = document.getElementById('cfg-delete-ask');
		sel.innerHTML = '';
		var mine = (typeof pg.cfg.deleteAskAfter === 'number') ? pg.cfg.deleteAskAfter : -1;
		var mk = function (value, label) {
			var o = document.createElement('option');
			o.value = String(value); o.textContent = label;
			sel.appendChild(o);
		};
		mk(-1, tOr('settings.crystal_cap_auto', 'Default') + ' \u2014 8');
		this.STEPS.forEach(function (n) { mk(n, n === 0 ? t('deletes.ask_every') : String(n)); });
		sel.value = String(mine);
		if (sel.selectedIndex === -1) sel.value = '-1';
	},

	save: function (raw) {
		var n = Math.round(Number(raw));
		if (!isFinite(n) || n < 0) n = -1;
		pg.cfg.deleteAskAfter = n;
		var stored = readJson(CFG_KEY, {}) || {};
		stored.deleteAskAfter = n;
		try { localStorage.setItem(CFG_KEY, JSON.stringify(stored)); }
		catch (e) { /* quota or unavailable — the choice holds for this session */ }
		applyDeleteAsk();
		this.render();
	},
};

/// Put the user's delete limit on the engine. -1 is the engine's own default.
///
/// # Arguments
/// * `given` - The app to set it through, as `applyVersionsCap` takes it.
function applyDeleteAsk(given) {
	try {
		var app = given || diamondApp();
		if (app && typeof app.set_open_deletes_ask === 'function') {
			app.set_open_deletes_ask(typeof pg.cfg.deleteAskAfter === 'number' ? pg.cfg.deleteAskAfter : -1);
		}
	} catch (e) { /* an older wasm build has no setter */ }
}

/// Put the user's crystal ceilings on the engine — all three of them.
///
/// One function for three settings, because they are one setting to a person: a crystal's
/// size is its data, its page, and how much of the data is in front of the model, and the
/// panel says so under one heading. Splitting the call up would give the three places that
/// build an agent three things to remember and one of them would eventually be forgotten.
///
/// The ceilings live in the wasm instance, not on an agent, so ANY app sets them for all of
/// them — they are applied wherever an agent is built only so that a page which has not
/// opened the settings panel still has them in force. Zero means the engine's own default,
/// which both setters already understand, so it is passed through rather than special-cased.
///
/// # Arguments
/// * `app` - Any DaimondApp; the setting is not that app's.
export function applyCrystalCap(app) {
	if (!app) return;
	// K4: the starter page a daimon is told to fork, put where it can read it. Once a page
	// load, and the engine writes only when the stored bytes differ.
	if (!applyCrystalCap.starter && typeof app.install_crystal_starter === 'function') {
		var C0 = crystalLib();
		if (C0 && C0.STARTER_PAGE) {
			applyCrystalCap.starter = true;
			try { app.install_crystal_starter(C0.STARTER_PAGE).catch(function () { applyCrystalCap.starter = false; }); }
			catch (e) { applyCrystalCap.starter = false; }
		}
	}
	if (typeof app.set_crystal_cap === 'function') {
		try { app.set_crystal_cap((pg.cfg.crystalKb || 0) * 1024); }
		catch (e) { /* an older wasm build has no setter */ }
	}
	if (typeof app.set_crystal_page_cap === 'function') {
		try { app.set_crystal_page_cap((pg.cfg.crystalPageKb || 0) * 1024); }
		catch (e) { /* an older wasm build has no setter */ }
	}
	// And the one that is actually paid per round: how much of a crystal rides in the
	// system message. The other two bound what the browser stores and syncs.
	if (typeof app.set_crystal_hot_cap === 'function') {
		try { app.set_crystal_hot_cap((pg.cfg.crystalHotKb || 0) * 1024); }
		catch (e) { /* an older wasm build has no setter */ }
	}
	// And the fourth of them, which is on the module rather than on an app --
	// it bounds the store, not a document.
	//
	// THROUGH THIS APP, NEVER A NEW ONE. `diamondApp` calls this before it files the app it
	// is building, so asking `diamondApp()` here missed the cache and built another, which
	// asked again: some six thousand apps a boot, ended only by a stack overflow. An overflow
	// that landed inside a wasm call left the wasm heap corrupt, and a later free of one of
	// those apps trapped with "memory access out of bounds" (2026-09-23).
	applyVersionsCap(app);
	// And what a turn may delete from the open folder before the person is asked,
	// which lives in the same wasm instance and is applied wherever the others are.
	applyDeleteAsk(app);
}

// The fold's model (Summarising) has no control of its own here since D-20261018-09 U4:
// it is a Job, drawn in Models beside Drafting. `setFoldPick` below stays its one setter,
// and `applyFoldSettings` applies it only to conversations on its own provider.

/// Both halves of how this app folds: which model writes the summary, and what
/// that model is told.
///
/// One function because they are one setting seen twice. `set_fold_model` had been
/// exposed on the wasm since folding was written and called by nothing, and
/// `prompts/compactor.md` was a file the app never opened -- so a conversation was
/// folded by the chat's own model under a prompt nobody could read. Applied wherever
/// `applyRoundLimit` is, so an app built at any of the four construction sites gets
/// both.
///
/// The MODEL id alone goes across: `Agent::summarise` swaps it into a clone of this
/// app's own client, so the fold travels on the key the conversation is already
/// using. A fold model from a different provider is therefore refused by the wire
/// rather than silently billed to the wrong balance -- which is why the picker below
/// offers only models of the provider the app is on.
/// Apply this model's own OpenRouter provider-routing preference, if it has one.
///
/// Read from the model's own row (`DaimondModels.routing`), parsed by
/// `DaimondModels.parseRouting` and handed to the engine, which sends it only when the
/// endpoint is actually OpenRouter -- see `LlmClient::set_provider_routing`. A model with
/// nothing set clears whatever a PREVIOUS app on this same client held, so switching from
/// a routed model to an unrouted one does not carry the old preference over.
export function applyProviderRouting(app, providerId, model) {
	if (!app || typeof app.set_provider_routing !== 'function') return;
	var text = '';
	try { text = DaimondModels.routing(providerId || '', model || ''); } catch (e) { /* no store yet */ }
	var r = DaimondModels.parseRouting(text);
	try {
		app.set_provider_routing(r.order.join(','), r.ignore.join(','), !!r.only);
	} catch (e) { /* an older wasm build has no setter */ }
}

/// The sentence for a picture the engine left out, by where its verdict came from.
///
/// `source` rides the engine's `unseeable` event: `provider` the provider's own model list
/// shows the model as text-only, `table` the engine's name table does, `refusal` the provider
/// turned a request with a picture away. An engine that predates the field sends none and gets
/// the older, plainer sentence. Literal keys, so the i18n check can see every one.
export function blindLine(model, source) {
	var a = { model: model || '' };
	if (source === 'provider') return t('agent.model_blind_provider', a);
	if (source === 'table')    return t('agent.model_blind_table', a);
	if (source === 'refusal')  return t('agent.model_blind_refusal', a);
	return t('agent.model_blind', a);
}

/// What a worker's tile says when the model the settings name now is not the one it started
/// on, or '' when they agree, when it moved of its own accord (the chip says so), or when it
/// is over: an old run is not annotated every time a setting changes.
export function configuredNow(run) {
	if (!run || !run.diamondId || !run.model || run._pinned) return '';
	if (run.status !== 'running' && run.status !== 'queued' && run.status !== 'paused') return '';
	if (run.reroutedFrom) return '';
	var set = null;
	try { set = run.sees ? diamondVisionModel(run.diamondId) : diamondWorkerModel(run.diamondId); }
	catch (e) { return ''; }
	if (!set || !set.model || set.model === run.model) return '';
	return t('agent.model_configured_now', { set: set.model, model: run.model });
}

/// Hand the engine the provider's own word on whether this model takes pictures.
///
/// `DaimondModels.sightFor` reads what the provider's `/models` reply said (true, false, or
/// null when it said nothing) and `set_sight` makes it outrank the engine's hand-written
/// name tables and a refusal. Without it a multimodal model those tables had never heard of
/// was told it "cannot be shown pictures" and the picture was stripped. Null travels as 0,
/// which leaves the tables in charge exactly as before. Applied wherever
/// `applyProviderRouting` is, so an app built at any construction site gets it.
export function applySight(app, providerId, model) {
	if (!app || typeof app.set_sight !== 'function') return;
	var s = null;
	try { s = DaimondModels.sightFor(providerId || '', model || ''); } catch (e) { /* no store yet */ }
	try {
		app.set_sight(s === true ? 1 : (s === false ? -1 : 0));
	} catch (e) { /* an older wasm build has no setter */ }
}

/// Hand the engine the chat's (or daimon's) chosen Effort, or '' for the model's own default.
///
/// Sent only when the provider's own model list offers that level for this model
/// (`DaimondModels.effortsFor`); anything else goes as '', so a stale level kept from another
/// model never reaches a provider that would refuse it. The engine sends `reasoning.effort`
/// only for the model it was chosen for. Applied wherever `applyProviderRouting` is.
export function applyEffort(app, providerId, model, effort) {
	if (!app || typeof app.set_reasoning_effort !== 'function') return;
	var f = null;
	try { f = DaimondModels.effortsFor(providerId || '', model || ''); } catch (e) { /* no store yet */ }
	var e = (effort && f && f.levels.indexOf(effort) >= 0) ? effort : '';
	try { app.set_reasoning_effort(e); } catch (x) { /* an older wasm build has no setter */ }
}

/// Choose what folds a conversation (Summarising): `''` for the conversation's own model.
export function setFoldPick(provider, model) {
	pg.cfg.foldModel    = model || '';
	pg.cfg.foldProvider = model ? (provider || '') : '';
	var stored = readJson(CFG_KEY, {}) || {};
	stored.foldModel = pg.cfg.foldModel; stored.foldProvider = pg.cfg.foldProvider;
	try { localStorage.setItem(CFG_KEY, JSON.stringify(stored)); }
	catch (e) { /* quota — the choice holds for this session */ }
	// Live, not on next construction: the setting is one call on an existing app,
	// so dropping every chat's agent to deliver it would throw away restored
	// sessions for nothing.
	// The engine's pair, not the record's: a following chat stores provider '', and
	// resolving Summarising on '' reset its engine to no fold model (QA B #3).
	pg.chats.forEach(function (c) {
		if (c.app) applyFoldSettings(c.app, (c._appPair || turnModelOf(c)).provider);
	});
	everyDiamondClient(function (app) {
		applyFoldSettings(app, _diamondAppProvider.get(app) || '');
	});
}
export function applyFoldSettings(app, provider) {
	if (!app) return;
	// WHERE it folds, before WHICH MODEL folds it. Zero is how "the user has not chosen"
	// travels, and `set_fold_at` leaves the engine's own figure alone on a zero — so the
	// default lives in one place, `compact::FOLD_AT`, rather than being restated here.
	try {
		if (typeof app.set_fold_at === 'function') app.set_fold_at(pg.cfg.foldAt || 0);
	} catch (e) { /* an older wasm build has no setter */ }
	// And the ceiling that fraction is held under, by the same rule: zero means the engine's
	// own figure, so `compact::ABSOLUTE_CAP` is named in one place and not restated here.
	try {
		if (typeof app.set_context_cap === 'function') {
			app.set_context_cap(pg.cfg.contextCap || 0);
		}
	} catch (e) { /* an older wasm build has no setter */ }
	// And what one TURN may spend, by the same rule. Not a fold setting, and put here anyway:
	// this is the one function every freshly built agent passes through, and a ceiling applied
	// on some paths and not others is a ceiling that does not hold.
	try {
		if (typeof app.set_spend_cap_usd === 'function') {
			app.set_spend_cap_usd(pg.cfg.spendCap || 0);
		}
	} catch (e) { /* an older wasm build has no setter */ }
	// AND THE COMPACTION KNOBS, which reach chat, daimon and worker apps alike because
	// `Workers.start` calls this function too -- and calls it BEFORE `set_worker_limits`, so a
	// tune that loosens the worker preset is in place by the time the ceiling is taken.
	// Only when there is one: `set_tune('')` is a no-op in the engine as well, and not
	// calling it at all is one less thing happening on every app that is built.
	//
	// A REFUSAL IS REPORTED RATHER THAN SWALLOWED. The string is hand-written -- by a trial
	// arm or by somebody at the console -- and a typo that silently leaves the defaults in
	// place is how a measurement comes to be a figure about the wrong engine.
	if (pg.cfg.tune) {
		try {
			if (typeof app.set_tune === 'function') app.set_tune(pg.cfg.tune);
		} catch (e) {
			try { console.warn('daimond: the tune was refused —', (e && e.message) || e); }
			catch (e2) { /* a console that will not take it is not worth a turn */ }
		}
	}
	// Same provider or nothing: `Agent::summarise` rides on the conversation's
	// own key, so a model id belonging to somebody else's endpoint is not a fold with
	// a different model — it is a request that fails, or one answered by whatever that
	// endpoint does with an unknown name.
	try {
		if (typeof app.set_fold_model === 'function') {
			app.set_fold_model(foldModelFor(provider));
		}
	} catch (e) { /* an older wasm build has no setter */ }
	try {
		if (typeof app.set_role_prompt === 'function') {
			app.set_role_prompt('compactor', (Prompts && Prompts.md.compactor) || '');
		}
	} catch (e) { /* an older wasm build does not know the role */ }
}

/// The model that folds a conversation on `provider`'s key, or '' for the conversation's own.
export function foldModelFor(provider) {
	var fold = window.DaimondModels
		? DaimondModels.effective({ kind: 'run', provider: provider || '' }, 'summarising')
		: { model: (pg.cfg.foldProvider || '') === (provider || '') ? (pg.cfg.foldModel || '') : '' };
	return (fold && fold.model) || '';
}

/// Any built agent, for a setting that is the engine's rather than an agent's.
function anyApp() {
	for (var i = 0; i < pg.chats.length; i++) { if (pg.chats[i] && pg.chats[i].app) return pg.chats[i].app; }
	return null;
}

/// The reply-length setting: how many tokens a single answer may run to.
///
/// Lives with the models, because it is a property OF the model — the ceiling
/// differs per model and the row says which one it is reading. Built here
/// rather than in the page, so it can name the resolved figure for whichever
/// model is starred and offer only the lengths that model will accept.
var ReplyLength = {
	/// The ladder offered, filtered by the starred model's ceiling. A value
	/// the user already holds is added even when it is off the ladder, so
	/// opening the panel never silently changes their setting.
	STEPS: [4096, 8192, 16384, 32768, 65536, 131072],

	/// Build the row once, into Settings > Limits.
	mount: function () {
		if (document.getElementById('cfg-max-tokens')) return true;
		var end = document.getElementById('limits-end');	// Settings > Limits
		var section = end && end.parentNode;
		if (!section) return false;
		var lab = document.createElement('label');
		lab.className = 'cfg-fieldlabel';
		lab.setAttribute('for', 'cfg-max-tokens');
		var sel = document.createElement('select');
		sel.className = 'settings-select';
		sel.id = 'cfg-max-tokens';
		var note = document.createElement('p');
		note.className = 'cfg-fieldnote';
		note.id = 'cfg-max-tokens-note';
		section.insertBefore(lab, end);
		section.insertBefore(sel, end);
		section.insertBefore(note, end);
		sel.addEventListener('change', function () { ReplyLength.save(sel.value); });
		return true;
	},

	/// Fill the pulldown for whichever model is starred, and say what it is.
	render: function () {
		if (!this.mount()) return;
		var lab = document.querySelector('label[for="cfg-max-tokens"]');
		if (lab) lab.textContent = tOr('settings.max_tokens', 'Longest reply');
		var sel = document.getElementById('cfg-max-tokens');
		var note = document.getElementById('cfg-max-tokens-note');
		var d = window.DaimondModels ? DaimondModels.getDefault() : { provider: '', model: '' };
		var model = d.model || pg.cfg.model || '';
		var ceil = maxOutCeiling(model, d.provider || '');
		var auto = autoMaxOut(model, d.provider || '');
		sel.innerHTML = '';
		var mk = function (value, label) {
			var o = document.createElement('option');
			o.value = String(value); o.textContent = label;
			sel.appendChild(o);
		};
		mk(0, tOr('settings.max_tokens_auto', 'Automatic') + ' — ' + fmtTok(auto));
		var steps = this.STEPS.filter(function (n) { return !ceil || n <= ceil; });
		// The user's own figure, when it is not one of the offered steps: an
		// unlisted value would otherwise be silently rewritten by the first
		// `change` the pulldown fires.
		var mine = pg.cfg.maxOut || 0;
		if (mine > 0 && steps.indexOf(mine) === -1) steps.push(mine);
		steps.sort(function (a, b) { return a - b; });
		steps.forEach(function (n) { mk(n, fmtTok(n) + ' ' + tOr('settings.tokens', 'tokens')); });
		sel.value = String(mine);
		if (sel.selectedIndex === -1) sel.value = '0';
		// The ceiling clause only when there IS one: naming the model and then
		// saying nothing about it reads as a sentence that lost its end.
		// The note is only that clause now (the sentence before it is cut, D-13).
		note.textContent = ceil ? model + ' ' + tOr('settings.max_tokens_ceiling', 'accepts up to')
			+ ' ' + fmtTok(ceil) + '.' : '';
		note.hidden = !ceil;
	},

	/// Record a choice and rebuild every agent, since `max_tokens` is frozen
	/// when a `DaimondApp` is constructed and nothing can change it after.
	///
	/// Only this field is written back. The in-memory `cfg` is a VIEW of
	/// whichever model is starred and carries the resolved key IN THE CLEAR,
	/// so persisting it wholesale would put a plaintext key into storage that
	/// `DaimondModels` had sealed.
	save: function (raw) {
		var n = Math.max(0, Math.round(Number(raw) || 0));
		pg.cfg.maxOut = n;
		var stored = readJson(CFG_KEY, {}) || {};
		stored.maxOut = n;
		try { localStorage.setItem(CFG_KEY, JSON.stringify(stored)); }
		catch (e) { /* quota or unavailable — the choice holds for this session */ }
		pg.chats.forEach(rebuildChatApp);
		resetDiamondApps();
		this.render();
	},
};

/// Take the user to the settings, wherever the settings currently are: the
/// lower pane of the rail, or — where there is no rail — a modal card. `add` opens the
/// add-a-provider form, as the source menu's "Add a provider…" asks.
export function openSettings(note, add) {
	// On a phone the rail is a fixed drawer, so `available()` is false and the
	// form opens in the modal; opening the drawer too would just flap behind it.
	if (!isMobile()) DaimondPanels.show('rail');   // a no-op if it is already open
	fillSettings();
	DaimondAdmin.settings(note);
	// The add-a-provider form is folded away unless there is nothing to show yet, or the
	// user was sent here BECAUSE there is no model: in either case the thing to do is add one.
	var form = document.getElementById('byok-form');
	var none = !window.DaimondModels || !DaimondModels.providers().length;
	if (form) form.style.display = (none || note || add) ? '' : 'none';
	if (form && form.style.display !== 'none') {
		var provEl = document.getElementById('cfg-provider');
		(provEl.value ? document.getElementById('cfg-api-key') : provEl).focus();
	}
}

/// The credits, which are not the models, and no longer share a form with them.
export function openCredits(note) {
	if (!isMobile()) DaimondPanels.show('rail');
	DaimondAdmin.credits(note);
}
// page-split: install 124
	// Auto-load the model list once a key (or a custom URL) is entered —
	// eagerly on input (debounced) so a user who pastes a key and clicks
	// Save straight away still gets a usable model, plus on change/blur.
	var _keyModelTimer = null;
// page-split: install 125
function paintAgentLensSwitch() {
	if (!agentLensBox) return;
	Array.prototype.forEach.call(agentLensBox.querySelectorAll('[data-lens]'), function (b) {
		b.setAttribute('aria-pressed', b.dataset.lens === pg.agentLens ? 'true' : 'false');
	});
}
// page-split: install 126
function applyToolsVisibility() {
	chatOutput.classList.toggle('hide-tools', toolsHidden);
	if (stepsBtn) stepsBtn.classList.toggle('dim', toolsHidden);
}
// page-split: install 127
/// Fold or unfold one leaf tile. The question is never folded — folding it
/// would leave nothing to read — and a Thinking tile a reader opens is marked
/// held so the live turn does not fold it back under them.
function foldTile(el, open) {
	if (!el || el.dataset.t === 'user') return;
	el.classList.toggle('collapsed', !open);
	if (el.dataset.t === 'think') el._held = true;
}
/// Open or close every tile in the thread. A non-solo rollup folds to its count
/// badge; a solo rollup has no chrome, so its single child is the tile to fold.
function setAllTilesOpen(open) {
	if (open) setAllTurnsOpen(true);
	var rolls = chatOutput.querySelectorAll('.crollup');
	for (var r = 0; r < rolls.length; r++) {
		var box = rolls[r];
		// The child bodies match the state either way, so reopening a folded
		// rollup shows its tiles folded rather than however they were left.
		var kids = box.querySelectorAll(':scope > .crollup-body > .ctile');
		for (var k = 0; k < kids.length; k++) foldTile(kids[k], open);
		// A solo rollup has no chrome — its child stands as the tile — so only a
		// real container is folded to its count badge.
		if (!box.classList.contains('solo')) box.classList.toggle('collapsed', !open);
	}
	var tops = chatOutput.querySelectorAll(':scope > .ctile');
	for (var i = 0; i < tops.length; i++) foldTile(tops[i], open);
	if (expandAllBtn) {
		expandAllBtn.classList.toggle('expanded', open);
		expandAllBtn.title = open ? tOr('chat.collapse_all_help', 'Collapse every tile')
			: tOr('chat.expand_all_help', 'Expand every tile');
	}
}
// page-split: install 128

/// One conversation as plain text, in the order it happened.
///
/// Tool steps are INCLUDED, named and with their result, because a transcript
/// pasted into a bug report without them shows an assistant asserting things
/// with nothing behind it -- which is exactly the reading somebody debugging
/// must not be given. They are marked as steps so a reader can skip them.
///
/// # Arguments
/// * `chat` - The conversation. A missing one yields the empty string, which
///   `copyToClipboard` rejects rather than reporting a copy of nothing.
function transcriptOf(chat) {
	if (!chat || !chat.messages || !chat.messages.length) return '';
	var out = [];
	out.push('# ' + chatDisplayName(chat));
	chat.messages.forEach(function (m) {
		var body = String(m.content == null ? '' : m.content).trim();
		switch (m.role) {
			case 'user':      out.push('\n## You\n\n' + body); break;
			case 'assistant': out.push('\n## Daimond\n\n' + body); break;
			// The outcome is named in the heading, because an exported transcript is
			// read away from the colours: a step that was REFUSED and one that ran are
			// otherwise the same heading over prose that may not say which it was.
			case 'tool_log':  out.push('\n### Step: ' + (m.name || '')
				+ (function () {
					var oc = m.outcome || outcomeOfStoredText(body);
					return oc === 'done' ? '' : ' \u2014 ' + oc;
				}()) + '\n\n'
				+ (m.args ? '`' + m.args + '`\n\n' : '') + body); break;
			// The app's own voice about the conversation -- a refusal, a limit
			// reached, a fan-out handover. Kept, because a transcript that silently
			// drops the reason a turn stopped misleads whoever reads it next.
			// A native runner's row carries its words as a key (`say`), its content empty.
			case 'error_log':
			case 'note_log':
			case 'cut_log':   out.push('\n> ' + logRowText(m).trim()); break;
			default: break;
		}
	});
	return out.join('\n').replace(/\n{4,}/g, '\n\n\n') + '\n';
}

/// The selected leaf tiles' text, top to bottom, for "Copy selected". Selection
/// is per-tile now, so a fully-ticked rollup contributes each of its children in
/// turn — the container itself carries no text of its own.
function selectedText() {
	var out = [];
	chatOutput.querySelectorAll('.ctile.sel').forEach(function (u) {
		var who = u.querySelector('.ctile-who');
		var body = u.querySelector('.ctile-body');
		var label = who ? who.textContent : '';
		out.push((label ? '## ' + label + '\n\n' : '') + (body ? body.innerText.trim() : ''));
	});
	return out.join('\n\n').trim();
}
// page-split: install 129

// ── The Wire: what actually goes to the model ──────────────
//
// The thread IS the payload, laid out once. Every request re-sends everything above it, so a
// view that reprinted each request in full would print the same conversation over and over --
// which is why this annotates the thread instead of standing beside it.
//
// What it turns on is the part that is normally invisible: the composed system message, which
// of it is the user's own and which was appended after their edits, the sentence naming the
// tools, the machine note derived from the fence, and the tool SCHEMAS -- several kilobytes on
// every single request that nobody has ever been shown.
//
// Composed by `Agent::system_parts`, which is the same function `run_turn` composes the real
// request with. A second assembly that agrees today is one that disagrees later, silently.
// ALWAYS ON (owner review 2026-09-04). The Wire toggle is gone; the System
// container is a permanent, collapsed-by-default tile at the head of the thread,
// so there is nothing to switch. Kept as a flag only so the mid-await staleness
// guards below read the same as they did.
var _wireOn = true;
// Which render is the current one. The getter awaits now -- it asks the hand for the
// machine note, exactly as the turn does -- so two renders can be in flight at once when a
// chat is switched mid-await, and the older one must not insert a second band under the newer.
var _wireSeq = 0;
// page-split: install 130
function wireTok(s) { return Math.round(_wireEnc.encode(String(s || '')).length / 4); }

/// One band of the system message, with whose it is said in the same breath as how big it is.
///
/// `tok` overrides the count for the one band whose DISPLAY is not what is sent: the schemas
/// are re-indented here to be readable, and the reader is owed the size of the bytes rather
/// than the size of the indenting.
function wireBand(label, why, help, text, tok) {
	// One part of the system message as a System tile. The whole system prompt is
	// a container of these (Role, Safety, Tools sent, schemas …), revealed by the
	// Wire control; each part its own collapsible tile. Warn-coloured, sent to the
	// model (right indent).
	var tile = buildTile('wire', {
		who:      label,
		meta:     fmtTok(tok == null ? wireTok(text) : tok),
		expanded: false,
		copy:     String(text || ''),
	});
	// The one-word "why" and the sentence behind it go on hover — the bar itself
	// stays scannable, with the content preview to its right.
	tile._lbl.title = (why ? why + (help ? ' — ' + help : '') : (help || ''));
	var body = document.createElement('pre');
	body.className = 'wire-band-body';
	// textContent, never innerHTML: this is the raw payload, and some of it is written by a
	// stranger whose page a turn read. It is shown, not run.
	body.textContent = String(text || '');
	tile._body.appendChild(body);
	tilePeek(tile, String(text || ''));
	return tile;
}

/// Draw the band at the head of the thread, or take it away.
/// Take the System band down. The ONE place that removes it, so every path that
/// ends with no band reads the same and no path removes it by accident.
function dropWire() {
	var old = document.getElementById('wire-head');
	if (old) old.remove();
}

export async function renderWire() {
	// THE BAND IS NOT TAKEN DOWN BEFORE ITS REPLACEMENT EXISTS.
	//
	// It sits at the HEAD of the thread, so removing it takes its height out of
	// the transcript ABOVE whatever the reader is looking at -- and this function
	// then awaits the engine for the composed system message. Until 2026-09-14 the
	// removal was the first line here, so every scroll write `renderHistory` makes
	// in that window (the pin for a reader at the live end, the restore for one
	// scrolled up) was made against a thread one band too short, and when the band
	// came back the reader was that far from where they had been. Measured on a
	// pull that changed NOTHING: a reader at the live end ended 36px above it,
	// every single pull -- the "syncs scroll the chat a little" the owner reported.
	//
	// So the standing band keeps its place across the await, and only the paths
	// that end with NO band take it down. The one that must NOT is the staleness
	// guard below: there a NEWER render owns the band, and removing it would be
	// this render tearing down its successor's work.
	if (!_wireOn || !pg.current) { dropWire(); return; }
	// WHICH TURN THIS THREAD ACTUALLY RUNS. A Diamond's chat uses this composer and this
	// thread and NOT this turn: `sendUserMessage` hands a record carrying a `diamondId` to
	// `doSteer`, which steers the DIAMOND'S own app through `steer_crystal` -- its own model,
	// the daimon's tools, the daimon's system message. Reading the chat app here was the whole
	// of the defect: the band showed a Diamond's owner 28 tools including `say` and the nine
	// web tools, while the daimon in front of him held 17 and none of those -- and showed it
	// to him while he was asking why it never used one.
	var did = (pg.current.diamondId || '');
	var app;
	// A CHAT THAT HAS NOT LOADED HAS NO BAND YET. Opened from the rail, a summary-only chat draws an empty thread
	// "until the row lands", and this call BUILT AN ENGINE from it: the model then held none of the chat, and the
	// session the next turn stored kept it that way. The band is drawn again when the transcript arrives.
	if (!did && pg.current._loaded === false) { dropWire(); return; }
	try { app = did ? daimonApp(did) : ensureApp(pg.current); } catch (e) { dropWire(); return; }
	// Two doors: a Diamond's thread is `wire_system(id, ...)`, a chat's own conversation is
	// `wire_chat_system()`. An empty id at the first is refused, never read as "a chat".
	if (!app || typeof (did ? app.wire_system : app.wire_chat_system) !== 'function') { dropWire(); return; }
	// The toolkits ticked on this Diamond, from the same `Files.bounds` the turn reads them
	// from. The marks are the engine's to read, for the band as for the turn (HIST-SAFE U2),
	// so the two cannot come to different ideas of what is attached.
	var marks = { toolkits: [] };
	if (did) {
		try { marks = await Files.bounds(did); }
		catch (e) { marks = { toolkits: [] }; }
	}
	var seq = ++_wireSeq;
	var w;
	try {
		// Composed on a snapshot of the app's registry, so a turn starting meanwhile
		// neither waits for it nor is refused by it (U1 ACTOR).
		w = JSON.parse(await (did
			// The conversation the next steer starts from, as `doSteer` lays it, so the turn
			// note drawn is the one that turn sends: only what changed since its last copy.
			? app.wire_system(did, JSON.stringify(marks.toolkits  || []), daimonPrior(pg.current))
			: app.wire_chat_system()));
	} catch (e) { dropWire(); return; }
	// Still the thread this render was started for, and still wanted. Re-read rather than
	// assumed: everything above this line may have happened while the user was moving.
	if (seq !== _wireSeq || !_wireOn || !pg.current || (pg.current.diamondId || '') !== did) return;
	var stale = document.getElementById('wire-head');
	if (stale) stale.remove();

	// The System prompt is a container of System tiles — a rollup with a count,
	// collapsed by default, sitting at the head of the thread. It IS the tile now:
	// there is no outer box and no caption above it (owner review 2026-09-04). The
	// "about N tokens" the caption used to carry moves into the header, beside the
	// count, so the one line reads "System · 6 · parts · 17k".
	var group = makeRollup('wire', { dataset: {} });
	group.id = 'wire-head';
	var sysTok = wireTok(w.role) + wireTok(w.tools_sentence) + wireTok(w.machine);
	// INDENTED TO BE READ, COUNTED AS IT IS SENT. The request carries the schemas with no
	// whitespace at all; this copy is spaced out so a person can find their way through it,
	// which for the browser toolbelt adds about four thousand characters -- a thousand
	// tokens, an eighth of the figure. Counting the copy was the band overstating the one
	// number anybody quotes from it, and this band's whole claim is that it does not do that.
	// `schemas_len` is the length the engine measured of the string it puts in the request.
	var schemas = JSON.stringify(w.schemas || [], null, 1);
	var schemaTok = Math.round((w.schemas_len || 0) / 4);

	// The role prompt and what is appended to it are ONE string on the wire and two facts to
	// a reader: the first is theirs to rewrite, the second is not. Split on the clause's own
	// heading, which is where `Role::compose` joins them.
	// A daimon's system message carries a paragraph that is true of THIS Diamond on THIS turn
	// and of no other -- its folder, what the paperclip has attached, and its crystal as it
	// stands. It is taken out of the blob before the blob is split, so that a Diamond's
	// crystal is not filed under "Safety clause". It is a SUBSTRING of the role rather than an
	// addition to it, so the token figures above have counted it exactly once already.
	var role = String(w.role || ''), local = String(w.local || ''), standing = '';
	var at = local ? role.indexOf(local) : -1;
	if (at >= 0) role = role.slice(0, at) + role.slice(at + local.length);
	// The user's own house rules (DAIMOND.md), which are appended AFTER everything the app
	// composes and are therefore the tail of the blob. Cut out for the same reason the safety
	// clause is: they are the reader's own writing and the rest is not. Without this they were
	// drawn inside a band headed "Safety clause", and on a Diamond -- where the paragraph
	// above sits between the clause and them -- the two halves of that band would have been
	// text that never stood together in the message at all.
	var std = role.indexOf('## Standing instructions from the user');
	if (std > 0) { standing = role.slice(std); role = role.slice(0, std); }
	var cut = role.indexOf('## Rules that always apply');
	if (cut > 0) {
		group._body.appendChild(wireBand(t('wire.role'), t('wire.role_why'), t('wire.role_help'), role.slice(0, cut).trim()));
		group._body.appendChild(wireBand(t('wire.safety'), t('wire.safety_why'), t('wire.safety_help'), role.slice(cut).trim()));
	} else {
		group._body.appendChild(wireBand(t('wire.role'), t('wire.role_why'), t('wire.role_help'), role));
	}
	if (local) {
		group._body.appendChild(wireBand(t('wire.diamond'), t('wire.diamond_why'), t('wire.diamond_help'), local));
	}
	if (standing) {
		group._body.appendChild(wireBand(t('wire.standing'), t('wire.standing_why'), t('wire.standing_help'),
			standing.trim()));
	}
	if (w.tools_sentence) {
		group._body.appendChild(wireBand(t('wire.tools'), t('wire.tools_why'), t('wire.tools_help'), w.tools_sentence));
	}
	// THIS COMPUTER is two texts on the wire: the model note, in the system message, and the
	// machine note, which rides in the turn note (r578) whenever it changed. The engine names
	// the second as the note carries it (`machine_note`), so it is drawn here, under the band
	// that says what it is, and cut from the note's band: each byte sent is drawn once (r578b A4).
	var mnote = String(w.machine_note || ''), note = String(w.note || '');
	var mat = mnote ? note.indexOf(mnote) : -1;
	if (mat >= 0) note = (note.slice(0, mat) + note.slice(mat + mnote.length)).replace(/\n{3,}/g, '\n\n').trim();
	else mnote = '';
	var machine = [String(w.machine || ''), mnote].filter(Boolean).join('\n\n');
	if (machine) {
		group._body.appendChild(wireBand(t('wire.machine'), t('wire.machine_why'), t('wire.machine_help'), machine));
	}
	// THE TURN'S NOTE (r578): what changes from turn to turn rides with the person's message,
	// not in the system message, so it is drawn apart from the bands above it.
	if (note) {
		group._body.appendChild(wireBand(t('wire.note'), t('wire.note_why'), t('wire.note_help'), note));
	}
	group._body.appendChild(wireBand(
		t('wire.schemas', { n: (w.names || []).length }), t('wire.schemas_why'),
		t('wire.schemas_help'), schemas, schemaTok));
	rollUpdate(group);
	// The token total rides in the header, after the noun: "System · 6 · parts · 17k".
	if (group._noun) group._noun.textContent = group._noun.textContent + ' · ' + fmtTok(sysTok + schemaTok);
	// AND NOTHING ELSE ON THE LINE. `rollUpdate` fills the peek with the first three
	// children's names -- "Role prompt · Safety clause · This Diamond" -- which turned the
	// one thing standing above a user's first message into a list of internals they had
	// no way to read (audit CHAT-03). The band is one muted line now, and the names are
	// inside it where they belong. It is drawn only in the Detailed view: see
	// `#wire-head` in css/app.css.
	if (group._peek) group._peek.textContent = '';
	// The System container is present on every thread now (there is no Wire toggle),
	// so it stays COLLAPSED by default — one quiet line at the head, opened on click.
	chatOutput.insertBefore(group, chatOutput.firstChild);
}
// page-split: install 131

export function install() { // page-split: install
	// page-split: install 123
	window.addEventListener('daimond:authed', function () { doorbellNotice(); });
	// page-split: install 124

	// The guide: a real site at /guide, shown in the Web panel. Reachable from the header ? at all
	// times, so a newcomer is never more than one click from the tour — which is why the chat
	// panel no longer needs to carry its own welcome copy.
	/* var */ guideBtn = document.getElementById('guide-btn');
	if (guideBtn) guideBtn.addEventListener('click', function () {
		if (window.DaimondWeb && DaimondWeb.guide) DaimondWeb.guide();
		else window.open('guide/', '_blank');       // no web module: the guide still stands alone
	});

	// The Social panel's circled "i", on the same route and with the same
	// fallback -- one page of the guide rather than its front. Wired here, beside
	// the header's own guide button, because this is where the app's routes into
	// the guide are kept; js/improve.js owns what the panel DOES and this button
	// does nothing to a note.
	//
	// `social.html`, which is the page about THIS panel: what a note is, what
	// happens when one is sent, and what a vote does. It pointed at
	// `interface.html` -- the tour of the whole frame, which mentions the panel in
	// passing -- so the one control a reader presses when they want to know what
	// the Social panel is put them somewhere else, and the page written for the
	// question was reachable only from the guide's own navigation.
	/* var */ impInfo = document.getElementById('social-info');
	if (impInfo) impInfo.addEventListener('click', function () {
		if (window.DaimondWeb && DaimondWeb.guide) DaimondWeb.guide('social.html');
		else window.open('guide/social.html', '_blank');
	});

	// About: what this is, which build you are running, and who made it. It sits
	// beside the guide because the two are the same kind of question.
	/* var */ aboutBtn = document.getElementById('about-btn');
	if (aboutBtn) aboutBtn.addEventListener('click', function () { openAbout(); });
	document.getElementById('byok-save').addEventListener('click', async function () {
		hideSecret(document.getElementById('cfg-api-key'));
		var next = {
			baseUrl: document.getElementById('cfg-base-url').value.trim(),
			apiKey: getSecret(document.getElementById('cfg-api-key')).trim(),
			apiKeyEnc: '',
			model: currentModel(),
			maxOut: pg.cfg.maxOut || 0,	// 0 = Auto; the knob is in the Models panel
			tools: true,	// tools are on by default; no user-facing toggle
		};
		// Validate before saving — never report success on an unusable config.
		var note = document.getElementById('byok-note');
		if (!document.getElementById('cfg-provider').value) { note.textContent = t('byok.err_provider'); return; }
		if (!next.baseUrl) { note.textContent = t('byok.err_base_url'); return; }
		// PRESENT is not the same as USABLE. The shape was never checked, so a typed
		// address like "htp://api.x/v1" got as far as trying to list models from it,
		// failed, and the refusal that reached the user read "Choose a model, or wait
		// a moment for the list to load" — naming the one box they had got right.
		if (!/^https?:\/\/[^\s/?#]+\.?(:\d+)?(\/|$)/i.test(next.baseUrl)) {
			note.textContent = t('byok.err_bad_url');
			document.getElementById('cfg-base-url').focus();
			return;
		}
		if (!next.apiKey) { note.textContent = t('byok.err_key'); document.getElementById('cfg-api-key').focus(); return; }
		// Fall back to the provider's default model if the live list has not
		// loaded (it shows "Loading…" with an empty value) so a quick save is
		// never stuck for a curated provider.
		if (!next.model) {
			var _pv = document.getElementById('cfg-provider').value;
			if (PROVIDERS[_pv] && PROVIDERS[_pv].model) next.model = PROVIDERS[_pv].model;
		}
		if (!next.model) { note.textContent = t('byok.err_model'); return; }
		// The provider has already answered 401/403 to this very key while loading
		// its models. Reporting it "Saved." and lighting the connected padlock
		// would be a lie the first real turn exposes, so refuse it here.
		var wantNow = document.getElementById('cfg-provider').value + ' ' + next.baseUrl + ' ' + next.apiKey;
		if (_keyRejectedFor && wantNow === _keyRejectedFor) {
			note.textContent = t('byok.err_rejected');
			document.getElementById('cfg-api-key').focus();
			return;
		}
		// The provider joins the others rather than replacing them: a second key does not evict
		// the first, which is the whole point of holding more than one.
		var pid = document.getElementById('cfg-provider').value;
		if (pid === 'custom') pid = 'custom:' + next.baseUrl;
		DaimondModels.addProvider(pid, { url: next.baseUrl });
		await DaimondModels.setKey(pid, next.apiKey);
		DaimondModels.setDefault(pid, next.model);
		// Ask it what else it can run, so the list is populated for the picker. A provider that
		// will not answer still works — the model just chosen is already known to be good.
		try { await DaimondModels.fetchModels(pid); } catch (e) { /* the chosen model still stands */ }

		syncCfgFromModels();
		note.textContent = t('files.saved');
		// New settings imply fresh app instances for existing chats and
		// for every Diamond app built on the old key.
		pg.chats.forEach(rebuildChatApp);
		resetDiamondApps();
		// A form that has done its job leaves. The confirmation is not a word in
		// a box that stays open — it is the status header now naming the model
		// Daimond is running on.
		DaimondModels.render();
		// The starred model may have changed, and with it the ceiling the
		// reply-length row reads and the figure Automatic resolves to.
		renderLimitRows();
		var f = document.getElementById('byok-form');
		if (f) f.style.display = 'none';
		DaimondAdmin.status();
	});
		// Picking a provider fills the base URL (Custom exposes the raw field)
		// and refreshes the model list.
		document.getElementById('cfg-provider').addEventListener('change', function () {
			applyProviderChoice(this.value, false);
			// Seed the provider's default model immediately so the form is
			// savable without waiting on the async list fetch; fetchModels then
			// enriches it. This keeps onboarding from stalling on a slow list.
			var def = PROVIDERS[this.value] && PROVIDERS[this.value].model;
			if (def) setModelOptions([{ value: def, label: def }, { value: MODEL_OTHER, label: t('models.other') }], def);
			fetchModels();
		});
	// page-split: install 125
		document.getElementById('cfg-api-key').addEventListener('input', function () {
			clearTimeout(_keyModelTimer);
			_keyModelTimer = setTimeout(fetchModels, 500);
		});
		document.getElementById('cfg-api-key').addEventListener('change', function () { fetchModels(); });
		document.getElementById('cfg-base-url').addEventListener('change', function () { fetchModels(); });
		// Reveal the manual model box only when "Other…" is chosen.
		document.getElementById('cfg-model').addEventListener('change', syncModelCustom);
		if (window.DaimondModels) DaimondModels.picker(document.getElementById('cfg-model'));
		// THE PER-CHAT MODEL LIVES ON THE CHAT TILE, and the header selector that
		// used to hold it is gone -- markup, listener and the function that kept
		// it hidden. It shipped with `display:none`, the only code that touched
		// its display set `none` unconditionally, and nothing ever put an option
		// in it, so this listener could not fire; it nonetheless cleared
		// `current.app`, which is how a control nobody can reach still reads as a
		// route somebody might wire up. See `www/index.html`, where the `<select>`
		// was.

	// ── Input wiring ───────────────────────────────────────────
	// Grow with the content up to ~12 lines (the CSS max-height); past that it
	// scrolls, with a hover-only scrollbar.
	chatInput.addEventListener('input', function () {
		fitComposer();
		// Mid-turn the button's meaning follows the box: empty it means Stop, with
		// a correction in it it means send that correction into the turn.
		syncSendMode();
	});
	// QA round 2, M1c: refit the moment the box itself changes shape, not only
	// on the next keystroke. A hidden composer's content box is empty, so this
	// fires exactly when a hidden chat is shown again -- the case a click
	// handler at every one of its show paths would have to be found for --
	// and it fires again when a panel resize narrows the field enough to wrap
	// another line. `fitComposer` is idempotent once the box has actually
	// settled, so the extra call the WRITE below causes is one cheap no-op,
	// never a loop: the box does not change size a second time for the same
	// content, and ResizeObserver only re-fires when it does.
	if (typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(fitComposer).observe(chatInput);
	}
	chatInput.addEventListener('keydown', function (e) {
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeSkillMenu(); sendUserMessage(); }
	});
	// A `/` alone in an empty box asks what there is. Anything after it is a
	// command being typed, or a path, and the menu gets out of the way.
	chatInput.addEventListener('input', function () {
		if (chatInput.value === '/') openSkillMenu();
		else closeSkillMenu();
		// An edit ABANDONED. `editResend` leaves a note saying which turn Send
		// replaces; emptying the box is how somebody takes that back, and without
		// this the note would attach itself to whatever they typed next.
		if (pg.current && pg.current._editing && !chatInput.value.trim()) pg.current._editing = null;
	});
	// The same act as the send button in stop mode, through the same function, so
	// the two controls cannot come to mean different things.
	if (chatStop) chatStop.addEventListener('click', function () { stopGeneration(); });
	bindSend();
	newSessionBtn.addEventListener('click', newChat);
	/* var */ chatsMenuBtn = document.getElementById('chats-menu-btn');
	if (chatsMenuBtn) chatsMenuBtn.addEventListener('click', function (e) {
		e.stopPropagation();		// same defensive habit `fold`'s own click handler wears
		openChatsMenu(chatsMenuBtn);
	});
	if (newDiamondBtn) newDiamondBtn.addEventListener('click', createDiamond);
	// The two faces of a Diamond. Each remembers itself per Diamond, so going back to
	// one you were reading the conversation of puts you back in the conversation.
	/* var */ pendSort = document.getElementById('pending-sort');
	if (pendSort) {
		try { pendSort.value = localStorage.getItem(PENDING_KEY + '-sort') || 'priority'; }
		catch (e) { /* default */ }
		pendSort.addEventListener('change', function () {
			try { localStorage.setItem(PENDING_KEY + '-sort', pendSort.value); }
			catch (e) { /* it holds for this session */ }
			Pending.render();
		});
	}
	['crystal', 'chat'].forEach(function (which) {
		var b = document.getElementById('dview-' + which);
		if (!b) return;
		b.addEventListener('click', function () {
			if (!pg.currentDiamond) return;
			selectDiamond(pg.currentDiamond, which);
		});
	});
	// Full screen for the crystal face. A press, and nothing else -- see
	// `setCrystalFull` for why that sentence is load-bearing.
	/* var */ crystalFullBtn = document.getElementById('crystal-full-btn');
	if (crystalFullBtn) crystalFullBtn.addEventListener('click', function () {
		setCrystalFull(!crystalFull);
		// The focus stays on the control, which is now the way back: a keyboard
		// user who has just covered the app has Escape AND Enter without moving.
		try { crystalFullBtn.focus(); } catch (e) { /* gone from the page */ }
	});
	// ESCAPE LEAVES IT, from wherever the app holds the focus -- and NOT in the
	// bubble of something else's Escape. This listener is deliberately not in the
	// capture phase: every dialog in the app installs a capture handler when it
	// opens, and a capture listener registered here at start-up would run before
	// all of them and pull the mode out from under a dialog the user was
	// answering. Bubbling, plus `defaultPrevented` (the stack's router marks every
	// Escape it acts on), plus `overlayUp` for a surface it does not hold, is the
	// whole rule.
	document.addEventListener('keydown', function (e) {
		if (e.key !== 'Escape' || !crystalFull) return;
		if (e.defaultPrevented || overlayUp()) return;
		e.preventDefault();
		setCrystalFull(false);
		var b = document.getElementById('crystal-full-btn');
		if (b) { try { b.focus(); } catch (err) { /* gone from the page */ } }
	});
	/* var */ linkGraphBtn = document.getElementById('link-graph-btn');
	if (linkGraphBtn) linkGraphBtn.addEventListener('click', function () {
		// A toggle, not an opener. Pressing the same button again is how a person
		// puts a panel away, and this one only ever opened: the way to close the
		// Graph was to find its own closer, which is a different control in a
		// different place from the one that summoned it.
		//
		// On a phone "open" is not "on screen" — a panel can be open in the engine
		// while another is the one in the sheet — so an open Graph the user is not
		// looking at is brought forward rather than closed, which is what pressing
		// its button means there.
		//
		// ASKED OF THE SHEET, because that is where the Graph rises. This used to
		// read `document.body.dataset.mpanel === 'graph'`, a value nothing can set
		// and no stylesheet can match: written as though a mobile Graph
		// destination existed, when the panel had none at all and asking for it
		// blanked the screen. See `MOBILE_GUESTS`.
		var showing = !isMobile()
			|| !!(window.DaimondSheet && DaimondSheet.guest() === 'graph');
		if (DaimondPanels.isOpen('graph') && showing) { DaimondPanels.hide('graph'); return; }
		DaimondPanels.show('graph');
		// Showing an already-open panel changes no attribute, so ask for the
		// redraw explicitly rather than relying on the visibility observer.
		if (window.DaimondGraph) DaimondGraph.refresh();
	});
	if (agentSearch) agentSearch.addEventListener('input', function () {
		pg.agentQuery = agentSearch.value.trim().toLowerCase();
		Workers.render();
	});
	if (diamondSearch) {
		diamondSearch.addEventListener('input', function () {
			var was = pg.diamondQuery;
			setDiamondQuery(diamondSearch.value);
			if (pg.diamondQuery !== was) renderDiamondList();
		});
		// Escape in the field clears it, and goes no further: the same press must not
		// also close the drawer the rail sits in on a phone. A claim held for the
		// page's life, like the link form's; it declines unless the keyboard is in the
		// field and the field holds text, so an empty field lets Escape through.
		// The third argument says the same thing with no effect (R2): it is how a layer
		// opening above the field while focus stays in it knows to take Escape first.
		/* var */ railSearchLive = function () {
			return document.activeElement === diamondSearch && !!diamondSearch.value;
		};
		DaimondLayers.claim('railsearch', function () {
			if (!railSearchLive()) return false;
			setDiamondQuery('');
			renderDiamondList();
		}, railSearchLive);
	}
	// The lens: only the grid's colours change, so only the grid is drawn again.
	/* var */ agentLensBox = document.getElementById('agents-lens');
	// page-split: install 126
	if (agentLensBox) {
		paintAgentLensSwitch();
		agentLensBox.addEventListener('click', function (e) {
			var b = e.target.closest && e.target.closest('[data-lens]');
			if (!b || b.dataset.lens === pg.agentLens) return;
			pg.agentLens = b.dataset.lens;
			try { localStorage.setItem(AGENT_LENS_KEY, pg.agentLens); } catch (er) { /* kept for this page */ }
			paintAgentLensSwitch();
			renderAgentGrid();
		});
	}
	/* var */ agentsClearBtn = document.getElementById('agents-clear');
	if (agentsClearBtn) agentsClearBtn.addEventListener('click', function () { Workers.clearFinished(); });
	/* var */ agentsPauseBtn = document.getElementById('agents-pause');
	if (agentsPauseBtn) agentsPauseBtn.addEventListener('click', function () { Workers.pauseAll(); });
	/* var */ agentsPlayBtn = document.getElementById('agents-play');
	if (agentsPlayBtn) agentsPlayBtn.addEventListener('click', function () { Workers.resumeAll(); });
	/* var */ agentsStopBtn = document.getElementById('agents-stop');
	if (agentsStopBtn) agentsStopBtn.addEventListener('click', function () { Workers.stopAll(); });

	// Show/hide tool blocks in the thread.
	/* var */ toolsHidden = localStorage.getItem('daimond-hide-tools') === '1';
	/* var */ stepsBtn = document.getElementById('steps-toggle-btn');
	// page-split: install 127
	if (stepsBtn) stepsBtn.addEventListener('click', function () {
		toolsHidden = !toolsHidden;
		localStorage.setItem('daimond-hide-tools', toolsHidden ? '1' : '0');
		applyToolsVisibility();
	});
	applyToolsVisibility();

	// ── Expand / collapse every tile at once ───────────────────
	//
	// A dedicated header icon, independent of the "−" beside it: that one latches
	// select mode and folds whole ANSWERS (setSelectMode); this opens or closes the
	// bodies of every TILE — Thinking, Tool, System and their rollups — so a reader
	// can take the whole working in or fold it away in one press. It extends the
	// dead `setAllTurnsOpen` helper with the tile bodies it never reached.
	/* var */ expandAllBtn = document.getElementById('expand-all-btn');
	// page-split: install 128
	if (expandAllBtn) expandAllBtn.addEventListener('click', function () {
		// If anything is folded, expand; otherwise collapse. Read from the DOM so a
		// re-render between presses cannot leave the toggle out of step.
		var anyCollapsed = !!chatOutput.querySelector(
			'.crollup:not(.solo).collapsed, .ctile.collapsed:not([data-t="user"])');
		setAllTilesOpen(anyCollapsed);
	});

	// ── The whole conversation, out ────────────────────────────
	//
	// Plain text and not the rendered HTML: what this is FOR is carrying a
	// conversation somewhere else -- a bug report, a handover, another model --
	// and every one of those destinations wants the words. Markdown survives
	// because the assistant wrote markdown; the thread's own decorations do not,
	// because they are this app talking about the conversation rather than part
	// of it.
	/* var */ copyAllBtn = document.getElementById('chat-copy-btn');
	// page-split: install 129

	if (copyAllBtn) copyAllBtn.addEventListener('click', function () {
		// In select mode this button copies what is ticked, not the whole chat.
		if (chatOutput.classList.contains('selecting')) {
			var picked = selectedText();
			if (!picked) { toast(tOr('chat.copy_none', 'Nothing selected'), true); return; }
			var wasSel = copyAllBtn.innerHTML;
			copyToClipboard(picked).then(function () {
				copyAllBtn.innerHTML = TICK_SVG; copyAllBtn.classList.add('done');
				setTimeout(function () { copyAllBtn.innerHTML = wasSel; copyAllBtn.classList.remove('done'); }, 1600);
			}, function () { toast(t('chat.copy_all_failed'), true); });
			return;
		}
		var text = transcriptOf(pg.current);
		if (!text) { toast(t('chat.copy_all_empty'), true); return; }
		// A TICK, not the word. The button is a drawing now, and writing "Copied" into it would
		// replace the icon with text and restore an empty string afterwards -- a control that
		// works once and then disappears. `addMsgCopy` has flashed a tick since the thread had
		// copy buttons; this is the same gesture on the same clipboard.
		var was = copyAllBtn.innerHTML;
		copyToClipboard(text).then(function () {
			copyAllBtn.innerHTML = TICK_SVG;
			copyAllBtn.classList.add('done');
			sayQuietly(t('chat.copy_all_said'));
			setTimeout(function () {
				copyAllBtn.innerHTML = was;
				copyAllBtn.classList.remove('done');
			}, 1600);
		}, function () {
			// `copyToClipboard` already tried the select-and-copy fallback, so
			// reaching here means both routes were refused. Saying so is the only
			// honest ending: a button that reports success it did not have is worse
			// than one that admits it.
			toast(t('chat.copy_all_failed'), true);
		});
	});
	// page-split: install 130

	/// Roughly how many tokens a band is: four bytes each, which is wrong for code and for CJK
	/// and close enough for a size the reader is using to decide whether to look.
	///
	/// BYTES AND NOT CHARACTERS, and the difference is the whole point. A request body is
	/// UTF-8, and every size the engine keeps is a Rust `.len()` over that encoding --
	/// `compact::msg_bytes`, the fold's own budget, and the `schemas_len` the schema band
	/// below is drawn from. A JavaScript string's `.length` is UTF-16 code units, so one em
	/// dash is three there and one here. Measured that way, the five text bands were drawn in
	/// characters, the schema band beside them in bytes, and the headline added the two
	/// together and called the sum tokens. The gap is small -- 50 bytes in 8,455 of system
	/// message -- and it is not the size of it that matters: a band whose claim is that it is
	/// the sent bytes has to be measuring bytes, or the claim is decoration.
	/* var */ _wireEnc = new TextEncoder();
	// page-split: install 131

	// The Wire button was removed (owner review 2026-09-04): the System container is
	// always present and collapsible, so a control to reveal it was redundant. Its
	// handler is gone with it; `renderWire` runs on every chat render.

	/* var */ conciseChip = document.getElementById('concise-chip');
	if (conciseChip) conciseChip.addEventListener('click', function () { toggleConcise(); });
	/* var */ chatFoldBtn = document.getElementById('chat-fold-btn');
	if (chatFoldBtn) chatFoldBtn.addEventListener('click', function () {
		// A Diamond's chat folds into its OWN Diamond — the destination is fixed
		// (the Diamond this chat belongs to), so there is no target-picker. This is
		// the only chat the button is shown on (see syncFoldBtn).
		if (pg.current && pg.current.diamondId) foldChatInto(pg.current, pg.current.diamondId);
	});
	syncConciseChip();

	// ── Collapse, select, fold, jump ───────────────────────────
	pg.collapseBtn = document.getElementById('collapse-btn');
	pg.selectTools = document.getElementById('select-tools');
	if (pg.collapseBtn) pg.collapseBtn.addEventListener('click', function () { setSelectMode(!_selectMode); });

	/* var */ selAllBtn  = document.getElementById('sel-all');
	/* var */ selNoneBtn = document.getElementById('sel-none');
	/* var */ selFoldBtn = document.getElementById('sel-fold');
	if (selAllBtn)  selAllBtn.addEventListener('click', function () { pickAll(true); });
	if (selNoneBtn) selNoneBtn.addEventListener('click', function () { pickAll(false); });
	if (selFoldBtn) selFoldBtn.addEventListener('click', function () {
		if (!pg.current) return;
		var turns = pickedTurns();
		if (!turns.length) {
			noticeDialog(t('fold.nothing_chosen'), t('fold.nothing_chosen_body'));
			return;
		}
		// The picker is anchored on the button that opened it, and the turns ride along.
		openFoldPicker(pg.current, selFoldBtn, turns);
	});

	/* var */ jumpBtn = document.getElementById('chat-jump');
	if (jumpBtn) jumpBtn.addEventListener('click', jumpBack);
	/* var */ endBtn = document.getElementById('chat-end');
	if (endBtn) endBtn.addEventListener('click', jumpEnd);
	syncJumps();
} // page-split: end install
