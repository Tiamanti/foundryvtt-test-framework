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
        await waitForCondition(
            this.page,
            new Function(`
                const matcher = ${matcherStr};
                const messages = game.messages?.contents ?? [];
                return messages.some(m => matcher(m)) ? true : null;
            `),
            timeout
        )
    }

    /**
     * Poll a browser-side predicate until it returns a truthy value, then return that value.
     * Return a plain serializable object from fn — do not return Foundry Document instances.
     * @param {Function} fn - evaluated in Foundry context; must return truthy to resolve
     * @param {number} timeout
     */
    async waitFor(fn, timeout = 10000) {
        const result = await waitForCondition(this.page, fn, timeout)
        if (result === null || result === undefined) throw new Error(`waitFor: condition not met within ${timeout}ms`)
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

    /** Clear the chat log by clicking the clear button and confirming the dialog. */
    async clearChat() {
        const chatSel = '[aria-label="Chat Messages"]'
        const chatBtn = await this.page.waitForSelector(chatSel, { visible: true })
        await chatBtn.click().catch(e => { throw new Error(`clearChat: click failed on "${chatSel}": ${e.message}`) })
        await this._pause()

        await this.page.waitForSelector('[aria-label="Clear Chat Log"]', { visible: true })
        await this.page.evaluate(() => document.querySelector('[aria-label="Clear Chat Log"]').click())
        await this._pause()

        const confirmSel = 'button[type="submit"][data-action="yes"]'
        const confirmBtn = await this.page.waitForSelector(confirmSel, { visible: true })
        await confirmBtn.click().catch(e => { throw new Error(`clearChat: click failed on "${confirmSel}": ${e.message}`) })
        await this._pause()
    }

    /** Wait for a Foundry application dialog to appear and click its submit button. */
    async submitDialog() {
        const sel = "footer.form-footer button[type='submit']"
        const btn = await this.page.waitForSelector(sel, { visible: true })
        await btn.click().catch(e => { throw new Error(`submitDialog: click failed on "${sel}": ${e.message}`) })
        await this._pause()
    }

    /** Open the chat tab, type a command, and press Enter to submit. */
    async sendChatCommand(text) {
        const chatSel = '[aria-label="Chat Messages"]'
        const chatBtn = await this.page.waitForSelector(chatSel, { visible: true })
        await chatBtn.click().catch(e => { throw new Error(`sendChatCommand: click failed on "${chatSel}": ${e.message}`) })
        await this._pause()

        const editorSel = ".editor-container div[contenteditable='true']"
        const editor = await this.page.waitForSelector(editorSel, { visible: true })
        await editor.click().catch(e => { throw new Error(`sendChatCommand: click failed on "${editorSel}": ${e.message}`) })
        await this._pause()

        await this.page.keyboard.type(text)
        await this.page.keyboard.press("Enter")
    }

    /**
     * Click a button inside the most recent chat message matching a CSS selector.
     * @param {string} selector - scoped within the last li.chat-message
     */
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

    /**
     * Wait until an element with matching trimmed text appears in the most recent chat message.
     * @param {string} text - exact trimmed text to match
     * @param {number} timeout
     */
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

    /**
     * Wait until text appears inside the last chat message that contains a specific card element.
     * @param {string} cardSelector - CSS selector identifying the card within .message-content
     * @param {string} text - exact trimmed text to match anywhere inside the card
     * @param {number} timeout
     */
    async waitForTextInLastChatMessageContaining(cardSelector, text, timeout = 10000) {
        await waitForCondition(
            this.page,
            (cardSel, text) => {
                const messages = Array.from(document.querySelectorAll(".chat-scroll li.chat-message"))
                const cardMsg = messages.findLast(m => m.querySelector(".message-content " + cardSel))
                if (!cardMsg) return null
                const card = cardMsg.querySelector(".message-content " + cardSel)
                return Array.from(card.querySelectorAll("*")).some(e => e.textContent.trim() === text) ? true : null
            },
            timeout,
            500,
            cardSelector,
            text
        )
    }

    /**
     * Click an element inside the last chat message that contains a specific card element.
     * @param {string} cardSelector - CSS selector identifying the card within .message-content
     * @param {string} selector - scoped within the matched card
     */
    /**
     * Set the value of an input inside the last chat message that contains a specific card element
     * and dispatch a change event.
     * @param {string} cardSelector - CSS selector identifying the card within .message-content
     * @param {string} inputSelector - scoped within the matched card
     * @param {string} value
     */
    async writeInLastChatMessageContaining(cardSelector, inputSelector, value) {
        await this.page.evaluate((cardSel, inputSel, value) => {
            const messages = Array.from(document.querySelectorAll(".chat-scroll li.chat-message"))
            const cardMsg = messages.findLast(m => m.querySelector(".message-content " + cardSel))
            if (!cardMsg) throw new Error(`writeInLastChatMessageContaining: no message with "${cardSel}" found in chat`)
            const input = cardMsg.querySelector(".message-content " + cardSel + " " + inputSel)
            if (!input) throw new Error(`writeInLastChatMessageContaining: "${inputSel}" not found inside "${cardSel}"`)
            input.value = value
            input.dispatchEvent(new Event("change", { bubbles: true }))
        }, cardSelector, inputSelector, value)
    }

    async clickInLastChatMessageContaining(cardSelector, selector) {
        await this.page.evaluate((cardSel, sel) => {
            const messages = Array.from(document.querySelectorAll(".chat-scroll li.chat-message"))
            const cardMsg = messages.findLast(m => m.querySelector(".message-content " + cardSel))
            if (!cardMsg) throw new Error(`clickInLastChatMessageContaining: no message with "${cardSel}" found in chat`)
            const btn = cardMsg.querySelector(".message-content " + cardSel + " " + sel)
            if (!btn) throw new Error(`clickInLastChatMessageContaining: "${sel}" not found inside "${cardSel}"`)
            btn.click()
        }, cardSelector, selector)
        await this._pause()
    }

    /**
     * Right-click the last chat message to open its context menu, then click the item
     * whose span text matches itemText.
     * @param {string} itemText - exact trimmed text of the span inside li.context-item
     */
    async rightClickLastChatMessage(itemText) {
        const messages = await this.page.$$(".chat-scroll li.chat-message")
        const last = messages[messages.length - 1]
        if (!last) throw new Error("rightClickLastChatMessage: no chat messages found")
        await last.click({ button: "right" })
        await this._pause()

        await this.page.waitForSelector("nav#context-menu", { visible: true })

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

    /**
     * Click an element inside the most recent chat message whose text content matches.
     * @param {string} text - exact trimmed text to match
     */
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

    /**
     * Target tokens on the active scene by display name.
     * Clears existing targets first.
     * @param {string[]} names - token display names, e.g. ["Thief", "Guard 1"]
     */
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

    /**
     * Find a token by display name on the active scene and return its actor as a plain object.
     * @param {string} name - token display name
     * @returns {{ tokenUuid: string, actorUuid: string, skills: Record<string, number> }}
     */
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
        this.browser = await puppeteer.launch({
            headless: headless ?? false,
            defaultViewport: null,
            args: [
                `--load-extension=${diceOverrideExtensionPath}`,
                `--disable-extensions-except=${diceOverrideExtensionPath}`,
                `--user-data-dir=${chromeProfilePath}`,
                "--window-size=1920,1080",
            ],
        })
    }

    async _navigateAndWait() {
        const port = this.config.foundryServerPort ?? 30000
        const pages = await this.browser.pages()
        for (const p of pages.slice(1)) await p.close().catch(() => {})
        this.page = pages[0] ?? await this.browser.newPage()

        console.log("[foundryvtt-test-framework] Navigating to Foundry...")
        await this.page.goto(`http://localhost:${port}`, { waitUntil: "networkidle2" })
        await this._login()
        await this.waitForFoundryReady()
        console.log("[foundryvtt-test-framework] Foundry ready.")
    }

    async _login() {
        const loginUser = this.config.loginUser ?? "Gamemaster"

        const select = await this.page.waitForSelector('select[name="userid"]', { timeout: 10000 }).catch(() => null)
        if (!select) {
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
