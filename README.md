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

## Usage as a library

Install in your package:
```sh
npm install --save-dev foundryvtt-test-framework
```

**1. Create your config** in your package (copy from `config.example.mjs` in this repo, or write from scratch):
```js
// tests/e2e/config.mjs
import { fileURLToPath } from "node:url"

export default {
    // license.json is copied automatically from sourceDataPath/Config/
    sourceDataPath:            "C:\\Users\\YourName\\AppData\\Local\\FoundryVTT",
    systemsToCopy:             ["wfrp4e"],
    modulesToCopy:             ["your-module-id"],
    worldsToCopy:              ["your-test-world"],
    testDataPath:              fileURLToPath(new URL("../../test-data", import.meta.url)),
    foundryNodePath:           fileURLToPath(new URL("../../../foundryvtt-test-framework/FoundryVTT-Node", import.meta.url)),
    diceOverrideExtensionPath: fileURLToPath(new URL("../../../foundryvtt-test-framework/dice-override", import.meta.url)),
    foundryServerPort:         30000,
    headless:                  false,
}
```

**2. Create a setup script** in your package:
```js
// tests/e2e/setup.mjs
import { runSetup } from "foundryvtt-test-framework/setup"
import config from "./config.mjs"

await runSetup(config)
```

Add to your `package.json` scripts:
```json
"setup:e2e": "node tests/e2e/setup.mjs",
"test:e2e":  "node tests/e2e/your-test.mjs"
```

**3. Run setup** (creates the test data folder and copies assets):
```sh
npm run setup:e2e
```

## Writing tests

Import `FoundryTestFramework` and your local `config.mjs`, then call `start()` / `stop()` around your test suite.

```js
import { FoundryTestFramework } from "foundryvtt-test-framework"
import config from "./config.mjs"
import assert from "node:assert/strict"

const fw = new FoundryTestFramework(config)
await fw.start()  // spawns server, launches browser, logs in, waits for game.ready

// send a chat command, interact with the resulting card
await fw.sendChatCommand("/my-module start")
await fw.selectTokensByName(["Hero"])
await fw.clickInLastChatMessage('[data-action="joinGroup"]')
await fw.clickInLastChatMessage('[data-action="start"]')

// queue a forced d100 result, click Roll in the card, submit the dialog
await fw.queueDiceOverride(100, 1, 25)
await fw.clickInLastChatMessage('[data-action="rollSkill"]')
await fw.submitDialog()

// poll for the expected state (return plain objects, not Foundry Documents)
const state = await fw.waitFor(() => {
    const flags = game.messages.contents.at(-1)?.flags?.["my-module"]
    return flags?.state === "complete" ? { result: flags.result } : null
})
assert.strictEqual(state.result, "success")

await fw.stop()
```

### API reference

| Method | Description |
|--------|-------------|
| `start()` | Spawns Foundry server, launches browser, waits for `game.ready`. Returns `this`. |
| `stop()` | Closes browser and kills the server process. |
| `executeInFoundry(fn, ...args)` | Evaluates `fn` in the live Foundry page context via `page.evaluate()`. |
| `queueDiceOverride(faces, count, value)` | Forces the next matching roll to return `value`. Uses FIFO matching on die type and count. Pass `null` for `count` to match any count. |
| `waitForChatMessage(matcher, timeout?)` | Polls `game.messages` until `matcher(message)` returns truthy. Resolves (returns `undefined`) when found. Default timeout 10 s. |
| `waitFor(fn, timeout?)` | Polls a browser-side predicate until it returns truthy, then returns that value. Return plain serializable objects, not Foundry Documents. |
| `waitForFoundryReady(timeout?)` | Waits for `game.ready === true`. Called automatically by `start()`. |
| `screenshot(filename)` | Saves a debug screenshot to `<testDataPath>/screenshots/<filename>`. |
| `sendChatCommand(text)` | Opens the Chat tab, types `text` into the editor, and submits with Enter. |
| `clearChat()` | Clicks "Clear Chat Log" and confirms the dialog. |
| `submitDialog()` | Waits for a Foundry application dialog and clicks its submit button. |
| `waitForTextInLastChatMessage(text, timeout?)` | Polls until an element with matching trimmed text appears in the most recent chat message. Default timeout 10 s. |
| `waitForTextInLastChatMessageContaining(cardSelector, text, timeout?)` | Polls until text appears inside the last chat message that contains a matching card element. Default timeout 10 s. |
| `clickInLastChatMessage(selector)` | Clicks the element matching `selector` inside the most recent chat message. |
| `writeInLastChatMessageContaining(cardSelector, inputSelector, value)` | Sets the value of an input inside the last chat message containing `cardSelector` and dispatches a `change` event. |
| `clickInLastChatMessageContaining(cardSelector, selector)` | Clicks `selector` inside the last chat message that contains `cardSelector`. |
| `clickInLastChatMessageByText(text)` | Clicks the element whose trimmed text content equals `text` inside the most recent chat message. |
| `rightClickLastChatMessage(itemText)` | Right-clicks the last chat message to open its context menu, then clicks the item whose span text equals `itemText`. |
| `selectTokensByName(names)` | Targets tokens on the active scene by display name (clears previous targets). Throws if any name is not found. |
| `getActorFromTokenByName(name)` | Finds a token by display name on the active scene and returns the actor's plain data object (`actor.toObject()`) with `tokenUuid` merged in. |

### Exported entry points

| Import path | Exports |
|-------------|---------|
| `foundryvtt-test-framework` | `FoundryTestFramework` class |
| `foundryvtt-test-framework/setup` | `runSetup(config)` async function |

## Configuration

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `sourceDataPath` | Yes | — | Existing Foundry data folder. `Config/license.json` is copied from here automatically. |
| `testDataPath` | Yes | — | Isolated data folder used during tests |
| `foundryNodePath` | Yes | — | Path to the unpacked Foundry Node.js server |
| `diceOverrideExtensionPath` | Yes | — | Path to the bundled Chrome extension |
| `systemsToCopy` | No | `[]` | System IDs to copy from `sourceDataPath` into `testDataPath` |
| `modulesToCopy` | No | `[]` | Module IDs to copy from `sourceDataPath` into `testDataPath` |
| `worldsToCopy` | No | `[]` | World IDs to copy from `sourceDataPath` into `testDataPath` |
| `foundryServerPort` | No | `30000` | Port the Foundry server listens on |
| `world` | No | — | World ID to auto-load on startup (`--world=` flag passed to Foundry) |
| `loginUser` | No | `"Gamemaster"` | Display name of the Foundry user to log in as on the join screen |
| `headless` | No | `false` | Run Chrome headless (useful for scripted runs) |
| `serverReadyTimeout` | No | `30000` | Ms to wait for the HTTP server to respond |
| `foundryReadyTimeout` | No | `60000` | Ms to wait for `game.ready` after page load |

## Dice override extension

The `dice-override/` directory is a Manifest V3 Chrome extension that patches `Roll.prototype._evaluateASTAsync` before Foundry processes results. It exposes `window.__diceOverrideQueue` — a plain array that `queueDiceOverride()` pushes entries onto via `page.evaluate()`. The extension only activates on `http://localhost/*`.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
