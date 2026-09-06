// Dual-ABI discriminator guard.
//
// WHY THIS EXISTS. KRON pins a covenant schema per token, and the recipient-bound schemas (HLK-L04 curve,
// HLK-L12 pool) made every value-releasing entrypoint take two APPENDED signature-script args —
// `(witness:int, identifier:byte[32])`. The builders pick the ABI from an OPTIONAL template flag, and an
// absent flag means the legacy form. That default is deliberate and correct in the safe direction: appending
// the pair on a legacy schema would corrupt the covenant's arg stack, whereas omitting it merely gets the tx
// rejected. But it makes the DANGEROUS direction — a recipient-bound covenant driven by a template nobody
// hydrated — completely silent: the builder emits a signature script two stack items short, and the node
// rejects it at submit with
//
//     failed to verify the signature script: encountered invalid state while running script:
//     pick at an invalid location
//
// (silverc bakes each entrypoint arg's stack depth as a compile-time constant and reads it with `OP_PICK`;
// two missing args make every one of those picks land past the bottom of the stack.)
//
// The SDK CANNOT infer the answer from `tpl.script`: a curve template has per-token params (fee owners, vKas,
// fee bps) baked into the compiled bytes at varying widths, so two tokens on the SAME schema have different
// script bytes and no stable schema fingerprint is available here. The flag is the only signal, so an UNSET
// flag gets a one-time warning naming the exact failure. An EXPLICIT `false` is silent — that is a caller
// asserting "this token is on a legacy schema", which is a legitimate, common, and correct thing to say.
//
// This is a warning and not a throw on purpose: the great majority of live tokens ARE on legacy schemas,
// where an unset flag builds a perfectly valid trade. Turning that into an error would break working
// integrations to protect against a case they never hit. The required-discriminant form lands in 0.19.0.

/** Builders that have already warned this process — one line per builder, not one per trade. */
const warned = new Set<string>();

/** Escape hatch for consumers who have audited their template plumbing and want a clean log. */
const silenced = (): boolean => (globalThis as { KRON_SDK_SILENCE_ABI_WARNINGS?: unknown }).KRON_SDK_SILENCE_ABI_WARNINGS === true;

/**
 * Resolve the recipient-bound ABI discriminator for one builder call, warning ONCE per builder when the flag
 * was never hydrated. Returns the ABI actually used: `true` only for an explicit `true`.
 *
 * @param flag    the template's `recipientBound` — `undefined` means "nobody set this"
 * @param builder the calling builder's name, for the log line
 * @param echoField the `cp-template` params field that feeds this flag (`tradeRecipientBound` / `poolRecipientBound`)
 */
export function resolveRecipientBound(flag: boolean | undefined, builder: string, echoField: string): boolean {
  if (flag === undefined && !warned.has(builder) && !silenced()) {
    warned.add(builder);
    // eslint-disable-next-line no-console
    console.warn(
      `[kron-sdk] ${builder}: template.recipientBound is unset — building the LEGACY covenant ABI.\n` +
        `  Correct for legacy schemas. On a recipient-bound schema the node REJECTS the tx with\n` +
        `  "failed to verify the signature script: ... pick at an invalid location".\n` +
        `  Fix: hydrate templates with client.fetchCpTemplates() (or client.shapeCpTemplates() if you fetch\n` +
        `  yourself) so the flag comes from the compiler echo's \`${echoField}\`. Set recipientBound:false\n` +
        `  explicitly to assert a legacy schema and silence this. (All: globalThis.KRON_SDK_SILENCE_ABI_WARNINGS = true)`,
    );
  }
  return flag === true;
}

/** Test seam — reset the once-per-builder latch. Not part of the public API. */
export function __resetAbiWarnings(): void {
  warned.clear();
}
