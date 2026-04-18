"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const logReader_1 = require("./logReader");
const pricing_1 = require("./pricing");
let panel;
let reader;
let pollHandle;
let events = [];
let budgetWarningsFired = new Set();
function activate(ctx) {
    ctx.subscriptions.push(vscode.commands.registerCommand('tokenBurn.open', () => openDashboard(ctx)), vscode.commands.registerCommand('tokenBurn.refresh', () => pollOnce(true)), vscode.commands.registerCommand('tokenBurn.reveal', async () => {
        const status = reader?.getStatus();
        if (status?.path) {
            const uri = vscode.Uri.file(status.path);
            await vscode.commands.executeCommand('revealFileInOS', uri);
        }
        else {
            vscode.window.showInformationMessage('Token Burn: no log file discovered.');
        }
    }));
    // Also register a status-bar entry so the dashboard is one click away.
    const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    bar.command = 'tokenBurn.open';
    bar.text = '$(flame) 0 tok';
    bar.tooltip = 'Open Token Burn dashboard';
    bar.show();
    ctx.subscriptions.push(bar);
    // Update the status bar whenever events change.
    ctx.subscriptions.push({
        dispose: () => (pollHandle && clearInterval(pollHandle)),
    });
    globalThis.__tokenBurnStatusBar = bar;
}
function deactivate() {
    if (pollHandle)
        clearInterval(pollHandle);
    reader?.dispose();
    panel?.dispose();
}
function openDashboard(ctx) {
    if (panel) {
        panel.reveal(vscode.ViewColumn.Active);
        return;
    }
    panel = vscode.window.createWebviewPanel('tokenBurn.dashboard', 'Token Burn', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(ctx.extensionPath, 'media'))],
    });
    panel.iconPath = {
        light: vscode.Uri.file(path.join(ctx.extensionPath, 'media', 'flame-light.svg')),
        dark: vscode.Uri.file(path.join(ctx.extensionPath, 'media', 'flame-dark.svg')),
    };
    panel.webview.html = renderHtml(ctx, panel.webview);
    panel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === 'ready')
            pushSnapshot();
        if (msg?.type === 'refresh')
            pollOnce(true);
        if (msg?.type === 'reveal')
            vscode.commands.executeCommand('tokenBurn.reveal');
        if (msg?.type === 'openSettings')
            vscode.commands.executeCommand('workbench.action.openSettings', 'tokenBurn');
    });
    panel.onDidDispose(() => { panel = undefined; });
    // Initialize reader + poll loop
    const cfg = vscode.workspace.getConfiguration('tokenBurn');
    const override = cfg.get('logPathOverride', '');
    reader = new logReader_1.LogReader(override);
    reader.connect();
    const interval = cfg.get('pollIntervalMs', 2500);
    if (pollHandle)
        clearInterval(pollHandle);
    pollHandle = setInterval(() => pollOnce(false), Math.max(500, interval));
    // first pull
    pollOnce(true);
}
function pollOnce(force) {
    if (!reader)
        return;
    const fresh = reader.pollNew();
    if (fresh.length) {
        events.push(...fresh);
        // cap memory
        if (events.length > 10000)
            events = events.slice(-8000);
    }
    if (fresh.length || force) {
        pushSnapshot();
        checkBudgets();
        updateStatusBar();
    }
}
function pushSnapshot() {
    if (!panel)
        return;
    const cfg = vscode.workspace.getConfiguration('tokenBurn');
    const pricing = cfg.get('pricing', {});
    const budget = {
        session: cfg.get('budget.sessionUSD', 2),
        daily: cfg.get('budget.dailyUSD', 20),
    };
    const status = reader?.getStatus();
    const snapshot = summarize(events, pricing);
    panel.webview.postMessage({ type: 'snapshot', events, summary: snapshot, pricing, budget, status });
}
function updateStatusBar() {
    const bar = globalThis.__tokenBurnStatusBar;
    if (!bar)
        return;
    const cfg = vscode.workspace.getConfiguration('tokenBurn');
    const pricing = cfg.get('pricing', {});
    const s = summarize(events, pricing);
    bar.text = `$(flame) ${fmtShort(s.totalTokens)} · ${(0, pricing_1.formatUSD)(s.totalCost)}`;
    bar.tooltip = `Token Burn — ${s.messageCount} turns, ${s.totalTokens.toLocaleString()} tokens, ${(0, pricing_1.formatUSD)(s.totalCost)}.\nClick to open dashboard.`;
}
function fmtShort(n) {
    if (n >= 1e6)
        return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3)
        return (n / 1e3).toFixed(1) + 'k';
    return String(n);
}
function checkBudgets() {
    const cfg = vscode.workspace.getConfiguration('tokenBurn');
    const pricing = cfg.get('pricing', {});
    const budget = cfg.get('budget.sessionUSD', 2);
    const s = summarize(events, pricing);
    if (budget <= 0)
        return;
    const thresholds = [
        { frac: 0.75, key: 'session-75', msg: `Token Burn: you've used 75% of the session budget (${(0, pricing_1.formatUSD)(s.totalCost)} / ${(0, pricing_1.formatUSD)(budget)}).` },
        { frac: 1.00, key: 'session-100', msg: `Token Burn: session budget exceeded (${(0, pricing_1.formatUSD)(s.totalCost)} / ${(0, pricing_1.formatUSD)(budget)}).` },
    ];
    for (const t of thresholds) {
        if (s.totalCost >= budget * t.frac && !budgetWarningsFired.has(t.key)) {
            budgetWarningsFired.add(t.key);
            vscode.window.showWarningMessage(t.msg, 'Open dashboard').then(pick => {
                if (pick)
                    vscode.commands.executeCommand('tokenBurn.open');
            });
        }
    }
}
function summarize(evs, pricing) {
    let input = 0, output = 0, cost = 0, msgs = 0, tools = 0;
    const byModel = {};
    const byKind = {};
    for (const e of evs) {
        input += e.inTokens;
        output += e.outTokens;
        const c = (0, pricing_1.costFor)(e.model, e.inTokens, e.outTokens, pricing);
        cost += c;
        if (e.role === 'user')
            msgs++;
        if (e.kind !== 'user_msg' && e.kind !== 'assistant')
            tools++;
        if (e.model) {
            byModel[e.model] = byModel[e.model] || { in: 0, out: 0, cost: 0 };
            byModel[e.model].in += e.inTokens;
            byModel[e.model].out += e.outTokens;
            byModel[e.model].cost += c;
        }
        byKind[e.kind] = byKind[e.kind] || { in: 0, out: 0, count: 0 };
        byKind[e.kind].in += e.inTokens;
        byKind[e.kind].out += e.outTokens;
        byKind[e.kind].count++;
    }
    return {
        totalInput: input,
        totalOutput: output,
        totalTokens: input + output,
        totalCost: cost,
        messageCount: Math.max(msgs, 1),
        toolCount: tools,
        byModel,
        byKind,
    };
}
function renderHtml(ctx, webview) {
    const mediaPath = (f) => webview.asWebviewUri(vscode.Uri.file(path.join(ctx.extensionPath, 'media', f)));
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;`;
    const htmlPath = path.join(ctx.extensionPath, 'media', 'dashboard.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html
        .replace(/{{CSP}}/g, csp)
        .replace(/{{CSS}}/g, String(mediaPath('dashboard.css')))
        .replace(/{{JS}}/g, String(mediaPath('dashboard.js')))
        .replace(/{{CODICON_CSS}}/g, String(mediaPath('codicon.css')))
        .replace(/{{CODICON_FONT}}/g, String(mediaPath('codicon.ttf')));
    return html;
}
//# sourceMappingURL=extension.js.map