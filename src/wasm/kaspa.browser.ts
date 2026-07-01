// Browser loader for the vendored Kaspa WASM SDK. Same kaspa.js/kaspa_bg.wasm as the Node path (see
// kaspa.node.ts) — only the init() call differs, since the browser path lets wasm-bindgen fetch() the
// .wasm asset itself.
//
// Bundler note: this package ships vendor/kaspa/kaspa_bg.wasm as a real file. Most modern bundlers (Vite,
// webpack 5, Rollup via @rollup/plugin-url, esbuild with --loader:.wasm=file) can resolve a `new URL(...,
// import.meta.url)` reference to it automatically. If your bundler can't, pass an explicit `wasmUrl` —
// e.g. the public URL you've copied the .wasm asset to.
import init, * as kaspa from '../../vendor/kaspa/kaspa.js';
import type { Kaspa } from './kaspa.types.js';

export type { Kaspa };

let ready: Promise<Kaspa> | null = null;

const WASM_LOAD_TIMEOUT_MS = 30_000;
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

/** Lazy-initialize the WASM module once; resolves to the SDK namespace. Pass `wasmUrl` to override asset
 *  resolution for bundlers that can't auto-resolve `new URL(..., import.meta.url)`. */
export function loadKaspa(wasmUrl?: string | URL): Promise<Kaspa> {
  if (!ready) {
    ready = (async () => {
      try {
        const url = wasmUrl ?? new URL('../../vendor/kaspa/kaspa_bg.wasm', import.meta.url);
        await withTimeout((init as any)({ module_or_path: url }), WASM_LOAD_TIMEOUT_MS, 'Kaspa WASM SDK load');
        return kaspa;
      } catch (err: any) {
        ready = null;
        throw new Error(`Couldn't load the Kaspa WASM SDK (browser): ${err?.message ?? err}. Check your connection and retry.`);
      }
    })();
  }
  return ready;
}
