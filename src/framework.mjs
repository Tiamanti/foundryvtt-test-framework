import { spawn } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { request } from "node:http"
import puppeteer from "puppeteer"
import { waitForCondition, takeScreenshot } from "./helpers.mjs"

export class FoundryTestFramework {
    constructor(config) {
        this.config = config
        this.serverProcess = null
        this.browser = null
        this.page = null
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    async start() {
        await this._spawnServer()
        await this._waitForServerReady()
        await this._launchBrowser()
        await this._navigateAndWait()
        return this
    }

    async stop() {
        await this.browser?.close().catch(() => {})
        this.browser = null
        this.page = null

        if (this.serverProcess) {
            this.serverProcess.kill()
            this.serverProcess = null
        }
    }

    // -------------------------------------------------------------------------
    // Test helpers
    // -------------------------------------------------------------------------

    /** Execute fn in the Foundry page context. Passes extra args as JSON-serializable values. */
    async executeInFoundry(fn, ...args) {
        return this.page.evaluate(fn, ...args)
    }

    /**
     * Push a dice override onto the extension queue.
     * The next roll matching faces/count will return the given value instead of a random result.
     * @param {number} faces - die type (e.g. 6 for d6, 100 for d100)
     * @param {number} count - number of dice (e.g. 2 for 2d6), or null to match any count
     * @param {number} value - desired total
     */
    async queueDiceOverride(faces, count, value) {
        await this.page.evaluate((f, c, v) => {
            window.__diceOverrideQueue.push({ faces: f, number: c, value: v, consumed: false })
        }, faces, count, value)
    }

    /**
     * Wait until a chat message matching matcher appears, then return it.
     * matcher receives a plain object with message data.
     * @param {Function} matcher - serializable function evaluated in Foundry context
     * @param {number} timeout
     */
    async waitForChatMessage(matcher, timeout = 10000) {
        const matcherStr = matcher.toString()
        const result = await waitForCondition(
            this.page,
            new Function(`
                const matcher = ${matcherStr};
                const messages = game.messages?.contents ?? [];
                return messages.find(m => matcher(m)) ?? null;
            `),
            timeout
        )
        if (!result) throw new Error(`waitForChatMessage: no matching message found within ${timeout}ms`)
        return result
    }

    /** Wait for game.ready === true (Foundry fully initialized). */
    async waitForFoundryReady() {
        await waitForCondition(
            this.page,
            () => typeof game !== "undefined" && game?.ready === true,
            this.config.foundryReadyTimeout ?? 60000,
            1000
        )
    }

    /** Take a debug screenshot saved to test-data/screenshots/<filename>. */
    async screenshot(filename) {
        return takeScreenshot(this.page, this.config.testDataPath, filename)
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    _spawnServer() {
        const { foundryNodePath, testDataPath, foundryServerPort } = this.config
        const args = ["main.js", `--dataPath=${testDataPath}`]
        if (foundryServerPort !== 30000) args.push(`--port=${foundryServerPort}`)

        console.log(`[foundryvtt-test-framework] Starting Foundry server on port ${foundryServerPort ?? 30000}...`)
        this.serverProcess = spawn("node", args, {
            cwd: foundryNodePath,
            stdio: ["ignore", "pipe", "pipe"],
        })

        this.serverProcess.stdout.on("data", d => process.stdout.write(`[foundry] ${d}`))
        this.serverProcess.stderr.on("data", d => process.stderr.write(`[foundry] ${d}`))
        this.serverProcess.on("error", err => { throw new Error(`Foundry server failed to start: ${err.message}`) })

        return Promise.resolve()
    }

    async _waitForServerReady() {
        const port = this.config.foundryServerPort ?? 30000
        const timeout = this.config.serverReadyTimeout ?? 30000
        const deadline = Date.now() + timeout

        while (Date.now() < deadline) {
            const ok = await new Promise(resolve => {
                const req = request({ host: "localhost", port, method: "HEAD", path: "/" }, res => {
                    resolve(res.statusCode < 500)
                })
                req.on("error", () => resolve(false))
                req.end()
            })
            if (ok) {
                console.log("[foundryvtt-test-framework] Foundry server ready.")
                return
            }
            await new Promise(r => setTimeout(r, 500))
        }
        throw new Error(`Foundry server did not become ready within ${timeout}ms`)
    }

    async _launchBrowser() {
        const { diceOverrideExtensionPath, headless } = this.config
        const chromeProfilePath = fileURLToPath(new URL("../chrome-profile", import.meta.url))

        console.log("[foundryvtt-test-framework] Launching browser...")
        this.browser = await puppeteer.launch({
            headless: headless ?? false,
            args: [
                `--load-extension=${diceOverrideExtensionPath}`,
                `--disable-extensions-except=${diceOverrideExtensionPath}`,
                `--user-data-dir=${chromeProfilePath}`,
            ],
        })
    }

    async _navigateAndWait() {
        const port = this.config.foundryServerPort ?? 30000
        const pages = await this.browser.pages()
        this.page = pages[0] ?? await this.browser.newPage()

        console.log("[foundryvtt-test-framework] Navigating to Foundry...")
        await this.page.goto(`http://localhost:${port}`, { waitUntil: "networkidle2" })
        await this.waitForFoundryReady()
        console.log("[foundryvtt-test-framework] Foundry ready.")
    }
}
