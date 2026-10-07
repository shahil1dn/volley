import type pg from 'pg';

// Percent-decodes what can be decoded and leaves what cannot (a stray "%zz" must not stop the rest being read).
export function lenientDecode(text: string): string {
	return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
		try {
			return decodeURIComponent(run);
		} catch {
			return run.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
		}
	});
}

// The ONE reading of a database address. It is the exact set of fields pg connects with, and the
// production guard checks these same fields, so what is checked is what is used: nothing parses the
// text a second time. It is the WHATWG URL parser (the one pg-connection-string wraps) and nothing
// else: the query string is dropped whole (a parameter such as ?host= or ?sslrootcert= can move the
// connection or make a parser read a file), and TLS is left to the caller.
export function addressConfig(raw: string): pg.ClientConfig & { host: string } {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error('the database address has no host or cannot be read');
	}
	if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('the database address is not a postgres:// address');
	const host = lenientDecode(url.hostname).replace(/^\[(.+)\]$/, '$1');
	if (!host) throw new Error('the database address has no host');
	return {
		host,
		port: url.port ? Number(url.port) : undefined,
		user: lenientDecode(url.username) || undefined,
		password: lenientDecode(url.password) || undefined,
		database: lenientDecode(url.pathname.slice(1)) || undefined,
	};
}
