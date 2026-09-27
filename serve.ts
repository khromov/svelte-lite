#!/usr/bin/env bun
/** Static server for manual browser checks: bun run serve.ts [port], then open / for the list of SSR pages. */
import { existsSync, readdirSync } from 'node:fs';
import { join, normalize } from 'node:path';

const ROOT = import.meta.dir;
const port = Number(process.argv[2] ?? 3000);

function listing() {
	const dist = join(ROOT, 'dist');
	const links = existsSync(dist)
		? readdirSync(dist)
				.filter((v) => !v.startsWith('.'))
				.flatMap((v) =>
					readdirSync(join(dist, v))
						.filter((a) => existsSync(join(dist, v, a, 'index.html')))
						.map((a) => `<li><a href="/dist/${v}/${a}/index.html">${v} / ${a}</a></li>`)
				)
		: [];
	return new Response(`<!doctype html><meta charset="utf-8"><title>svelte-lite</title><h1>svelte-lite builds</h1><ul>${links.join('')}</ul>`, {
		headers: { 'content-type': 'text/html; charset=utf-8' }
	});
}

Bun.serve({
	port,
	async fetch(req) {
		const { pathname } = new URL(req.url);
		if (pathname === '/') return listing();
		const rel = normalize(decodeURIComponent(pathname));
		if (rel.includes('..')) return new Response('bad path', { status: 400 });
		const file = Bun.file(join(ROOT, rel));
		return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
	}
});
console.log(`http://localhost:${port}/`);
