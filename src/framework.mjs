import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { request } from "node:http"
import { chromium } from "playwright"
import { waitForCondition, takeScreenshot, buildEvaluator } from "./helpers.mjs"

/**
 * All page-bound test helpers, decoupled from the server/browser lifecycle.
 * Used directly by FoundryTestFramework (via inheritance) and returned by
 * openAsUser() for secondary browser sessions.
 */
export class FoundryPageHelper {
    constructor(page, closeCallback = null) {
        this.page = page
        this._closeCallback = closeCallback
    }

    async close() {
        await this._closeCallback?.()
    }

    // -------------------------------------------------------------------------
    // Test helpers
    // -------------------------------------------------------------------------

    /** Execute fn in the Foundry page context. Variadic args are spread back into fn inside the page. */
    async executeInFoundry(fn, ...args) {
        return buildEvaluator(fn, args)(this.page)
    }

    /**
     * Push a dice override onto the extension queue.
     * The next roll matching faces/count will return the given value instead of a random result.
     * @param {number} faces
     * @param {number} count
     * @param {number} value
     */
    async queueDiceOverride(faces, count, value) {
        await this.page.evaluate(({ f, c, v }) => {
            window.__diceOverrideQueue.push({ faces: f, number: c, value: v, consumed: false })
        }, { f: faces, c: count, v: value })
    }

    /**
     * Wait until a chat message matching matcher appears.
     * matcher is serialized to a string and reconstructed in the page.
     */
    async waitForChatMessage(matcher, timeout = 10000) {
        const matcherStr = matcher.toString()
        await waitForCondition(
            this.page,
            ({ matcherStr }) => {
                const matcher = (0, eval)("(" + matcherStr + ")")
                const messages = game.messages?.contents ?? []
                return messages.some(m => matcher(m)) ? true : null
            },
            timeout,
            500,
            { matcherStr }
        )
    }

    /**
     * Poll a browser-side predicate until it returns a truthy value, then return that value.
     * Extra args (after timeout) are forwarded into the page context.
     */
    async waitFor(fn, timeout = 10000, ...args) {
        const result = await waitForCondition(this.page, fn, timeout, 500, ...args)
        if (result === null || result === undefined) throw new Error(`waitFor: condition not met within ${timeout}ms`)
        return result
    }

    async waitForSelector(selector, timeout = 10000) {
        await this.waitFor((sel) => document.querySelector(sel) ? true : null, timeout, selector)
    }

    async waitForNoSelector(selector, timeout = 10000) {
        await this.waitFor((sel) => !document.querySelector(sel) ? true : null, timeout, selector)
    }

    async waitForSelectorCount(selector, count, timeout = 10000) {
        await this.waitFor(
            ({ sel, n }) => document.querySelectorAll(sel).length >= n ? true : null,
            timeout,
            { sel: selector, n: count }
        )
    }

    async waitForFoundryReady() {
        await waitForCondition(
            this.page,
            () => typeof game !== "undefined" && game?.ready === true,
            this.config?.foundryReadyTimeout ?? 60000,
            1000
        )
    }

    /** Take a debug screenshot saved to test-data/screenshots/<filename>. */
    async screenshot(filename) {
        return takeScreenshot(this.page, this.config?.testDataPath, filename)
    }

    async openChat() {
        const chatSel = '[aria-label="Chat Messages"]'
        await this.page.waitForSelector(chatSel, { state: "visible" })
        await this.page.click(chatSel)
        await this._pause()
    }

    async clearChat() {
        const chatSel = '[aria-label="Chat Messages"]'
        await this.page.waitForSelector(chatSel, { state: "visible" })
        await this.page.click(chatSel)
        await this._pause()

        await this.page.waitForSelector('[aria-label="Clear Chat Log"]', { state: "visible" })
        await this.page.evaluate(() => document.querySelector('[aria-label="Clear Chat Log"]').click())
        await this._pause()

        const confirmSel = 'button[type="submit"][data-action="yes"]'
        await this.page.waitForSelector(confirmSel, { state: "visible" })
        await this.page.click(confirmSel)
        await this._pause()
    }

