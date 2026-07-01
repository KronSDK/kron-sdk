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
  // The vendored kaspa.js is wasm-bindgen ESM with a top-level import.meta.url asset reference — it must
  // NOT be bundled (that would break the relative-to-package URL resolution and inline a multi-MB blob
  // into every consumer's bundle). It's copied as a plain file (see the `vendor` entry in package.json
  // `files`) and imported at runtime via a real relative path.
  external: [/vendor\/kaspa\/kaspa\.js/],
});
