#!/usr/bin/env bun
/**
 * bun run build.ts [variant ...]      build variants (default: baseline) for every app
 * bun run build.ts --all              build every variant in variants.ts
 *   --app=<name>                      only this app (default: all apps in apps/)
 *   --no-check                        skip the happy-dom behavioural check
 *   --no-coverage                     skip scripts/coverage.ts (which code actually ran)
 *   --out=<dir>                       write to <dir>/<variant>/<app>/ instead of dist/ (check,
 *                                     measure and coverage follow via SVELTE_LITE_DIST)
 *   --svelte=<ref>                    build against another vendored Svelte (`bun run vendor <ref>`)
 *                                     instead of svelte-ref.json; see scripts/link-svelte.ts
 *
 * Svelte comes from scripts/link-svelte.ts (the vendored ref in svelte-ref.json by default);
 * the build refuses to run if that checkout's packages/svelte has local changes.
 *
 * For each variant x app, into dist/<variant>/<app>/:
 *
 *   index.html        SSR output of the app (compiled with generate: 'server', rendered with
 *                     render() from svelte/server) + <script type="module" src="main.min.js">
 *   main.min.js       client bundle (entry calls hydrate()), full minification -> the number
 *   main.js           minify: false (as unminified as Bun gets)
 *   main.readable.js  minify: { syntax: true } only: same dead-code elimination as main.min.js,
 *                     readable names + `// module` markers -> read this one
 *   meta.<mode>.json/.md   Bun metafile; patches.log (what the patch plugin changed);
 *   report.json/.md   sizes + attribution (measure.ts); coverage.json/.md (scripts/coverage.ts)
 *
 * All three client builds use identical options except `minify`. Variants with
 * `privateDce` additionally run postpass.ts on main.min.js / main.readable.js.
 */
import type { BuildConfig } from "bun";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  ensureSvelteLink,
  ROOT,
  SVELTE_DIR,
  svelteLabel,
} from "./scripts/link-svelte.ts";
import { variants, type Variant } from "./variants.ts";

// --out=<dir>: children (check, coverage) and measure/check in this process read SVELTE_LITE_DIST
const outFlag = process.argv
  .find((a) => a.startsWith("--out="))
  ?.slice("--out=".length);
if (outFlag) process.env.SVELTE_LITE_DIST = resolve(outFlag);
export const DIST = resolve(ROOT, process.env.SVELTE_LITE_DIST ?? "dist");

ensureSvelteLink(); // also fails if the Svelte checkout has uncommitted changes
// Imported after the symlink exists: these pull in `svelte/compiler`.
const { sveltePlugin } = await import("./plugins/svelte.ts");
const { patchPlugin } = await import("./plugins/patch.ts");
const { privateDce } = await import("./postpass.ts");

export const APPS = readdirSync(join(ROOT, "apps")).filter((a) =>
  existsSync(join(ROOT, "apps", a, "client.js")),
);

export const MODES = {
  min: {
    minify: {
      whitespace: true,
      syntax: true,
      identifiers: true,
      keepNames: false,
    },
    suffix: ".min",
  },
  unmin: { minify: false, suffix: "" },
  readable: {
    minify: { syntax: true, whitespace: false, identifiers: false },
    suffix: ".readable",
  },
} as const satisfies Record<
  string,
  { minify: BuildConfig["minify"]; suffix: string }
>;
export type Mode = keyof typeof MODES;

/** Defines shared by every variant. */
const BASE_DEFINE: Record<string, string> = {
  // Important, not just for libraries that read NODE_ENV: Bun 1.4.2 silently adds the
  // "development" export condition to every build unless process.env.NODE_ENV is defined
  // as "production" here (or NODE_ENV=production is in the *build process* environment).
  // With "development" active, esm-env resolves DEV -> true.js and you ship a dev build,
  // even with conditions: ['production']. verifyResolution() below guards against this.
  "process.env.NODE_ENV": '"production"',
  // Vite-style flags some Svelte-ecosystem code checks; harmless if unused.
  "import.meta.env.DEV": "false",
  "import.meta.env.PROD": "true",
  "import.meta.env.SSR": "false",
  "import.meta.env.MODE": '"production"',
};

export const outDir = (name: string, app: string) => join(DIST, name, app);

