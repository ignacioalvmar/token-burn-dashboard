import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LogReader, ChatEvent } from './logReader';
import { costFor, formatUSD, PricingMap } from './pricing';

let panel: vscode.WebviewPanel | undefined;
let reader: LogReader | undefined;
let pollHandle: NodeJS.Timeout | undefined;
let events: ChatEvent[] = [];
let budgetWarningsFired = new Set<string>();

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('tokenBurn.open', () => openDashboard(ctx)),
    vscode.commands.registerCommand('tokenBurn.refresh', () => pollOnce(true)),
    vscode.commands.registerCommand('tokenBurn.reveal', async () => {
      const status = reader?.getStatus();
      if (status?.path) {
        const uri = vscode.Uri.file(status.path);
        await vscode.commands.executeCommand('revealFileInOS', uri);
      } else {
        vscode.window.showInformationMessage('Token Burn: no log file discovered.');
      }
    }),
  );

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
  (globalThis as any).__tokenBurnStatusBar = bar;
}

export function deactivate() {
  if (pollHandle) clearInterval(pollHandle);
  reader?.dispose();
  panel?.dispose();
}

function openDashboard(ctx: vscode.ExtensionContext) {
  if (panel) { panel.reveal(vscode.ViewColumn.Active); return; }

  panel = vscode.window.createWebviewPanel(
    'tokenBurn.dashboard',
    'Token Burn',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(ctx.extensionPath, 'media'))],
    },
  );
  panel.iconPath = {
    light: vscode.Uri.file(path.join(ctx.extensionPath, 'media', 'flame-light.svg')),
    dark:  vscode.Uri.file(path.join(ctx.extensionPath, 'media', 'flame-dark.svg')),
  };
  panel.webview.html = renderHtml(ctx, panel.webview);

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg?.type === 'ready') pushSnapshot();
    if (msg?.type === 'refresh') pollOnce(true);
    if (msg?.type === 'reveal') vscode.commands.executeCommand('tokenBurn.reveal');
    if (msg?.type === 'openSettings') vscode.commands.executeCommand('workbench.action.openSettings', 'tokenBurn');
  });

  panel.onDidDispose(() => { panel = undefined; });

  // Initialize reader + poll loop
  const cfg = vscode.workspace.getConfiguration('tokenBurn');
  const override = cfg.get<string>('logPathOverride', '');
  reader = new LogReader(override);
  reader.connect();

  const interval = cfg.get<number>('pollIntervalMs', 2500);
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(() => pollOnce(false), Math.max(500, interval));

  // first pull
  pollOnce(true);
}

function pollOnce(force: boolean) {
  if (!reader) return;
  const fresh = reader.pollNew();
  if (fresh.length) {
    events.push(...fresh);
    // cap memory
    if (events.length > 10000) events = events.slice(-8000);
  }
  if (fresh.length || force) {
    pushSnapshot();
    checkBudgets();
    updateStatusBar();
  }
}

function pushSnapshot() {
  if (!panel) return;
  const cfg = vscode.workspace.getConfiguration('tokenBurn');
  const pricing = cfg.get<PricingMap>('pricing', {} as PricingMap);
  const budget = {
    session: cfg.get<number>('budget.sessionUSD', 2),
    daily:   cfg.get<number>('budget.dailyUSD', 20),
  };
  const status = reader?.getStatus();
  const snapshot = summarize(events, pricing);
  panel.webview.postMessage({ type: 'snapshot', events, summary: snapshot, pricing, budget, status });
}

function updateStatusBar() {
  const bar: vscode.StatusBarItem | undefined = (globalThis as any).__tokenBurnStatusBar;
  if (!bar) return;
  const cfg = vscode.workspace.getConfiguration('tokenBurn');
  const pricing = cfg.get<PricingMap>('pricing', {} as PricingMap);
  const s = summarize(events, pricing);
  bar.text = `$(flame) ${fmtShort(s.totalTokens)} · ${formatUSD(s.totalCost)}`;
  bar.tooltip = `Token Burn — ${s.messageCount} turns, ${s.totalTokens.toLocaleString()} tokens, ${formatUSD(s.totalCost)}.\nClick to open dashboard.`;
}

function fmtShort(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function checkBudgets() {
  const cfg = vscode.workspace.getConfiguration('tokenBurn');
  const pricing = cfg.get<PricingMap>('pricing', {} as PricingMap);
  const budget = cfg.get<number>('budget.sessionUSD', 2);
  const s = summarize(events, pricing);
  if (budget <= 0) return;
  const thresholds = [
    { frac: 0.75, key: 'session-75', msg: `Token Burn: you've used 75% of the session budget (${formatUSD(s.totalCost)} / ${formatUSD(budget)}).` },
    { frac: 1.00, key: 'session-100', msg: `Token Burn: session budget exceeded (${formatUSD(s.totalCost)} / ${formatUSD(budget)}).` },
  ];
  for (const t of thresholds) {
    if (s.totalCost >= budget * t.frac && !budgetWarningsFired.has(t.key)) {
      budgetWarningsFired.add(t.key);
      vscode.window.showWarningMessage(t.msg, 'Open dashboard').then(pick => {
        if (pick) vscode.commands.executeCommand('tokenBurn.open');
      });
    }
  }
}

function summarize(evs: ChatEvent[], pricing: PricingMap) {
  let input = 0, output = 0, cost = 0, msgs = 0, tools = 0;
  const byModel: Record<string, { in: number; out: number; cost: number }> = {};
  const byKind: Record<string, { in: number; out: number; count: number }> = {};
  for (const e of evs) {
    input += e.inTokens;
    output += e.outTokens;
    const c = costFor(e.model, e.inTokens, e.outTokens, pricing);
    cost += c;
    if (e.role === 'user') msgs++;
    if (e.kind !== 'user_msg' && e.kind !== 'assistant') tools++;
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

function renderHtml(ctx: vscode.ExtensionContext, webview: vscode.Webview): string {
  const mediaPath = (f: string) => webview.asWebviewUri(vscode.Uri.file(path.join(ctx.extensionPath, 'media', f)));
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
