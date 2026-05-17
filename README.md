# foundryvtt-test-framework

End-to-end test framework for Foundry VTT modules and systems. Runs a live Foundry instance, controls it via Puppeteer, and uses a bundled Chrome extension to force dice rolls to specific values for fully reproducible tests.

> **Developer-local only.** Tests require a local Foundry installation and cannot run in CI.

## How it works

1. Spawns the Foundry Node.js server against an isolated test data folder
2. Launches a Chromium browser with the `dice-override` extension loaded
3. Your test code calls helper methods to navigate Foundry, queue forced dice results, and assert outcomes

## Prerequisites

- Node.js 18+
- A Foundry VTT license key
- An existing Foundry data folder (to copy modules/worlds from)
- The `FoundryVTT-Node/` folder unpacked in this package directory (not tracked in git)

To start the Foundry server manually:
```sh
node FoundryVTT-Node/main.js --dataPath=<path>
```

## Setup

**1. Install dependencies** (from monorepo root):
```sh
npm install
```

**2. Create your local config:**
```sh
cp config.example.mjs config.mjs
```
Then edit `config.mjs` — fill in your license key, source data path, and the module/world IDs you want available in tests.

**3. Run setup** (creates the test data folder and copies assets):
```sh
npm run setup --workspace=packages/foundryvtt-test-framework
```

## Writing tests

Import `FoundryTestFramework` and your `config.mjs`, then call `start()` / `stop()` around your test suite.

```js
import { FoundryTestFramework } from "./src/framework.mjs"
import config from "./config.mjs"

const fw = new FoundryTestFramework(config)

// --- setup ---
await fw.start()  // spawns server, launches browser, waits for game.ready

// --- test ---
await fw.queueDiceOverride(6, 1, 6)                    // next d6 will return 6
await fw.executeInFoundry(() => game.user.roll("1d6")) // trigger a roll in Foundry
const msg = await fw.waitForChatMessage(m => m.rolls?.length > 0)
console.assert(msg.rolls[0].total === 6)

// --- teardown ---
await fw.stop()
```

### API reference

| Method | Description |
|--------|-------------|
| `start()` | Spawns Foundry server, launches browser, waits for `game.ready`. Returns `this`. |
| `stop()` | Closes browser and kills the server process. |
| `executeInFoundry(fn, ...args)` | Evaluates `fn` in the live Foundry page context via `page.evaluate()`. |
| `queueDiceOverride(faces, count, value)` | Forces the next matching roll to return `value`. Uses FIFO matching on die type and count. Pass `null` for `count` to match any count. |
| `waitForChatMessage(matcher, timeout?)` | Polls `game.messages` until `matcher(message)` returns truthy. Default timeout 10 s. |
| `waitForFoundryReady(timeout?)` | Waits for `game.ready === true`. Called automatically by `start()`. |
| `screenshot(filename)` | Saves a debug screenshot to `test-data/screenshots/<filename>`. |

## Configuration

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `foundryLicenseKey` | Yes | — | Your Foundry VTT license key |
| `sourceDataPath` | Yes | — | Existing Foundry data folder to copy assets from |
| `testDataPath` | Yes | `./test-data` | Isolated data folder used during tests |
| `foundryNodePath` | Yes | `./FoundryVTT-Node` | Path to the unpacked Foundry Node.js server |
| `diceOverrideExtensionPath` | Yes | `./dice-override` | Path to the bundled Chrome extension |
| `modulesToCopy` | No | `[]` | Module IDs to copy from `sourceDataPath` into `testDataPath` |
| `worldsToCopy` | No | `[]` | World IDs to copy from `sourceDataPath` into `testDataPath` |
| `foundryServerPort` | No | `30000` | Port the Foundry server listens on |
| `headless` | No | `false` | Run Chrome headless (useful for scripted runs) |
| `serverReadyTimeout` | No | `30000` | Ms to wait for the HTTP server to respond |
| `foundryReadyTimeout` | No | `60000` | Ms to wait for `game.ready` after page load |

## Dice override extension

The `dice-override/` directory is a Manifest V3 Chrome extension that patches `Roll.prototype._evaluateASTAsync` before Foundry processes results. It exposes `window.__diceOverrideQueue` — a plain array that `queueDiceOverride()` pushes entries onto via `page.evaluate()`. The extension only activates on `http://localhost/*`.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