export async function buildClient(
  name: string,
  variant: Variant,
  app: string,
  mode: Mode,
  log: string[] = [],
) {
  const outdir = outDir(name, app);
  const { minify, suffix } = MODES[mode];

  const config: BuildConfig = {
    entrypoints: [join(ROOT, "apps", app, "client.js")],
    outdir,
    naming: {
      entry: `main${suffix}.[ext]`,
      chunk: `[name]-[hash]${suffix}.[ext]`,
      asset: "[name]-[hash].[ext]",
    },
    root: ROOT,

    // --- target / resolution -------------------------------------------------
    target: "browser", // browser resolution rules; "browser" export condition first
    format: "esm", // <script type="module">; flat scope-hoisted output, no wrapper
    // Export conditions. Bun adds "browser" for target=browser already; listed for
    // clarity. "production" is required too: without it esm-env/development falls
    // through to dev-fallback.js (a *runtime* globalThis.process?.env check that
    // `define` can't touch). See BASE_DEFINE for the implicit "development" condition.
    conditions: ["browser", "production"],
    packages: "bundle", // bundle everything, incl. svelte (no externals)
    splitting: false, // one entry, nothing to share; avoids chunk overhead
    // Barrel-file optimisation: skip parsing re-exported modules nobody imports. Off in
    // the baseline (it is automatic only for "sideEffects": false packages, which Svelte
    // is not, and the compiler's `import * as $` defeats it anyway); variants opt in.
    optimizeImports: variant.optimizeImports ?? [],

    // --- dead code elimination --------------------------------------------------
    // See MODES. Tree shaking of unused top-level declarations happens in every mode, but
    // constant folding, `if (false)` removal and known-pure-constructor detection
    // (`new Set`, `new WeakMap`) only happen with minify.syntax.
    minify,
    treeShaking: true, // default; explicit so nobody "debugs" it off
    // Respect /*@__PURE__*/ and package.json "sideEffects" (false = default; explicit).
    // Svelte ships no "sideEffects" field, so every runtime module is assumed impure.
    ignoreDCEAnnotations: false,
    define: { ...BASE_DEFINE, ...variant.define },
    env: "disable", // never inline process.env.* from the build machine
    // bun:bundle feature() flags. Stock Svelte doesn't use them; variants may inject them.
    features: variant.features ?? [],
    // `drop` removes calls *and their arguments* (even side-effecting ones). 'debugger' is
    // free. 'console' is NOT in the baseline: production Svelte still reports runtime
    // warnings via console.warn('https://svelte.dev/e/<code>') and hydrate() logs
    // 'Failed to hydrate'; dropping console silences those.
    drop: ["debugger", ...(variant.drop ?? [])],
    // Getter-only namespace objects (future Bun default); only matters if a
    // namespace object has to be materialised.
    deprecatedNamespaceObjectSetters: false,

    // --- output ---------------------------------------------------------------------
    sourcemap: "none", // keep measured artifacts free of map comments
    // Per-input byte attribution (bytesInOutput) plus Bun's markdown bundle report.
    // NB: in 1.4.2 these paths resolve relative to `outdir` (the docs' example implies
    // cwd). BuildConfig's type only declares `boolean`.
    metafile: {
      json: `meta${suffix || ".unmin"}.json`,
      markdown: `meta${suffix || ".unmin"}.md`,
    } as any,
    throw: false,

    plugins: [
      ...(variant.plugins ?? []),
      patchPlugin({
        svelteDir: SVELTE_DIR,
        patches: variant.patches,
        constImports: variant.constImports,
        log,
      }),
      sveltePlugin({
        ...variant.svelte,
        compilerOptions: variant.compilerOptions,
      }),
    ],
  };

  const result = await Bun.build(config);
  if (!result.success) {
    for (const m of result.logs) console.error(m);
    throw new Error(`build failed: ${name}/${app}/${mode}`);
  }
  for (const m of result.logs) console.warn(m);
  verifyResolution(result.metafile as any, `${name}/${app}/${mode}`);
  return result;
}

/** Fail loudly if Svelte or esm-env resolved to a dev/server/fallback file. */
function verifyResolution(
  meta: {
    inputs: Record<string, { imports: { path: string; original?: string }[] }>;
  },
  label: string,
) {
  const expect: Record<string, RegExp> = {
    "esm-env/development": /esm-env\/false\.js$/,
    "esm-env/browser": /esm-env\/true\.js$/,
    svelte: /svelte\/src\/index-client\.js$/,
  };
  for (const input of Object.values(meta.inputs)) {
    for (const imp of input.imports) {
      const re = imp.original && expect[imp.original];
      if (re && !re.test(imp.path)) {
        throw new Error(
          `[${label}] '${imp.original}' resolved to ${imp.path}; expected ${re} (see BASE_DEFINE/conditions)`,
        );
      }
    }
  }
}

/**
 * Safety net for `removeMembers` patches: a removed *public* method that is still called
 * somewhere would only fail at runtime (`x.foo is not a function`), so fail the build if
 * the bundle still contains a call to one. (Removed #private members can't be referenced
 * at all: that is already a parse error.)
 */
