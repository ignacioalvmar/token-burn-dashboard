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
exports.LogReader = void 0;
exports.candidateLogPaths = candidateLogPaths;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
/**
 * Candidate locations where Cursor / VS Code persist AI chat history.
 *
 * Cursor stores chat in a SQLite DB at
 *   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb   (macOS)
 *   %APPDATA%/Cursor/User/globalStorage/state.vscdb                        (Windows)
 *   ~/.config/Cursor/User/globalStorage/state.vscdb                        (Linux)
 * inside the key ItemTable/cursorDiskKV. Schemas have shifted between
 * Cursor versions, so we probe for rows containing token counts.
 */
function candidateLogPaths() {
    const home = os.homedir();
    const paths = [];
    const candidates = ['Cursor', 'Code', 'Code - Insiders'];
    if (process.platform === 'darwin') {
        for (const p of candidates)
            paths.push(path.join(home, 'Library', 'Application Support', p, 'User', 'globalStorage', 'state.vscdb'));
    }
    else if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        for (const p of candidates)
            paths.push(path.join(appData, p, 'User', 'globalStorage', 'state.vscdb'));
    }
    else {
        for (const p of candidates)
            paths.push(path.join(home, '.config', p, 'User', 'globalStorage', 'state.vscdb'));
    }
    return paths.filter(p => { try {
        return fs.existsSync(p);
    }
    catch {
        return false;
    } });
}
/** Try to load better-sqlite3. Extension still works without it (falls back to mock). */
function tryLoadSqlite() {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('better-sqlite3');
    }
    catch {
        return null;
    }
}
class LogReader {
    constructor(overridePath = '') {
        this.overridePath = overridePath;
        this.status = { source: 'mock', path: null, lastPollAt: 0, ok: false };
        this.lastRowId = 0;
        this.db = null;
        this.mockStartedAt = Date.now();
    }
    connect() {
        const Sqlite = tryLoadSqlite();
        const candidates = this.overridePath ? [this.overridePath] : candidateLogPaths();
        if (!Sqlite || candidates.length === 0) {
            this.status = {
                source: 'mock', path: null, lastPollAt: Date.now(), ok: false,
                message: !Sqlite
                    ? 'better-sqlite3 not loaded — falling back to demo data.'
                    : 'No Cursor/VS Code chat log found. Showing demo data.',
            };
            return this.status;
        }
        for (const p of candidates) {
            try {
                this.db = new Sqlite(p, { readonly: true, fileMustExist: true });
                this.status = { source: 'sqlite', path: p, lastPollAt: Date.now(), ok: true };
                return this.status;
            }
            catch (err) {
                this.status = { source: 'mock', path: p, lastPollAt: Date.now(), ok: false, message: String(err?.message ?? err) };
            }
        }
        return this.status;
    }
    getStatus() { return this.status; }
    /** Pull new events since last poll. */
    pollNew() {
        this.status.lastPollAt = Date.now();
        if (this.status.source === 'sqlite' && this.db) {
            try {
                return this.readFromSqlite();
            }
            catch (err) {
                this.status.message = String(err?.message ?? err);
                this.status.ok = false;
                return this.mockTick();
            }
        }
        return this.mockTick();
    }
    /**
     * Read Cursor-style chat rows. The exact table/shape has changed across versions, so
     * we look up any row in cursorDiskKV / ItemTable whose value parses as JSON and
     * contains a `tokensIn`/`tokensOut` (or similar) field. This is intentionally
     * defensive — if parsing fails, we show what we can.
     */
    readFromSqlite() {
        const out = [];
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
        const readKV = (tableName, keyCol, valCol) => {
            const rows = this.db.prepare(`SELECT rowid, ${keyCol} as k, ${valCol} as v FROM ${tableName} WHERE rowid > ?`).all(this.lastRowId);
            for (const row of rows) {
                this.lastRowId = Math.max(this.lastRowId, row.rowid);
                let parsed;
                try {
                    parsed = JSON.parse(typeof row.v === 'string' ? row.v : row.v?.toString?.() ?? '');
                }
                catch {
                    continue;
                }
                const evs = extractEvents(parsed, String(row.k));
                out.push(...evs);
            }
        };
        if (tables.includes('cursorDiskKV'))
            readKV('cursorDiskKV', 'key', 'value');
        if (tables.includes('ItemTable'))
            readKV('ItemTable', 'key', 'value');
        return out;
    }
    /** Synthetic ticking data so the UI demo works without real logs. */
    mockTick() {
        const age = Date.now() - this.mockStartedAt;
        if (age < 1500)
            return [];
        this.mockStartedAt = Date.now();
        const kinds = ['read_file', 'edit_file', 'assistant', 'bash', 'grep', 'assistant'];
        const labels = {
            read_file: ['src/App.tsx', 'package.json', 'lib/api.ts', 'components/Card.tsx'],
            edit_file: ['src/App.tsx', 'components/Header.tsx'],
            assistant: ['Planning the change', 'Reading related files', 'Wiring the state', 'Verifying the build'],
            bash: ['npm run dev', 'git status', 'npm test'],
            grep: ['useState', 'export default', 'className'],
        };
        const kind = kinds[Math.floor(Math.random() * kinds.length)];
        const label = (labels[kind] || ['…'])[Math.floor(Math.random() * (labels[kind]?.length || 1))];
        const inTok = kind === 'assistant' ? 2000 + Math.floor(Math.random() * 20000) : 0;
        const outTok = kind === 'assistant'
            ? 100 + Math.floor(Math.random() * 500)
            : 50 + Math.floor(Math.random() * 1500);
        return [{
                id: 'mock-' + Date.now(),
                ts: Date.now(),
                sessionId: 'demo-session',
                role: kind === 'assistant' ? 'assistant' : 'tool',
                kind,
                model: 'claude-sonnet-4-5',
                inTokens: inTok,
                outTokens: outTok,
                label,
            }];
    }
    dispose() { try {
        this.db?.close();
    }
    catch { } }
}
exports.LogReader = LogReader;
/** Try hard to coerce an unknown JSON blob from Cursor storage into ChatEvent[]. */
function extractEvents(blob, key) {
    const out = [];
    const visit = (node, sid) => {
        if (!node || typeof node !== 'object')
            return;
        // heuristic: anything with tokensIn/tokensOut or usage.input_tokens/output_tokens
        const tIn = node.tokensIn ?? node.inputTokens ?? node.usage?.input_tokens ?? node.prompt_tokens;
        const tOut = node.tokensOut ?? node.outputTokens ?? node.usage?.output_tokens ?? node.completion_tokens;
        if (tIn != null || tOut != null) {
            out.push({
                id: node.id || key + '-' + out.length,
                ts: Number(node.timestamp ?? node.ts ?? Date.now()),
                sessionId: node.sessionId ?? sid,
                role: (node.role ?? 'assistant'),
                kind: guessKind(node),
                model: node.model ?? null,
                inTokens: Number(tIn ?? 0),
                outTokens: Number(tOut ?? 0),
                label: String(node.name ?? node.tool ?? node.content?.slice?.(0, 80) ?? 'event'),
            });
        }
        if (Array.isArray(node))
            for (const c of node)
                visit(c, sid);
        else
            for (const k of Object.keys(node))
                visit(node[k], sid);
    };
    visit(blob, key);
    return out;
}
function guessKind(node) {
    const t = (node.tool ?? node.type ?? node.kind ?? '').toLowerCase();
    if (t.includes('read'))
        return 'read_file';
    if (t.includes('write'))
        return 'write_file';
    if (t.includes('edit'))
        return 'edit_file';
    if (t.includes('grep'))
        return 'grep';
    if (t.includes('bash') || t.includes('shell') || t.includes('terminal'))
        return 'bash';
    if (t.includes('search') || t.includes('web'))
        return 'web_search';
    if (t.includes('screenshot'))
        return 'screenshot';
    if (node.role === 'user' || t === 'user')
        return 'user_msg';
    if (node.role === 'assistant')
        return 'assistant';
    return 'other';
}
//# sourceMappingURL=logReader.js.map