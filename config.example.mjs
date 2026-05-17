import { fileURLToPath } from "node:url"

export default {
    // Existing Foundry data folder to copy test assets from.
    // license.json is copied automatically from sourceDataPath/Config/.
    sourceDataPath: "C:\\Users\\YourName\\AppData\\Local\\FoundryVTT",

    // System, module, and world IDs to copy from sourceDataPath into the test data folder
    systemsToCopy: [],   // e.g. ["wfrp4e"]
    modulesToCopy: [],   // e.g. ["wfrp4e-pursuits", "wfrp4e-core"]
    worldsToCopy:  [],   // e.g. ["my-test-world"]

    // Paths — auto-derived relative to this config file; override if needed
    testDataPath:              fileURLToPath(new URL("./test-data", import.meta.url)),
    foundryNodePath:           fileURLToPath(new URL("./FoundryVTT-Node", import.meta.url)),
    diceOverrideExtensionPath: fileURLToPath(new URL("./dice-override", import.meta.url)),

    // Server and browser settings
    foundryServerPort: 30000,
    world:             "your-test-world",  // passed as --world= to the Foundry server
    loginUser:         "Gamemaster",       // display name of the user to log in as
    headless:          false,

    // Timeouts in milliseconds
    serverReadyTimeout:  30000,
    foundryReadyTimeout: 60000,
}
