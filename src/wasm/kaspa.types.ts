// Shared type for the loaded Kaspa WASM SDK namespace, used by every module that needs `k: Kaspa` without
// caring how it was loaded (browser fetch vs Node fs.readFile — see kaspa.browser.ts / kaspa.node.ts).
import type * as kaspa from '../../vendor/kaspa/kaspa.js';

export type Kaspa = typeof kaspa;
