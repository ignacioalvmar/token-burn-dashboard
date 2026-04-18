"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.costFor = costFor;
exports.formatUSD = formatUSD;
function costFor(model, inTok, outTok, pricing) {
    if (!model)
        return 0;
    // match by prefix if no exact key
    let p = pricing[model];
    if (!p) {
        const key = Object.keys(pricing).find(k => model.startsWith(k) || k.startsWith(model));
        if (key)
            p = pricing[key];
    }
    if (!p)
        return 0;
    return (inTok * p.in + outTok * p.out) / 1e6;
}
function formatUSD(n) {
    if (n < 0.01)
        return `$${n.toFixed(4)}`;
    if (n < 1)
        return `$${n.toFixed(3)}`;
    return `$${n.toFixed(2)}`;
}
//# sourceMappingURL=pricing.js.map