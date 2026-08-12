# FaunaVault Dependency Security Review

Review date: 2026-08-12

## Outcome

The frontend baseline was eight affected packages: one moderate and seven high
findings from `npm audit`. Four high findings were present in the production
dependency tree. The audit represented 29 advisory records because three
`brace-expansion` advisories were reported separately for the installed 1.x and
5.x branches; there were 26 unique GHSA identifiers.

Targeted patch and minor updates resolved every current npm finding. The final
live `npm audit` and `npm audit --omit=dev` both reported zero vulnerabilities.
The backend review also identified Pillow 12.2.0 security fixes relevant to an
application that processes user-provided images; Pillow was upgraded to 12.3.0.
No major upgrade or application/API change was required.

## Frontend advisory disposition

| Package / advisory | Baseline and ownership | FaunaVault exposure | Remediation and status |
| --- | --- | --- | --- |
| `next` — [GHSA-6gpp-xcg3-4w24](https://github.com/advisories/GHSA-6gpp-xcg3-4w24), [GHSA-m99w-x7hq-7vfj](https://github.com/advisories/GHSA-m99w-x7hq-7vfj), [GHSA-89xv-2m56-2m9x](https://github.com/advisories/GHSA-89xv-2m56-2m9x), [GHSA-68g3-v927-f742](https://github.com/advisories/GHSA-68g3-v927-f742), [GHSA-4633-3j49-mh5q](https://github.com/advisories/GHSA-4633-3j49-mh5q), [GHSA-4c39-4ccg-62r3](https://github.com/advisories/GHSA-4c39-4ccg-62r3), [GHSA-p9j2-gv94-2wf4](https://github.com/advisories/GHSA-p9j2-gv94-2wf4), [GHSA-q8wf-6r8g-63ch](https://github.com/advisories/GHSA-q8wf-6r8g-63ch), [GHSA-955p-x3mx-jcvp](https://github.com/advisories/GHSA-955p-x3mx-jcvp) (high aggregate) | 16.2.9; direct production dependency. The direct advisory range was `>=16.0.0 <16.2.11`. | Next executes in the build and server runtime. FaunaVault has no Server Actions, middleware/proxy, rewrites, custom Next server, Edge runtime, or `next/image` usage, which constrains the described paths without making the vulnerable framework code desirable to retain. | Upgraded `next` and the aligned `eslint-config-next` to 16.3.0. Resolved. |
| `sharp` — [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) (high) | 0.34.5; optional transitive production dependency from `next`; vulnerable `<0.35.0`. | Installed as Next image tooling, but FaunaVault does not import `next/image` or expose the optimizer route through application code. | Next 16.3.0 resolves `sharp` 0.35.3. Resolved. |
| `postcss` — [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93), [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q), [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849), [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) (high aggregate) | 8.4.31 through `next`, 8.5.15 through `@tailwindcss/postcss`, and 8.5.19 through Vite; transitive production/build and development dependency. `@tailwindcss/postcss` 4.3.1 appeared as a separate moderate affected-package finding through these advisories. | CSS is repository-controlled and processed during build/test; FaunaVault does not accept attacker-provided CSS or source maps. The Next-owned copy was nevertheless in the production dependency tree. | Next resolves 8.5.23; Tailwind/Vite resolve 8.5.26. `@tailwindcss/postcss` and `tailwindcss` were aligned at 4.3.3. Resolved. |
| `nanoid` — [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv), [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) (high) | 3.3.12; transitive production/build dependency through PostCSS; vulnerable through 3.3.16. | FaunaVault does not call Nano ID generators or provide attacker-controlled generator sizes; it is used inside the CSS toolchain. | Lockfile update to 3.3.18. Resolved. |
| `brace-expansion` — [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp), [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg), [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) (high) | 1.1.15 through ESLint/minimatch and 5.0.6 through TypeScript ESLint/minimatch; transitive development dependency. npm emitted each GHSA for the affected version branches. | Executes only during lint/build tooling against repository-controlled patterns. | Lockfile update to 1.1.18 and 5.0.9. Resolved. |
| `js-yaml` — [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m), [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) (high) | 4.2.0 through ESLint; transitive development dependency; vulnerable `<4.3.1`. | Used by lint tooling; FaunaVault does not parse user-provided YAML. | Lockfile update to 4.3.1. Resolved. |
| `undici` — [GHSA-8xcm-r25x-g524](https://github.com/advisories/GHSA-8xcm-r25x-g524), [GHSA-4cwx-7wf7-3272](https://github.com/advisories/GHSA-4cwx-7wf7-3272), [GHSA-m8rv-5g2x-5cg5](https://github.com/advisories/GHSA-m8rv-5g2x-5cg5), [GHSA-jr45-8vmc-qm54](https://github.com/advisories/GHSA-jr45-8vmc-qm54), [GHSA-v3r7-h72x-cjcm](https://github.com/advisories/GHSA-v3r7-h72x-cjcm) (high aggregate) | 7.28.0 through `jsdom`; transitive test-only dependency; vulnerable `<7.29.0`. | Executes only in the Vitest/JSDOM environment. Tests do not expose a shared HTTP cache or process untrusted remote responses. | Lockfile update to 7.29.0. Resolved. |

## Python finding

Pillow was a direct production dependency locked at 12.2.0. Pillow 12.3.0 is a
security release that includes [GHSA-pg7v-jwj7-p798 / CVE-2026-59203](https://github.com/advisories/GHSA-pg7v-jwj7-p798)
(EPS negative `BeginBinary` infinite-loop denial of service) and
[GHSA-phj9-mv4w-65pm / CVE-2026-55380](https://github.com/advisories/GHSA-phj9-mv4w-65pm)
(GD decompression-bomb bypass), plus fixes in PDF, JPEG2000, McIdas, TGA,
filter, paste/compositing, color-transform, and font handling.

FaunaVault rejects files before Pillow parsing unless filename extension, MIME
type, and decoded format agree with JPEG, PNG, or WebP, so the EPS and explicit
GD entry points are not reachable through the upload API. The backend still
decodes untrusted supported images and uses Pillow transforms, including alpha
compositing for perceptual hashing. The direct floor and lock were therefore
updated to Pillow 12.3.0. Existing upload byte/pixel limits, decompression-bomb
handling, format validation, and image regression tests remain in place. No
other locked Python package produced an actionable security finding in this
focused review; ordinary framework and tooling freshness updates were not made.

## Supply-chain and maintenance observations

- All npm lockfile artifacts resolve from `registry.npmjs.org`; uv sources are
  the local editable backend and `https://pypi.org/simple` artifacts. There are
  no declared Git, arbitrary URL/tarball, alternate-registry, or path
  dependencies and no npm overrides/resolutions.
- The baseline npm install-script review listed `sharp` 0.34.5 and
  `unrs-resolver` 1.12.2. After the Next/sharp upgrade, only the expected native
  resolver postinstall for `unrs-resolver` remains; no approval policy was added
  as part of this review.
- `vite-tsconfig-paths` is imported by the Vitest configuration and brings the
  deprecated dev-only `tsconfck` 3.1.6 package. Vite 8 now reports that its
  native `resolve.tsconfigPaths` option can replace the plugin. Removing it is a
  separate low-risk maintenance cleanup, not a vulnerability remediation, so
  it was deliberately left unchanged.
- The upgraded Next ESLint configuration reports one warning for the existing
  `window.location.href` navigation in `album-detail.tsx`. Lint exits
  successfully; application navigation was not rewritten in this dependency
  review.

## Validation

| Command | Result |
| --- | --- |
| `npm ci` | Passed; 442 packages installed, 443 audited, zero vulnerabilities |
| `npm audit` / `npm audit --omit=dev` | Passed; zero findings at every severity |
| `npm ls` | Passed; patched dependency tree is valid |
| `npm run lint` | Passed with the one documented existing-code warning |
| `npm run typecheck` | Passed |
| `npm test` | Passed; 7 files and 30 tests |
| `npm run build` | Passed with Next.js 16.3.0/Turbopack |
| `uv sync --frozen` | Passed under the repository's Python 3.12 environment |
| `uv run ruff check .` | Passed |
| `uv run ruff format --check .` | Passed; 41 files already formatted |
| `uv run pytest` | Passed; 91 passed, 1 skipped |
| `uv run faunavault-backup --help` | Passed without accessing the live archive |

React/React DOM 19.2.4, TypeScript 5.9.3, Vitest 4.1.10, ESLint 9.39.4,
FastAPI, Starlette, SQLModel, SQLAlchemy, Uvicorn, Node 24, Python 3.12, CI,
README instructions, public APIs, and database schema were deliberately left
unchanged. No major dependency migration is recommended from the reviewed
findings.
