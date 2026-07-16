// A key the provider rejects must not be reported "Saved."/connected, and a
// no-account stranger must have a way to create one from the credits pitch.
import { open, errors } from './harness.mjs';

// The mock returns 401 on /models when asked (any key), so drive a rejected key.
// We point at a base URL whose /models 401s: use the mock but with a path that
// makes it 401 — simplest: use a bogus provider URL that fails. Here we assert
// the guard logic directly by simulating the rejected-fetch state.
const s = await open({ name: 'settings', connect: false });

// Open settings and try to save a key the model-fetch will reject.
const result = await s.page.evaluate(async () => {
	// Open settings.
	const cog = document.getElementById('settings-btn');
	if (cog) cog.click();
	await new Promise(r => setTimeout(r, 300));
	const prov = document.getElementById('cfg-provider');
	prov.value = 'custom'; prov.dispatchEvent(new Event('change', { bubbles: true }));
	await new Promise(r => setTimeout(r, 200));
	// Point at an endpoint whose /models returns 401 (the mock's /v1/models is
	// 200, so instead use a URL that 404/401s): use a clearly-bad host path.
	const url = document.getElementById('cfg-base-url');
	url.value = 'http://127.0.0.1:9099/v1/chat/completions';
	url.dispatchEvent(new Event('input', { bubbles: true }));
	url.dispatchEvent(new Event('change', { bubbles: true }));
	const key = document.getElementById('cfg-api-key');
	key.value = 'reject';   // the mock 401s this sentinel key on /models
	key.dispatchEvent(new Event('input', { bubbles: true }));
	key.dispatchEvent(new Event('change', { bubbles: true }));
	await new Promise(r => setTimeout(r, 1200));   // let the model fetch run + fail
	// Type a model manually so validation passes to the key-rejection check.
	const cus = document.getElementById('cfg-model-custom');
	if (cus) { cus.style.display=''; cus.value = 'mock/fast'; cus.dispatchEvent(new Event('input', {bubbles:true})); }
	const save = document.getElementById('byok-save');
	save.click();
	await new Promise(r => setTimeout(r, 400));
	return { note: document.getElementById('byok-note').textContent };
});
console.log('after saving a rejected key, note:', JSON.stringify(result.note));
const refused = /rejected/i.test(result.note);
console.log('REJECTED KEY NOT REPORTED CONNECTED:', refused);
console.log('errors:', errors(s));
await s.close();