function verifyRemovedApi(variant: Variant, bundle: string, label: string) {
  for (const p of variant.patches ?? []) {
    for (const m of p.removeMembers?.members ?? []) {
      if (m.startsWith("#")) continue;
      const re = new RegExp(`\\.${m}\\(`);
      if (re.test(bundle)) {
        throw new Error(
          `[${label}] removed method ${p.removeMembers!.class}.${m}() is still called in the bundle (${p.why})`,
        );
      }
    }
  }
}

/**
 * SSR: bundle apps/<app>/server.js for Bun with the *unpatched* server runtime and the
 * variant's compiler options, render the app, and write index.html around the result.
 */
export async function buildHtml(name: string, variant: Variant, app: string) {
  const outdir = outDir(name, app);
  const ssrDir = join(outdir, ".ssr");
  const result = await Bun.build({
    entrypoints: [join(ROOT, "apps", app, "server.js")],
    outdir: ssrDir,
    target: "bun",
    format: "esm",
    conditions: ["production"],
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      sveltePlugin({
        generate: "server",
        compilerOptions: variant.compilerOptions,
      }),
    ],
    throw: false,
  });
  if (!result.success) {
    for (const m of result.logs) console.error(m);
    throw new Error(`SSR build failed: ${name}/${app}`);
  }
  const mod = await import(`${result.outputs[0].path}?v=${Date.now()}`);
  const { head, body } = mod.render(mod.App);
  rmSync(ssrDir, { recursive: true, force: true });
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>svelte-lite: ${app} (${name})</title>
${head}
</head>
<body>
<div id="app">${body}</div>
<script type="module" src="./main.min.js"></script>
</body>
</html>
`;
  await Bun.write(join(outdir, "index.html"), html);
}

export async function buildApp(name: string, variant: Variant, app: string) {
  const outdir = outDir(name, app);
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  const log: string[] = [];
  for (const mode of Object.keys(MODES) as Mode[]) {
    await buildClient(name, variant, app, mode, mode === "min" ? log : []);
  }
  verifyRemovedApi(
    variant,
    await Bun.file(join(outdir, "main.readable.js")).text(),
    `${name}/${app}`,
  );
  if (variant.privateDce) {
    const removed = await privateDce(outdir);
    log.push(
      `post-pass: removed unreferenced private members: ${removed.join(", ") || "(none)"}`,
    );
  }
  await buildHtml(name, variant, app);
  await Bun.write(
    join(outdir, "patches.log"),
    [...new Set(log)].join("\n") + "\n",
  );
  return outdir;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const appFlag = args.find((a) => a.startsWith("--app="))?.slice(6);
  let names = args.filter((a) => !a.startsWith("--"));
  if (flags.has("--all")) names = Object.keys(variants);
  if (names.length === 0) names = ["baseline"];
  const apps = appFlag ? [appFlag] : APPS;

  const { measure } = await import("./measure.ts");
  const { check } = await import("./check.ts");
  console.log(
    `building with ${svelteLabel()} -> ${relative(ROOT, DIST) || "."}/`,
  );

  for (const name of names) {
    const variant = variants[name];
    if (!variant) {
      console.error(
        `unknown variant "${name}". known: ${Object.keys(variants).join(", ")}`,
      );
      process.exit(1);
    }
    for (const app of apps) {
      const t0 = performance.now();
      const outdir = await buildApp(name, variant, app);
      console.log(
        `\n=== ${name}/${app} === (${(performance.now() - t0).toFixed(0)} ms) ${variant.description}`,
      );
      if (!flags.has("--no-check")) await check(name, app);
      const r = await measure(name, app, outdir);
      const s = r.sizes["main.min.js"];
      console.log(
        `main.min.js: ${s.raw} B raw / ${s.gzip} gzip / ${s.brotli} brotli`,
      );
      if (!flags.has("--no-coverage")) {
        const cov = Bun.spawnSync(
          ["bun", join(ROOT, "scripts/coverage.ts"), name, app],
          { env: process.env, stdout: "pipe", stderr: "inherit" },
        );
        const summary = cov.stdout
          .toString()
          .match(/\| never ran \| ([\d,]+) \| ([\d.]+%)/);
        console.log(
          cov.exitCode === 0
            ? `coverage: ${summary?.[1]} B (${summary?.[2]}) of main.min.js never ran`
            : "coverage: FAILED",
        );
        if (cov.exitCode !== 0) process.exitCode = 1;
      }
    }
  }
  console.log(`\nbuilt ${names.join(", ")} with ${svelteLabel()}`);
}
