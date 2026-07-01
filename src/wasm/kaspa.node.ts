// Node loader for the vendored Kaspa WASM SDK. Uses the SAME web-target kaspa.js/kaspa_bg.wasm shipped for
// the browser build — there is no separate Node-target artifact. wasm-bindgen's init() only calls fetch()
// when module_or_path is a string/URL/Request; passed raw bytes, it skips fetch() entirely and goes straight
// to instantiation, which works identically in Node. Proven by scripts/smoke-test-node-wasm.mjs.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import init, * as kaspa from '../../vendor/kaspa/kaspa.js';
import type { Kaspa } from './kaspa.types.js';

export type { Kaspa };

let ready: Promise<Kaspa> | null = null;

/** Lazy-initialize the WASM module once; resolves to the SDK namespace. Reads the .wasm bytes from disk
 *  relative to this package's own install location, so it works regardless of the consumer's CWD. */
export function loadKaspa(): Promise<Kaspa> {
  if (!ready) {
    ready = (async () => {
      try {
        const wasmPath = fileURLToPath(new URL('../../vendor/kaspa/kaspa_bg.wasm', import.meta.url));
        const bytes = await readFile(wasmPath);
        await (init as any)({ module_or_path: bytes });
        return kaspa;
      } catch (err: any) {
        ready = null; // don't cache the failure — let the next call retry
        throw new Error(`Couldn't load the Kaspa WASM SDK (Node): ${err?.message ?? err}`);
      }
    })();
  }
  return ready;
}
