# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this package is

A library (not an application) that consuming Foundry VTT modules/systems install as `devDependency`. It boots a real Foundry Node server against an isolated data folder, drives the client via Playwright (`chromium.launchPersistentContext`), and uses a bundled MV3 Chrome extension to force dice results — giving deterministic E2E tests.

Two public entry points:
- `foundryvtt-test-framework` → `FoundryTestFramework` class (`src/framework.mjs`)
- `foundryvtt-test-framework/setup` → `runSetup(config)` (`src/setup.mjs`)

## Developer-local only

Tests cannot run in CI. They require:
- A local Foundry VTT license + an existing Foundry data folder (assets are copied from there into the isolated test folder).
- **`FoundryVTT-Node/` unpacked at the repo root.** It is gitignored and `runSetup` will fail if missing. The framework spawns it with `node FoundryVTT-Node/main.js --dataPath=<testDataPath>`.

There is no `config.mjs` in this repo — only `config.example.mjs`. Consumers write their own config; the `npm run setup` script in this repo is mostly a fallback for local smoke tests.

## Commands

- `npm run setup` — runs `src/setup.mjs` against a `config.mjs` at the repo root (must be created from `config.example.mjs`). Validates config, checks the extension, creates `testDataPath`, and copies `license.json` + listed systems/modules/worlds from `sourceDataPath`.
- `npm test` — placeholder; this package has no test runner. Consumers wire up their own `node tests/e2e/<file>.mjs` scripts that instantiate `FoundryTestFramework`.

## Architecture

### `src/framework.mjs` — `FoundryTestFramework`
Lifecycle: `start()` → `_spawnServer` (child_process `node main.js`) → `_waitForServerReady` (HTTP HEAD poll) → `_launchBrowser` (`chromium.launchPersistentContext` with `--load-extension` + dedicated `chrome-profile/` user data dir; extensions require headed mode or `headless: "new"`) → `_navigateAndWait` → `_login` (selects user by display name on the join screen) → `waitForFoundryReady` (polls `game.ready === true`).

**Playwright vs Puppeteer arg passing.** `page.evaluate` in Playwright accepts only one argument, where Puppeteer was variadic. `helpers.mjs:buildEvaluator` papers over this: 0/1 arg calls go through as-is; 2+ arg calls are wrapped — fn is stringified and re-evaluated in the page so the args array can be spread back into the original signature. `executeInFoundry`, `waitFor`, and `waitForCondition` all flow through that helper, so test helpers can keep writing `fw.waitFor((a, b) => ..., timeout, a, b)`.

Test helpers fall into three patterns:
1. **Direct DOM via `page.evaluate`** — `clickInLastChatMessage`, `submitDialog`, `selectTokensByName`, etc. All scope to the last `li.chat-message` under `.chat-scroll`. Functions passed in are stringified and run in the page context, so they must be serializable and use Foundry globals (`game`, `canvas`, `Roll`) directly.
2. **Polling predicates** — `waitFor`, `waitForChatMessage`, `waitForTextInLastChatMessage*` all flow through `helpers.mjs:waitForCondition`, which retries `page.evaluate` every 500ms until truthy or timeout. **Predicates must return a plain serializable object, never a Foundry Document instance** — Playwright can't structure-clone Documents across the bridge. `getActorFromTokenByName` enforces this by returning `actor.toObject()` with `tokenUuid` merged in.
3. **Dice override** — `queueDiceOverride(faces, count, value)` pushes onto `window.__diceOverrideQueue`, which the extension consumes FIFO.

Most click helpers call `_pause(100)` after acting to let Foundry's reactive UI settle. If a new helper interacts with the DOM and the next assertion is racey, follow the same pattern.

### `dice-override/` — Chrome MV3 extension (MAIN world)
- `manifest.json` restricts matches to `http://localhost/*` — the extension is inert anywhere else.
- `content.js` waits for `window.Roll` to exist, then monkey-patches `Roll.prototype._evaluateASTAsync`. On each evaluated DiceTerm node it scans `window.__diceOverrideQueue` for the first non-consumed entry matching `faces` and `number` (with `null` meaning wildcard), and rewrites `node.results[*].result` to sum to the desired total. Success-counting dice (`r.count !== undefined`, e.g. WFRP hit location) are skipped intentionally.
- The queue is owned by the extension (declared on `window`); the framework only pushes onto it via `page.evaluate`. Don't try to read it back via Playwright.

### `src/setup.mjs`
Idempotent-ish bootstrap. Copies `<sourceDataPath>/Config/license.json` and any listed systems/modules/worlds into `<testDataPath>`. Missing assets log a warning but don't abort. Re-running over an existing `testDataPath` will overwrite copied folders (Node's `cp` recursive copy).

### `src/helpers.mjs`
Just `waitForCondition` (used by every polling helper) and `takeScreenshot` (writes to `<testDataPath>/screenshots/`). Errors inside the evaluated predicate are swallowed and treated as "not ready yet" — this is intentional because the page may not have `game` defined during early polling.

## Conventions

- **ES modules only** (`"type": "module"`, all files `.mjs`).
- **Indentation is 4 spaces**, no semicolons in `src/`, semicolons in `dice-override/content.js` (it's plain browser JS, not a module).
- Helpers that touch the DOM throw descriptive errors that name the selector that failed — match this style when adding new ones, since failures otherwise look like opaque Playwright stack traces.
- Don't add abstractions for hypothetical helpers. Each helper exists because a real test needed it; keep new ones in the same minimal style.