    async submitDialog() {
        const sel = "footer.form-footer button[type='submit']"
        await this.page.waitForSelector(sel, { state: "visible" })
        await this.page.click(sel)
        await this._pause()
    }

    async sendChatCommand(text) {
        const chatSel = '[aria-label="Chat Messages"]'
        await this.page.waitForSelector(chatSel, { state: "visible" })
        await this.page.click(chatSel)
        await this._pause()

        const editorSel = ".editor-container div[contenteditable='true']"
        await this.page.waitForSelector(editorSel, { state: "visible" })
        await this.page.click(editorSel)
        await this._pause()

        await this.page.keyboard.type(text)
        await this.page.keyboard.press("Enter")
    }

    async clickInLastChatMessage(selector) {
        await this.page.evaluate((sel) => {
            const messages = document.querySelectorAll(".chat-scroll li.chat-message")
            const last = messages[messages.length - 1]
            if (!last) throw new Error("No chat messages found")
            const btn = last.querySelector(sel)
            if (!btn) throw new Error(`clickInLastChatMessage: "${sel}" not found in last chat message`)
            btn.click()
        }, selector)
        await this._pause()
    }

    async waitForTextInLastChatMessage(text, timeout = 10000) {
        await waitForCondition(
            this.page,
            (text) => {
                const messages = document.querySelectorAll(".chat-scroll li.chat-message")
                const last = messages[messages.length - 1]
                if (!last) return null
                return Array.from(last.querySelectorAll("*")).some(e => e.textContent.trim() === text) ? true : null
            },
            timeout,
            500,
            text
        )
    }

    async waitForTextInLastChatMessageContaining(cardSelector, text, timeout = 10000) {
        await waitForCondition(
            this.page,
            ({ cardSel, text }) => {
                const messages = Array.from(document.querySelectorAll(".chat-scroll li.chat-message"))
                const cardMsg = messages.findLast(m => m.querySelector(".message-content " + cardSel))
                if (!cardMsg) return null
                const card = cardMsg.querySelector(".message-content " + cardSel)
                return Array.from(card.querySelectorAll("*")).some(e => e.textContent.trim() === text) ? true : null
            },
            timeout,
            500,
            { cardSel: cardSelector, text }
        )
    }

    async writeInLastChatMessageContaining(cardSelector, inputSelector, value) {
        await this.page.evaluate(({ cardSel, inputSel, value }) => {
            const messages = Array.from(document.querySelectorAll(".chat-scroll li.chat-message"))
            const cardMsg = messages.findLast(m => m.querySelector(".message-content " + cardSel))
            if (!cardMsg) throw new Error(`writeInLastChatMessageContaining: no message with "${cardSel}" found in chat`)
            const input = cardMsg.querySelector(".message-content " + cardSel + " " + inputSel)
            if (!input) throw new Error(`writeInLastChatMessageContaining: "${inputSel}" not found inside "${cardSel}"`)
            input.value = value
            input.dispatchEvent(new Event("change", { bubbles: true }))
        }, { cardSel: cardSelector, inputSel: inputSelector, value })
    }

    async clickInLastChatMessageContaining(cardSelector, selector) {
        await this.page.evaluate(({ cardSel, sel }) => {
            const messages = Array.from(document.querySelectorAll(".chat-scroll li.chat-message"))
            const cardMsg = messages.findLast(m => m.querySelector(".message-content " + cardSel))
            if (!cardMsg) throw new Error(`clickInLastChatMessageContaining: no message with "${cardSel}" found in chat`)
            const btn = cardMsg.querySelector(".message-content " + cardSel + " " + sel)
            if (!btn) throw new Error(`clickInLastChatMessageContaining: "${sel}" not found inside "${cardSel}"`)
            btn.click()
        }, { cardSel: cardSelector, sel: selector })
        await this._pause()
    }

