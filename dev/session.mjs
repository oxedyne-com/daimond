// session.mjs — sign a browser page in to the gateway as a fresh account.
//
// The operator console no longer takes a token: it rides the ordinary signed
// session the app takes when you unlock your identity, so a test that wants to
// reach the console has to hold a real one. Faking it — injecting a cookie,
// stubbing the fetch — would test the console against a session the gateway
// never issued, and the thing most worth testing here is precisely that the
// gateway issues it and honours it.
//
// So this does what the app does, in the page, with WebCrypto: generate an
// Ed25519 device key, bind it to an account with a signature over the same
// message `gateway.js` signs, then answer a challenge to take the session. The
// cookie lands in the browser's own jar because the browser is what asked for
// it.

/// Register a fresh account in `page`'s origin and take a session on it.
///
/// Returns the account id, which is what an owner needs in order to grant a
/// role, and what the tests assert against.
export async function signInFresh(page, appUrl) {
	// The page must already be on the origin: the session cookie is bound to
	// it, and a fetch from about:blank would have nowhere to put one.
	if (!page.url().startsWith(appUrl)) {
		await page.goto(appUrl + '/', { waitUntil: 'domcontentloaded' });
	}
	return await page.evaluate(async () => {
		function b64(buf) {
			var bytes = new Uint8Array(buf), s = '';
			for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
			return btoa(s);
		}
		function b64url(buf) {
			return b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		}
		async function post(path, body) {
			var r = await fetch(path, {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
				body: JSON.stringify(body),
			});
			var j = null;
			try { j = await r.json(); } catch (e) {}
			if (!r.ok || !j || j.ok === false) {
				throw new Error(path + ' → ' + r.status + ' ' + ((j && j.error) || ''));
			}
			return j;
		}

		var kp  = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
		var raw = await crypto.subtle.exportKey('raw', kp.publicKey);
		var pub = b64url(raw);
		var enc = new TextEncoder();
		var sign = async function (s) {
			return b64(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, enc.encode(s)));
		};

		var ts   = Math.floor(Date.now() / 1000);
		var acct = await post('/api/account', {
			pubkey: pub, alg: 'Ed25519', ts: ts,
			sig: await sign('daimond-gw-account:v1:' + pub + ':' + ts),
		});
		var ch = await post('/api/auth/challenge', { pubkey: pub, alg: 'Ed25519' });
		await post('/api/auth/verify', {
			challenge_id: ch.challenge_id,
			sig: await sign(ch.challenge),
		});
		return acct.account_id;
	});
}
