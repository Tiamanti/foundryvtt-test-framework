import { fileURLToPath } from "node:url"

export default {
    // Foundry license key (required for first-time server setup)
    foundryLicenseKey: "YOUR_LICENSE_KEY_HERE",

    // Existing Foundry data folder to copy test assets from
    sourceDataPath: "C:\\Users\\YourName\\AppData\\Local\\FoundryVTT",

    // Module and world IDs to copy from sourceDataPath into the test data folder
    modulesToCopy: [],   // e.g. ["wfrp4e", "wfrp4e-core"]
    worldsToCopy: [],    // e.g. ["my-test-world"]

    // Paths — auto-derived relative to this config file; override if needed
    testDataPath: fileURLToPath(new URL("./test-data", import.meta.url)),
    foundryNodePath: fileURLToPath(new URL("./FoundryVTT-Node", import.meta.url)),
    diceOverrideExtensionPath: fileURLToPath(new URL("./dice-override", import.meta.url)),

    // Server and browser settings
    foundryServerPort: 30000,
    headless: false,

    // Timeouts in milliseconds
    serverReadyTimeout: 30000,
    foundryReadyTimeout: 60000,
}
