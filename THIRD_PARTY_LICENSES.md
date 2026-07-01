# Third-Party Licenses

kron-sdk is MIT-licensed (see [`LICENSE`](./LICENSE)). It incorporates the following vendored components,
each used under its own permissive license.

## Vendored runtime components (redistributed in this repo)

| Component | Location | License | Copyright |
|-----------|----------|---------|-----------|
| Kaspa WASM SDK (from rusty-kaspa) | `vendor/kaspa/` | ISC | Copyright (c) 2022–2024 Kaspa developers |

Checksummed against KRON's own production-vendored copy at every release — see README.md "Verification".

## NPM dependencies

| Package | License | Copyright |
|---------|---------|-----------|
| @noble/hashes | MIT | Copyright (c) 2022 Paul Miller (https://paulmillr.com) |

### Build / development tooling (not shipped)

| Package | License |
|---------|---------|
| typescript | Apache-2.0 |
| tsup | MIT |
| vitest | MIT |

---

## License texts

### ISC License

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

---

_Last reviewed: 2026-06-30. When adding or removing dependencies, update this file accordingly._
