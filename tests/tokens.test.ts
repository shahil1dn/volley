// The look is token-driven so a copy's own brand (and the AI Builders theme)
// reaches every screen: colours come from the variables src/lib/theme.ts makes
// from src/lib/brand.ts, never from a literal in the stylesheet or a component.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../src/', import.meta.url).pathname;

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sources(path);
		return /\.(css|svelte)$/.test(name) ? [path] : [];
	});
}

// A colour written out: hex, or an rgb/hsl/hwb/lab/oklch function.
const LITERAL_COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;
// QR codes stay white whatever the paper colour, so scanners can read them: on a QR's own
// rule, and only there, that one declaration is let through. Anything else on the line still counts.
const QR_RULE = /^\s*\.(?:host|thanks)__qr\s*\{/;
const withoutExemption = (line: string) => (QR_RULE.test(line) ? line.replace('background: #fff;', '') : line);

test('the QR exemption lets through only the white background on a QR rule', () => {
	assert.equal(LITERAL_COLOUR.test(withoutExemption('.thanks__qr { width: 1px; background: #fff; }')), false);
	assert.equal(LITERAL_COLOUR.test(withoutExemption('.thanks__qr { background: #fff; color: #123456; }')), true);
	assert.equal(LITERAL_COLOUR.test(withoutExemption('.thanks__qr-evil { background: #fff; }')), true);
	assert.equal(LITERAL_COLOUR.test(withoutExemption('.thanks__message { background: #fff; }')), true);
});

test('no stylesheet or component writes a colour literal; every colour is a theme variable', () => {
	const offenders: string[] = [];
	for (const file of sources(ROOT)) {
		for (const [n, line] of readFileSync(file, 'utf8').split('\n').entries()) {
			if (LITERAL_COLOUR.test(withoutExemption(line))) offenders.push(`${file.replace(ROOT, 'src/')}:${n + 1}: ${line.trim()}`);
		}
	}
	assert.deepEqual(offenders, []);
});

test('disabled is one look: no :disabled rule fades with opacity or invents its own colour', () => {
	const css = readFileSync(join(ROOT, 'app.css'), 'utf8');
	const rules = [...css.matchAll(/([^{}]*:disabled[^{}]*)\{([^}]*)\}/g)].filter((rule) => !rule[1].includes(':not(:disabled)'));
	assert.ok(rules.length >= 2, 'expected the shared .btn:disabled rule and the text-button variant');
	for (const [, selector, body] of rules) {
		assert.doesNotMatch(body, /opacity/, `${selector.trim()} fades instead of using the shared look`);
		for (const [, value] of body.matchAll(/(?:color|background|box-shadow)\s*:\s*([^;]+)/g)) {
			assert.match(value, /var\(--(?:surface|muted|line)\)|\bnone\b/, `${selector.trim()}: ${value}`);
		}
	}
});
