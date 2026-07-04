import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'wasm/index.node': 'src/wasm/index.node.ts',
    'wasm/index.browser': 'src/wasm/index.browser.ts',
  },
  // ESM-only in v1: the vendored wasm-bindgen glue (kaspa.js) is ESM-only with a top-level import.meta.url
  // reference, so a CJS build would need its own async-import indirection for marginal benefit.
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  // Bundle the standalone `kaspa-wallet-standard` INTO the SDK (it's ~70 lines, zero deps). Its named
  // exports are re-exported through this SDK's `export *` chain; a bundler can't propagate an EXTERNAL
  // package's names through `export *`, so inlining it keeps the re-export working AND keeps the SDK's
  // discovery code a single source of truth with the published standard (bumped in lockstep on version).
  noExternal: ['kaspa-wallet-standard'],
  // The vendored kaspa.js is wasm-bindgen ESM with a top-level import.meta.url asset reference — it must
  // NOT be bundled (that would break the relative-to-package URL resolution and inline a multi-MB blob
  // into every consumer's bundle). It's copied as a plain file (see the `vendor` entry in package.json
  // `files`) and imported at runtime via a real relative path.
  external: [/vendor\/kaspa\/kaspa\.js/],
});