    async rightClickLastChatMessage(itemText) {
        const messages = await this.page.locator(".chat-sidebar .chat-scroll li.chat-message").all()
        const last = messages[messages.length - 1]
        if (!last) throw new Error("rightClickLastChatMessage: no chat messages found")
        await last.click({ button: "right" })
        await this._pause()

        await this.page.waitForSelector("nav#context-menu", { state: "visible" })

        await this.page.evaluate((text) => {
            const items = document.querySelectorAll("nav#context-menu li.context-item")
            const item = Array.from(items).find(li => {
                const span = li.querySelector("span")
                return span && span.textContent.trim() === text
            })
            if (!item) throw new Error(`rightClickLastChatMessage: context item "${text}" not found`)
            item.click()
        }, itemText)
        await this._pause()
    }

    async rightClickLastChatMessageContaining(containerSel, itemText) {
        const locator = this.page.locator(".chat-scroll li.chat-message").filter({ has: this.page.locator(".message-content " + containerSel) }).last()
        await locator.click({ button: "right" })
        await this._pause()

        await this.page.waitForSelector("nav#context-menu", { state: "visible" })

        await this.page.evaluate((text) => {
            const items = document.querySelectorAll("nav#context-menu li.context-item")
            const item = Array.from(items).find(li => {
                const span = li.querySelector("span")
                return span && span.textContent.trim() === text
            })
            if (!item) throw new Error(`rightClickLastChatMessageContaining: context item "${text}" not found`)
            item.click()
        }, itemText)
        await this._pause()
    }

    async clickInLastChatMessageByText(text) {
        await this.page.evaluate((text) => {
            const messages = document.querySelectorAll(".chat-scroll li.chat-message")
            const last = messages[messages.length - 1]
            if (!last) throw new Error("No chat messages found")
            const el = Array.from(last.querySelectorAll("*")).find(e => e.textContent.trim() === text)
            if (!el) throw new Error(`clickInLastChatMessageByText: "${text}" not found in last chat message`)
            el.click()
        }, text)
        await this._pause()
    }

    async selectTokensByName(names) {
        const missing = await this.page.evaluate((names) => {
            const tokens = canvas.tokens.objects.children
            const missing = []
            names.forEach((name, i) => {
                const token = tokens.find(t => t.name === name)
                if (!token) { missing.push(name); return }
                token.setTarget(true, { releaseOthers: i === 0 })
            })
            return missing
        }, names)
        if (missing.length) throw new Error(`selectTokensByName: tokens not found on scene: ${missing.join(", ")}`)
    }

