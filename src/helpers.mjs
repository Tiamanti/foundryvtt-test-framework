import { mkdir } from "node:fs/promises"
import { join } from "node:path"

/**
 * Repeatedly evaluates fn in the page until it returns truthy or timeout is reached.
 * @param {import("puppeteer").Page} page
 * @param {Function} fn - evaluated in page context, must be serializable
 * @param {number} timeout - milliseconds
 * @param {number} interval - poll interval in milliseconds
 */
export async function waitForCondition(page, fn, timeout = 10000, interval = 500, ...args) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        try {
            const result = await page.evaluate(fn, ...args)
            if (result) return result
        } catch {
            // page may not be ready yet
        }
        await new Promise(r => setTimeout(r, interval))
    }
    throw new Error(`waitForCondition timed out after ${timeout}ms`)
}

/**
 * Waits for a CSS selector to appear in the page DOM.
 * @param {import("puppeteer").Page} page
 * @param {string} selector
 * @param {number} timeout
 */
export async function waitForSelector(page, selector, timeout = 10000) {
    return page.waitForSelector(selector, { timeout })
}

/**
 * Saves a screenshot to test-data/screenshots/<filename>.
 * @param {import("puppeteer").Page} page
 * @param {string} testDataPath - absolute path to test-data directory
 * @param {string} filename
 */
export async function takeScreenshot(page, testDataPath, filename) {
    const dir = join(testDataPath, "screenshots")
    await mkdir(dir, { recursive: true })
    await page.screenshot({ path: join(dir, filename) })
}
