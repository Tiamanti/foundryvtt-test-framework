import { access, mkdir, cp } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const REQUIRED_CONFIG_FIELDS = ["foundryLicenseKey", "sourceDataPath", "testDataPath", "foundryNodePath", "diceOverrideExtensionPath"]

async function pathExists(p) {
    try { await access(p); return true } catch { return false }
}

async function validateConfig(config) {
    for (const field of REQUIRED_CONFIG_FIELDS) {
        if (!config[field]) throw new Error(`config.mjs is missing required field: ${field}`)
    }
    if (!(await pathExists(config.foundryNodePath))) {
        throw new Error(`foundryNodePath not found: ${config.foundryNodePath}\nUnpack FoundryVTT Node.js into the FoundryVTT-Node/ folder.`)
    }
    if (!(await pathExists(config.sourceDataPath))) {
        throw new Error(`sourceDataPath not found: ${config.sourceDataPath}`)
    }
    console.log("  Config valid.")
}

async function validateExtension(config) {
    const manifest = join(config.diceOverrideExtensionPath, "manifest.json")
    const content = join(config.diceOverrideExtensionPath, "content.js")
    if (!(await pathExists(manifest))) throw new Error(`dice-override/manifest.json not found at: ${manifest}`)
    if (!(await pathExists(content))) throw new Error(`dice-override/content.js not found at: ${content}`)
    console.log("  dice-override extension present.")
}

async function createTestDataFolder(config) {
    await mkdir(config.testDataPath, { recursive: true })
    console.log(`  Test data folder: ${config.testDataPath}`)

    const modules = config.modulesToCopy ?? []
    const worlds = config.worldsToCopy ?? []

    for (const id of modules) {
        const src = join(config.sourceDataPath, "Data", "modules", id)
        const dest = join(config.testDataPath, "modules", id)
        if (!(await pathExists(src))) {
            console.warn(`  WARNING: module "${id}" not found at ${src} — skipping`)
            continue
        }
        await mkdir(join(config.testDataPath, "modules"), { recursive: true })
        await cp(src, dest, { recursive: true })
        console.log(`  Copied module: ${id}`)
    }

    for (const id of worlds) {
        const src = join(config.sourceDataPath, "Data", "worlds", id)
        const dest = join(config.testDataPath, "worlds", id)
        if (!(await pathExists(src))) {
            console.warn(`  WARNING: world "${id}" not found at ${src} — skipping`)
            continue
        }
        await mkdir(join(config.testDataPath, "worlds"), { recursive: true })
        await cp(src, dest, { recursive: true })
        console.log(`  Copied world: ${id}`)
    }

    if (modules.length === 0 && worlds.length === 0) {
        console.log("  No modules or worlds configured to copy (see modulesToCopy / worldsToCopy in config.mjs).")
    }
}

async function main() {
    const configPath = fileURLToPath(new URL("../config.mjs", import.meta.url))

    let config
    try {
        const mod = await import(configPath)
        config = mod.default
    } catch {
        console.error(
            "ERROR: config.mjs not found.\n" +
            "Copy config.example.mjs to config.mjs and fill in your values:\n" +
            "  cp config.example.mjs config.mjs"
        )
        process.exit(1)
    }

    console.log("Setting up foundryvtt-test-framework...")

    try {
        await validateConfig(config)
        await validateExtension(config)
        await createTestDataFolder(config)
        console.log("\nSetup complete. You can now use FoundryTestFramework.")
    } catch (err) {
        console.error(`\nSetup failed: ${err.message}`)
        process.exit(1)
    }
}

main()
