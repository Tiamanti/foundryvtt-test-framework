// Runs in MAIN world — has direct access to window.Roll.
// Adapted from foundry-cheater; storage/bridge/popup UI removed.
// Queue is exposed as window.__diceOverrideQueue so Puppeteer can push
// entries directly via page.evaluate().

"use strict";

// ---------------------------------------------------------------------------
// Queue (owned here, written by Puppeteer via page.evaluate)
// ---------------------------------------------------------------------------

window.__diceOverrideQueue = [];

// ---------------------------------------------------------------------------
// Override logic
// ---------------------------------------------------------------------------

function maybeOverride(node) {
    if (!Array.isArray(node.results) || node.results.length === 0) return;
    if (node.faces == null || node.faces === 0) return;

    const entry = window.__diceOverrideQueue.find((e) => {
        if (e.consumed) return false;
        if (e.faces !== null && e.faces !== node.faces) return false;
        if (e.number !== null && e.number !== node.number) return false;
        return true;
    });

    if (!entry) return;

    applyOverride(node, entry.value);
    entry.consumed = true;
}

function applyOverride(node, desiredTotal) {
    const active = node.results.filter((r) => r.active === true);
    if (active.length === 0) return;

    // Skip success-counting dice (e.g. WFRP hit location)
    if (active.some((r) => r.count !== undefined)) return;

    const count = active.length;
    const faces = node.faces;

    const clamped = Math.max(count, Math.min(count * faces, desiredTotal));
    const base = Math.floor(clamped / count);
    const remainder = clamped - base * count;

    active.forEach((r, i) => {
        r.result = base + (i === active.length - 1 ? remainder : 0);
    });

    node._overridden = true;
}

// ---------------------------------------------------------------------------
// Patch installation
// ---------------------------------------------------------------------------

function installPatch() {
    const RollProto = window.Roll.prototype;
    const _origEvalAST = RollProto._evaluateASTAsync;

    RollProto._evaluateASTAsync = async function patchedEvalAST(node, options = {}) {
        if (node.class !== "Node") {
            if (!node._evaluated) await node.evaluate(options);
            if (!options.minimize && !options.maximize) maybeOverride(node);
            return node.total;
        }
        return _origEvalAST.call(this, node, options);
    };

    console.log("[foundry-test-framework] Roll patch installed.");
}

// ---------------------------------------------------------------------------
// Wait for Foundry's Roll to be defined, then patch
// ---------------------------------------------------------------------------

(function waitForRoll() {
    if (window.Roll?.prototype?._evaluateASTAsync) {
        installPatch();
        return;
    }
    setTimeout(waitForRoll, 200);
})();
