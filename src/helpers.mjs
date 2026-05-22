import { mkdir } from "node:fs/promises"
import { join } from "node:path"

/**
 * Repeatedly evaluates fn in the page until it returns truthy or timeout is reached.
 *
 * Playwright's page.evaluate only accepts a single argument, but the puppeteer-era
 * API accepted variadic args. When more than one arg is passed, we wrap the
 * predicate so the args can still be spread back into the original function
 * signature inside the page.
 *
 * @param {import("playwright").Page} page
 * @param {Function} fn
 * @param {number} timeout
 * @param {number} interval
 */
export async function waitForCondition(page, fn, timeout = 10000, interval = 500, ...args) {
    const deadline = Date.now() + timeout
    const evaluator = buildEvaluator(fn, args)

    while (Date.now() < deadline) {
        try {
            const result = await evaluator(page)
            if (result) return result
        } catch {
            // page may not be ready yet
        }
        await new Promise(r => setTimeout(r, interval))
    }
    throw new Error(`waitForCondition timed out after ${timeout}ms`)
}

/**
 * Build a closure that calls page.evaluate with the right shape:
 *   - 0 args: page.evaluate(fn)
 *   - 1 arg:  page.evaluate(fn, arg)
 *   - 2+ args: page.evaluate(wrapper, { fnStr, args }) — wrapper rebuilds fn
 *             from its source and applies the args array.
 */
export function buildEvaluator(fn, args) {
    if (args.length === 0) return (page) => page.evaluate(fn)
    if (args.length === 1) return (page) => page.evaluate(fn, args[0])

    const fnStr = fn.toString()
    return (page) => page.evaluate(
        ({ fnStr, args }) => {
            const fn = (0, eval)("(" + fnStr + ")")
            return fn.apply(null, args)
        },
        { fnStr, args }
    )
}

/**
 * Saves a screenshot to test-data/screenshots/<filename>.
 */
export async function takeScreenshot(page, testDataPath, filename) {
    const dir = join(testDataPath, "screenshots")
    await mkdir(dir, { recursive: true })
    await page.screenshot({ path: join(dir, filename) })
}
