# Official KCC conformance vectors (test fixtures)

`kcc-0001.conformance.json` (KCC-1 covenant ABI: BLAKE3 hashing, data pushes, scalar / record encodings, dispatch tags,
state encoding, template hashes) and `kcc-0020.conformance.json` (KCC-20 reference token: dispatch tags, the 112-byte
state record, transfer arguments, owner witnesses), mirrored verbatim from the KCCs repository at commit
`1ed87aef59faff8354061aee30f734a3b8b2c3d2` (the commit KRON's family toolchain pins). Data, not code: the tests in
`src/native/kcc20V1Tx.test.ts` read them. Re-sync by copying the upstream files; never edit them.