    async getActorFromTokenByName(name) {
        return this.page.evaluate((name) => {
            const token = canvas.tokens.objects.children.find(t => t.name === name)
            if (!token) throw new Error(`getActorFromTokenByName: token "${name}" not found on scene`)
            if (!token.actor) throw new Error(`getActorFromTokenByName: token "${name}" has no actor`)
            return { tokenUuid: token.document.uuid, ...token.actor.toObject() }
        }, name)
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    _pause(ms = 100) {
        return new Promise(r => setTimeout(r, ms))
    }
}

/**
 * Playwright-based test framework for Foundry VTT.
 *
 * Lifecycle:
 *   - Spawn the Foundry node server (`main.js --dataPath=...`)
 *   - Launch a persistent Chromium context (extensions only work in persistent mode)
 *     with the dice-override extension loaded
 *   - Navigate to localhost, log in as the configured user, wait for game.ready
 *
 * The class exposes the same surface as the previous puppeteer-based version
 * (clickInLastChatMessage, waitFor, executeInFoundry, queueDiceOverride, ...)
 * so test helpers don't need to change.
 *
 * When driven by `@playwright/test`, attach the framework's `page` to the test
 * by calling `fw.attachPage(testInfo.page)` — that lets the runner capture
 * traces/screenshots/videos for the page the test actually drives. For
 * standalone usage (no Playwright runner), `fw.page` is the page the framework
 * created.
 */
export class FoundryTestFramework extends FoundryPageHelper {
    constructor(config) {
        super(null)
        this.config = config
        this.serverProcess = null
        this.context = null
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    async start() {
        // When `config.serverAlreadyRunning` is true (typically set by a Playwright
        // globalSetup that spawned Foundry once for the whole run), skip the
        // server spawn — just verify the server is reachable and proceed to the
        // browser. This keeps Foundry alive across worker restarts.
        if (!this.config.serverAlreadyRunning) {
            await this._spawnServer()
        }
        await this._waitForServerReady()
        await this._launchBrowser()
        await this._navigateAndWait()
        return this
    }

    async stop() {
        await this.context?.close().catch(() => {})
        this.context = null
        this.page = null

        if (this.serverProcess && !this.config.serverAlreadyRunning) {
            this.serverProcess.kill()
            this.serverProcess = null
        }
    }

    /**
     * Open a second Foundry session logged in as `userName` in an isolated browser context.
     *
     * When `config.diceOverrideExtensionPath` is set the session loads the dice-override
     * extension via a separate persistent profile (`chrome-profile-player/`) so extension-
     * dependent features (queueDiceOverride) work. Otherwise a plain headless context is used.
     *
     * Returns a FoundryPageHelper with the full helper API plus a `close()` method.
     *
     * @param {string} userName - Foundry display name of the user to log in as
     */
    async openAsUser(userName) {
        const port = this.config.foundryServerPort ?? 30000
        const { diceOverrideExtensionPath, headless } = this.config

        let context, browser = null

        if (diceOverrideExtensionPath) {
            // Extensions require a persistent context; use a dedicated player profile so
            // the cookie jar stays isolated from the primary GM session.
            const playerProfilePath = fileURLToPath(new URL("../chrome-profile-player", import.meta.url))
            context = await chromium.launchPersistentContext(playerProfilePath, {
                headless: headless === true ? "new" : false,
                viewport: null,
                args: [
                    `--disable-extensions-except=${diceOverrideExtensionPath}`,
                    `--load-extension=${diceOverrideExtensionPath}`,
                ],
            })
        } else {
            browser = await chromium.launch({ headless: true })
            context = await browser.newContext()
        }

        // Reuse the first open page (persistent context may already have one).
        const pages = context.pages()
        for (const p of pages.slice(1)) await p.close().catch(() => {})
        const page = pages[0] ?? await context.newPage()

        await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" })

        const hasLoginForm = await page.locator('select[name="userid"]').count().then(c => c > 0, () => false)
        if (hasLoginForm) {
            const found = await page.evaluate((name) => {
                const sel = document.querySelector('select[name="userid"]')
                if (!sel) return false
                const opt = Array.from(sel.options).find(o => o.text === name)
                if (!opt) return false
                sel.value = opt.value
                sel.dispatchEvent(new Event("change", { bubbles: true }))
                return true
            }, userName)

            if (!found) throw new Error(`openAsUser: user "${userName}" not found in Foundry login`)

            await page.evaluate(() => {
                const btn = Array.from(document.querySelectorAll("button"))
                    .find(b => b.textContent.trim() === "Join Game Session")
                btn?.click()
            })

            await new Promise(r => setTimeout(r, 3000))
        }

        await waitForCondition(page, () => typeof game !== "undefined" && game?.ready === true, 60000, 1000)

        return new FoundryPageHelper(page, async () => {
            await context.close().catch(() => {})
            await browser?.close().catch(() => {})
        })
    }

    // -------------------------------------------------------------------------
    // Static helpers — usable from Playwright globalSetup so the Foundry
    // server can outlive worker restarts.
    // -------------------------------------------------------------------------

    /**
     * Spawn a Foundry node server and wait until it responds on HTTP.
     * Returns an opaque handle; pass it to `FoundryTestFramework.stopServer`.
     */
    static async startServer(config) {
        const { foundryNodePath, testDataPath, foundryServerPort = 30000, world } = config
        const args = ["main.js", `--dataPath=${testDataPath}`]
        if (foundryServerPort !== 30000) args.push(`--port=${foundryServerPort}`)
        if (world) args.push(`--world=${world}`)

        console.log(`[foundryvtt-test-framework] Starting Foundry server on port ${foundryServerPort}...`)
        const proc = spawn("node", args, {
            cwd: foundryNodePath,
            stdio: ["ignore", "pipe", "pipe"],
        })
        proc.stdout.on("data", d => process.stdout.write(`[foundry] ${d}`))
        proc.stderr.on("data", d => process.stderr.write(`[foundry] ${d}`))
        proc.on("error", err => { throw new Error(`Foundry server failed to start: ${err.message}`) })

        const timeout = config.serverReadyTimeout ?? 30000
        const deadline = Date.now() + timeout
        while (Date.now() < deadline) {
            const ok = await new Promise(resolve => {
                const req = request({ host: "localhost", port: foundryServerPort, method: "HEAD", path: "/" }, res => {
                    resolve(res.statusCode < 500)
                })
                req.on("error", () => resolve(false))
                req.end()
            })
            if (ok) {
                console.log("[foundryvtt-test-framework] Foundry server ready.")
                return { proc, port: foundryServerPort }
            }
            await new Promise(r => setTimeout(r, 500))
        }
        proc.kill()
        throw new Error(`Foundry server did not become ready within ${timeout}ms`)
    }

    /** Stop a server previously started by `startServer`. */
    static async stopServer(handle) {
        if (!handle?.proc) return
        handle.proc.kill()
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    _spawnServer() {
        const { foundryNodePath, testDataPath, foundryServerPort } = this.config
        const args = ["main.js", `--dataPath=${testDataPath}`]
        if (foundryServerPort !== 30000) args.push(`--port=${foundryServerPort}`)
        if (this.config.world) args.push(`--world=${this.config.world}`)

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
        this.context = await chromium.launchPersistentContext(chromeProfilePath, {
            // Chromium extensions only load in headed mode under a persistent context.
            // If the caller asks for headless, Playwright supports the new `--headless=new`
            // channel which does load extensions; expose it via headless: "new".
            headless: headless === true ? "new" : false,
            viewport: null,
            args: [
                `--disable-extensions-except=${diceOverrideExtensionPath}`,
                `--load-extension=${diceOverrideExtensionPath}`,
                "--window-size=1920,1080",
            ],
        })
    }

    async _navigateAndWait() {
        const port = this.config.foundryServerPort ?? 30000
        const pages = this.context.pages()
        for (const p of pages.slice(1)) await p.close().catch(() => {})
        this.page = pages[0] ?? await this.context.newPage()

        console.log("[foundryvtt-test-framework] Navigating to Foundry...")
        await this.page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" })
        await this._login()
        await this.waitForFoundryReady()
        console.log("[foundryvtt-test-framework] Foundry ready.")
    }

    async _login() {
        const loginUser = this.config.loginUser ?? "Gamemaster"

        const hasLoginForm = await this.page.locator('select[name="userid"]').count()
            .then(c => c > 0, () => false)
        if (!hasLoginForm) {
            console.log("[foundryvtt-test-framework] No login form — assuming session already active.")
            return
        }

        console.log(`[foundryvtt-test-framework] Logging in as "${loginUser}"...`)

        const found = await this.page.evaluate((userName) => {
            const sel = document.querySelector('select[name="userid"]')
            const opt = Array.from(sel.options).find(o => o.text === userName)
            if (!opt) return false
            sel.value = opt.value
            sel.dispatchEvent(new Event("change", { bubbles: true }))
            return true
        }, loginUser)

        if (!found) throw new Error(`[foundryvtt-test-framework] User "${loginUser}" not found in login select`)

        await this.page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll("button"))
                .find(b => b.textContent.trim() === "Join Game Session")
            btn?.click()
        })

        await new Promise(r => setTimeout(r, 3000))
    }
}
