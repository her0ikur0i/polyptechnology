# M6 — Dashboard build hygiene

Date: 2026-08-10. Status: **done**.

## 1. Route-level code splitting

`src/dashboard/app.tsx` had zero `lazy()` boundaries: all eleven routes shipped
in one 289.55 kB chunk, and the canvas renderer, layout engine, frame-budget
controller and validators behind Factory Live were downloaded by every owner on
every visit whether or not they opened that page.

Three modules are now split — the three that exist as separate files and
therefore represent real weight:

| Chunk                          | Size      | gzip     |
| ------------------------------ | --------- | -------- |
| `index` (shell + inline pages) | 262.99 kB | 83.40 kB |
| `FactoryLive`                  | 12.23 kB  | 4.77 kB  |
| `conversation-workspace`       | 11.41 kB  | 3.48 kB  |
| `policy-control`               | 6.94 kB   | 2.36 kB  |

Main bundle: **289.55 kB → 262.99 kB.**

The other routed pages (`Overview`, `Providers`, `Settings`, `RegistryPage`,
`Placeholder`) are declared inline in `app.tsx`, so wrapping them in `lazy()`
would move nothing — the code is already in the entry module. Extracting them
into their own files is the shell rework CONTRACT-018 owns, and doing it inside
a hardening contract would have mixed two concerns.

The `Suspense` fallback reuses `StatePage kind="loading"`, the same treatment
the initial snapshot fetch already shows, so a chunk fetch and a data fetch look
alike to the owner instead of introducing a second loading vocabulary.

### A real test weakness this exposed

Splitting broke one dashboard test immediately and revealed two more that were
passing on timing luck. Three places in `tests/dashboard/app.test.tsx` clicked a
navigation link and then queried synchronously with `getByLabelText` /
`getByRole`. With the page in the entry chunk that happened to work; across a
Suspense boundary it asserts against the loading fallback.

All three now use `findBy*`, which is the honest fix: navigating to those pages
genuinely crosses an async boundary now, and the owner waits on it too. Only one
of the three actually failed — the other two were latent, and would have failed
intermittently in CI later.

## 2. The typeface that never loaded

`src/dashboard/styles.css:2` declared `font-family: "DM Sans", system-ui,
sans-serif`. There is no `@font-face`, no stylesheet link, and no font asset
anywhere in the repository. Every user has always seen the system UI face while
the stylesheet claimed otherwise — the declared design intent had never once
rendered.

The contract offered two honest resolutions: load the face, or stop naming it.
**Stop naming it** was chosen. Shipping a webfont now means picking a typeface,
and CONTRACT-018 is where the typography decision belongs — guessing ahead of it
would mean choosing twice and probably disagreeing with itself. The declaration
is now an explicit system stack that resolves to what actually renders, with a
comment recording the history so nobody re-adds an unloaded family later.

This is a correction of a lie in the stylesheet, not a design change: the
rendered result is byte-for-byte what users already saw.

## Verification

```
npm run typecheck          clean
npm run dashboard:test     5 files, 38 tests, all passing
npm run dashboard:build    4 chunks, built in 769 ms
find dist-dashboard -name "*.map"   → 0
npm run format:check       clean repository-wide
```

Backend untouched by this milestone; the suite stands at 187 passing, 0 skipped
from M5's verification.
