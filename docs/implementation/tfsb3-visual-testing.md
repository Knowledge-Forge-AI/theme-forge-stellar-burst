# TFSB3 visual testing and dependency note

## Selected development dependency

TFSB3 pins `@playwright/test` 1.62.1 as a development dependency. Its
Apache-2.0 license is compatible with this repository's AGPL-3.0 license, its
Node requirement is Node 20 or newer, and the selected project environment is
Node 22. The locked development graph is `@playwright/test` -> `playwright` ->
`playwright-core` at the same exact version, plus Playwright's optional
macOS-only `fsevents` dependency. The dependency install reported no known npm
advisories.

Playwright solves the concrete need to render SVG in Chromium, Firefox, and
WebKit and supplies the committed-snapshot comparison and failure artifacts.
Its native screenshot matcher is used for goldens. Same-run original/rebuilt
and rebuilt/installed comparisons use exact PNG `Buffer` equality, which avoids
stored intermediates. No `pixelmatch`, `pngjs`, browser application framework,
or HTTP framework is needed; the fixture server uses Node core.

The package is dev-only because browser qualification is repository test
evidence, not product behavior. Runtime modules never import Playwright,
`tfsb check` never launches a browser, and the package's `files: ["dist"]`
boundary excludes tests and baselines. Browser binaries are installed
separately into Playwright's platform cache and add hundreds of megabytes to a
developer or CI environment; `npm ci` alone does not make the visual suite
runnable. CI therefore installs only the three selected browser families and
their Linux requirements in its separate visual job.

## Pipeline and matrix

Each visual worker creates a temporary project, ZIPs the readable six-SVG
Terminal Nova fixture with existing `fflate` test tooling, calls the real import
API, writes valid install declarations, calls build and install, and serves the
original, rebuilt, and installed SVGs through a loopback Node HTTP server.
Rendering fixes device scale at 1, uses exact integer viewports and backgrounds,
reduces motion, disables screenshot animation, hides the caret, and depends on
no external fonts.

The 46-case Chromium matrix is:

- favicon: 16, 24, 32, and 48 px against white, light gray, charcoal, and black;
- full-color mark: 64, 128, and 256 px against white and charcoal;
- dark and light monochrome marks: 64, 128, and 256 px against two appropriate contrasting backgrounds each;
- horizontal lockup: 235x70, 470x140, and 940x280 against white and charcoal;
- stacked lockup: 150x140, 300x280, and 600x560 against white and charcoal.

Firefox and WebKit each render all six assets once at a representative role-
appropriate size/background. Smoke assertions cover successful loads, expected
intrinsic and rendered dimensions, absence of console/page errors, non-empty
visible output, and exact same-process original/rebuilt equality. They do not
own separate committed golden families.

## Baseline and determinism policy

Committed Chromium goldens live under `test/visual/baselines/chromium/` and are
generated only on Linux/amd64 with the exact Playwright version. Normal macOS
development runs still execute exact same-run equivalence but do not compare or
rewrite the Linux goldens. The configuration rejects snapshot-update mode on a
non-Linux host. CI invokes only `npm run test:visual`, so missing or changed
goldens fail and Playwright emits useful result, diff, and trace artifacts
without refreshing source files.

Both same-run comparisons and Linux Chromium goldens use zero tolerance:
`maxDiffPixels = 0` and color threshold `0`. No instability was observed in the
pinned Linux Chromium run, so there is no non-zero platform or pixel allowance.
If that changes, the first response is to reproduce and identify the unstable
input; the global threshold must not be weakened as a convenience.

Contributor commands:

```sh
npx playwright install chromium firefox webkit
npm run test:visual
```

Baseline updates are explicit source mutations and must be generated and
reviewed in the pinned Linux environment:

```sh
npm run test:visual:update
```

## Related TFSB2 observation dispositions

Build receipts now use `tfsb-build-v2` / schema 2 and record only the configured
project-relative build directory, so relocating the entire project retains
ownership. A valid receipt copied into a different configured build path fails
closed. Because v0.1 has not been released, v1 receipts are not migrated; a
pre-TFSB3 generated build directory must be removed once and rebuilt.

Install backup cleanup now occurs after the transactional replacement boundary.
A cleanup failure reports `INSTALL_BACKUP_CLEANUP_FAILED` without rolling back
already successful replacements, avoiding loss when an earlier backup has
already been deleted. Import continues to sync written files before rename, but
no platform-specific directory-fsync claim or machinery is added; directory
entry crash durability remains outside the portable v0.1 contract.

## Rollback

Rollback removes the Playwright dev dependency and lock entries, visual config,
visual tests and baselines, contributor scripts, visual CI job, and this note.
It does not change the SVG/TOML schema or persisted canonical project state.
