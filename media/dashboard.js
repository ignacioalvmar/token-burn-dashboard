// Token Burn — webview dashboard logic
// Receives {type:'snapshot', events, summary, pricing, budget, status} from the extension host.
(function () {
  const vscode = acquireVsCodeApi();

  const KIND_COLORS = {
    user_msg: '#60a5fa', assistant: '#f59e0b',
    read_file: '#a78bfa', write_file: '#34d399', edit_file: '#2dd4bf',
    bash: '#fb7185', grep: '#c084fc', web_search: '#38bdf8', screenshot: '#facc15',
    other: '#94a3b8',
  };
  const KIND_GLYPHS = {
    user_msg: '›', assistant: '◆',
    read_file: '◈', write_file: '✎', edit_file: '±',
    bash: '$', grep: '≈', web_search: '⌕', screenshot: '◉', other: '·',
  };
  const KIND_LABELS = {
    user_msg: 'user', assistant: 'reason', read_file: 'read', write_file: 'write',
    edit_file: 'edit', bash: 'bash', grep: 'grep', web_search: 'web', screenshot: 'shot', other: 'other',
  };

  let state = { events: [], summary: null, pricing: {}, budget: { session: 2, daily: 20 }, status: null, units: 'tokens' };
  let liveBuf = []; // recent events bucketed

  // ---------- formatters ----------
  const fmtTokens = n => n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(Math.round(n));
  const fmtCost = n => n < 0.01 ? '$'+n.toFixed(4) : n < 1 ? '$'+n.toFixed(3) : '$'+n.toFixed(2);
  const fmtTime = s => s < 60 ? s.toFixed(0)+'s' : Math.floor(s/60)+'m '+Math.round(s%60)+'s';
  const val = (n, unit) => unit === 'cost' ? fmtCost(n) : fmtTokens(n);

  // ---------- tab wiring ----------
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b === btn));
      const t = btn.dataset.tab;
      document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.dataset.pane === t));
      render();
    });
  });
  document.querySelectorAll('.seg-btn[data-units]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn[data-units]').forEach(b => b.classList.toggle('on', b === btn));
      state.units = btn.dataset.units;
      render();
    });
  });
  document.getElementById('btn-refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.getElementById('btn-reveal').addEventListener('click', () => vscode.postMessage({ type: 'reveal' }));
  document.getElementById('btn-reveal-2').addEventListener('click', () => vscode.postMessage({ type: 'reveal' }));
  document.getElementById('btn-open-settings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

  // ---------- receive snapshots ----------
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg?.type === 'snapshot') {
      state = { ...state, ...msg };
      render();
    }
  });

  vscode.postMessage({ type: 'ready' });

  // ---------- render ----------
  function render() {
    renderLive();
    renderHistory();
    renderSummary();
    renderSettings();
  }

  function renderLive() {
    const s = state.summary || {};
    const units = state.units;
    document.getElementById('kpi-tokens').textContent = val(s.totalTokens || 0, units === 'cost' ? 'cost' : 'tokens').replace(units === 'cost' ? '' : '', '');
    if (units === 'cost') document.getElementById('kpi-tokens').textContent = fmtCost(s.totalCost || 0);
    else document.getElementById('kpi-tokens').textContent = fmtTokens(s.totalTokens || 0);

    document.getElementById('kpi-in').textContent = fmtTokens(s.totalInput || 0) + ' in';
    document.getElementById('kpi-out').textContent = fmtTokens(s.totalOutput || 0) + ' out';
    document.getElementById('kpi-cost').textContent = fmtCost(s.totalCost || 0);

    // burn rate: tokens/s over last 60s
    const now = Date.now();
    const recent = state.events.filter(e => now - e.ts <= 60000);
    const recentTok = recent.reduce((a,e) => a + e.inTokens + e.outTokens, 0);
    document.getElementById('kpi-burn').textContent = fmtTokens(recentTok / 60) + ' tok/s';

    document.getElementById('kpi-turns').textContent = `${s.messageCount || 0} / ${s.toolCount || 0}`;
    const avg = s.messageCount ? (s.totalTokens / s.messageCount) : 0;
    document.getElementById('kpi-avg').textContent = fmtTokens(avg);

    // budget
    const budget = state.budget?.session || 2;
    const pct = Math.min(100, (s.totalCost || 0) / budget * 100);
    document.getElementById('kpi-budget').textContent = `${fmtCost(s.totalCost || 0)} / ${fmtCost(budget)}`;
    document.getElementById('budget-fill').style.width = pct + '%';
    document.querySelector('.kpi-budget').classList.toggle('danger', pct >= 100);

    // source label
    const srcLabel = document.getElementById('source-label');
    if (state.status) {
      srcLabel.textContent = state.status.source === 'sqlite'
        ? '· live from Cursor chat log'
        : state.status.source === 'json' ? '· reading state snapshot' : '· demo data';
    }

    drawLiveCanvas();
    renderLegend();
    renderEventStream();
  }

  function drawLiveCanvas() {
    const canvas = document.getElementById('live-canvas');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 600;
    const cssH = 160;
    canvas.width = cssW * dpr; canvas.height = cssH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // 120s window, 60 buckets
    const N = 60;
    const windowMs = 120000;
    const end = Date.now();
    const start = end - windowMs;
    const buckets = Array.from({ length: N }, () => ({}));
    state.events.forEach(e => {
      if (e.ts < start) return;
      const idx = Math.min(N - 1, Math.floor((e.ts - start) / windowMs * N));
      buckets[idx][e.kind] = (buckets[idx][e.kind] || 0) + (e.inTokens + e.outTokens);
    });
    const maxB = Math.max(1, ...buckets.map(b => Object.values(b).reduce((a,c) => a+c, 0)));

    const PAD = { t: 10, r: 8, b: 18, l: 36 };
    const pw = cssW - PAD.l - PAD.r;
    const ph = cssH - PAD.t - PAD.b;
    const bw = pw / N;

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = PAD.t + (ph / 4) * i;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(cssW - PAD.r, y); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '9px monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtTokens((1 - i/4) * maxB), PAD.l - 4, y);
    }

    // stacked bars
    buckets.forEach((b, i) => {
      let yCursor = PAD.t + ph;
      Object.keys(KIND_COLORS).forEach(k => {
        const v = b[k] || 0;
        if (!v) return;
        const h = (v / maxB) * ph;
        yCursor -= h;
        ctx.fillStyle = KIND_COLORS[k];
        ctx.globalAlpha = 0.85;
        ctx.fillRect(PAD.l + i * bw + 0.5, yCursor, Math.max(1, bw - 1), h);
      });
    });
    ctx.globalAlpha = 1;

    // x axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.font = '9px monospace';
    ctx.fillText('−2m', PAD.l, cssH - PAD.b + 3);
    ctx.fillText('−1m', PAD.l + pw/2, cssH - PAD.b + 3);
    ctx.fillText('now', PAD.l + pw, cssH - PAD.b + 3);
  }

  function renderLegend() {
    const el = document.getElementById('live-legend');
    el.innerHTML = Object.entries(KIND_COLORS).map(([k, c]) =>
      `<span><span class="swatch" style="background:${c}"></span>${KIND_LABELS[k]}</span>`
    ).join('');
  }

  function renderEventStream() {
    const el = document.getElementById('event-list');
    const recent = [...state.events].slice(-60).reverse();
    el.innerHTML = recent.map(e => {
      const c = KIND_COLORS[e.kind] || KIND_COLORS.other;
      const g = KIND_GLYPHS[e.kind] || '·';
      const modelShort = e.model ? (e.model.split('-').slice(1, 3).join(' ') || e.model) : '';
      const pill = e.model ? `<span class="model-pill" style="color:${c};border-color:${c}66;background:${c}22">${modelShort}</span>` : '<span></span>';
      return `
        <div class="event-row">
          <span class="event-glyph" style="color:${c}">${g}</span>
          <span class="event-kind">${KIND_LABELS[e.kind] || e.kind}</span>
          <span class="event-label" title="${escapeHtml(e.label || '')}">${escapeHtml(e.label || '')}</span>
          ${pill}
          <span class="event-in">${e.inTokens ? '+' + fmtTokens(e.inTokens) : ''}</span>
          <span class="event-out">${e.outTokens ? fmtTokens(e.outTokens) : ''}</span>
        </div>`;
    }).join('');
  }

  function renderHistory() {
    // group events by sessionId → turn (consecutive user_msg starts a turn)
    const turns = buildTurns(state.events);
    document.getElementById('history-count').textContent = turns.length + ' turns';
    const tb = document.getElementById('msg-tbody');
    tb.innerHTML = turns.map((t, i) => {
      const modelShort = t.model ? t.model.split('-').slice(1).join('-') : '—';
      return `
        <tr>
          <td class="num">${i + 1}</td>
          <td>${escapeHtml(t.prompt || '(no prompt captured)')}</td>
          <td>${modelShort}</td>
          <td class="num">${fmtTokens(t.inTokens)}</td>
          <td class="num">${fmtTokens(t.outTokens)}</td>
          <td class="num">${t.tools}</td>
          <td class="num">${fmtCost(t.cost)}</td>
        </tr>`;
    }).join('');
  }

  function buildTurns(events) {
    const turns = [];
    let cur = null;
    const pricing = state.pricing || {};
    const cost = (model, i, o) => {
      if (!model || !pricing[model]) return 0;
      return (i * pricing[model].in + o * pricing[model].out) / 1e6;
    };
    for (const e of events) {
      if (e.kind === 'user_msg' || !cur) {
        if (cur) turns.push(cur);
        cur = { prompt: e.kind === 'user_msg' ? e.label : '', model: e.model, inTokens: 0, outTokens: 0, tools: 0, cost: 0 };
      }
      cur.inTokens += e.inTokens;
      cur.outTokens += e.outTokens;
      cur.cost += cost(e.model, e.inTokens, e.outTokens);
      if (e.model && !cur.model) cur.model = e.model;
      if (e.kind !== 'user_msg' && e.kind !== 'assistant') cur.tools++;
    }
    if (cur) turns.push(cur);
    return turns;
  }

  function renderSummary() {
    const s = state.summary || {};
    document.getElementById('hero-tokens').textContent = fmtTokens(s.totalTokens || 0);
    document.getElementById('hero-cost').textContent = fmtCost(s.totalCost || 0);
    document.getElementById('hero-turns').textContent = (s.messageCount || 0) + ' turns';
    const dur = state.events.length
      ? (state.events[state.events.length-1].ts - state.events[0].ts) / 1000
      : 0;
    document.getElementById('hero-duration').textContent = fmtTime(dur);

    const models = Object.entries(s.byModel || {}).sort((a,b) => (b[1].in+b[1].out) - (a[1].in+a[1].out));
    const kinds  = Object.entries(s.byKind  || {}).sort((a,b) => (b[1].in+b[1].out) - (a[1].in+a[1].out));
    document.getElementById('hero-model').textContent = models[0]?.[0] || '—';
    document.getElementById('hero-kind').textContent  = KIND_LABELS[kinds[0]?.[0]] || '—';

    const turns = buildTurns(state.events);
    const heavy = turns.reduce((best, t, i) => (t.inTokens+t.outTokens) > (best?.val||0) ? { i, val: t.inTokens+t.outTokens } : best, null);
    document.getElementById('hero-heavy').textContent = heavy ? `#${heavy.i+1} (${fmtTokens(heavy.val)})` : '—';

    renderBars('summary-models', models.map(([k, v]) => ({
      label: k, value: v.in + v.out, color: '#f59e0b',
    })));
    renderBars('summary-kinds', kinds.map(([k, v]) => ({
      label: KIND_LABELS[k] || k, value: v.in + v.out, color: KIND_COLORS[k] || '#94a3b8',
    })));

    // observations
    const obs = [];
    if (s.totalTokens > 0) {
      const inShare = (s.totalInput / s.totalTokens * 100).toFixed(0);
      obs.push(`<i class="codicon codicon-lightbulb"></i><span><b>${inShare}% of tokens were input</b> — context is the biggest driver. Every tool output becomes input on the next turn.</span>`);
    }
    if (models.length > 1) {
      const top = models[0];
      obs.push(`<i class="codicon codicon-target"></i><span><b>${top[0]}</b> handled ${Math.round((top[1].in+top[1].out)/(s.totalTokens||1)*100)}% of this session. Consider a cheaper model for the lightweight turns.</span>`);
    }
    if ((s.totalCost||0) > state.budget.session) {
      obs.push(`<i class="codicon codicon-warning"></i><span>Session exceeded its <b>${fmtCost(state.budget.session)}</b> budget by ${fmtCost((s.totalCost||0) - state.budget.session)}.</span>`);
    }
    if (heavy && heavy.val > (s.totalTokens||1) * 0.3) {
      obs.push(`<i class="codicon codicon-flame"></i><span>Turn <b>#${heavy.i+1}</b> alone was ${Math.round(heavy.val/(s.totalTokens||1)*100)}% of the session. A big file read or long reasoning pass?</span>`);
    }
    if (obs.length === 0) obs.push(`<i class="codicon codicon-info"></i><span>Start a Cursor chat — observations will appear as data comes in.</span>`);
    document.getElementById('summary-observations').innerHTML = obs.map(o => `<li>${o}</li>`).join('');
  }

  function renderBars(mountId, items) {
    const mount = document.getElementById(mountId);
    if (!items.length) { mount.innerHTML = '<div class="card-sub">No data yet.</div>'; return; }
    const max = Math.max(...items.map(i => i.value));
    mount.innerHTML = items.map(it => `
      <div class="bar-row">
        <span title="${escapeHtml(it.label)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(it.label)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(it.value/max*100).toFixed(1)}%;background:${it.color}"></div></div>
        <span class="bar-value">${state.units === 'cost' ? fmtCost(it.value * 0) : fmtTokens(it.value)}</span>
      </div>
    `).join('');
  }

  function renderSettings() {
    const st = state.status || {};
    document.getElementById('settings-source').textContent = st.source || '—';
    document.getElementById('settings-path').textContent   = st.path || '(not discovered)';
    document.getElementById('settings-poll').textContent   = st.lastPollAt ? new Date(st.lastPollAt).toLocaleTimeString() : '—';
    document.getElementById('settings-status').innerHTML = st.ok
      ? `<span style="color:#34d399">● connected</span>`
      : `<span style="color:#fb7185">● ${escapeHtml(st.message || 'not connected')}</span>`;
  }

  function escapeHtml(s) { return String(s).replace(/[<>&"]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;' }[c])); }

  // Animate loop to refresh "now" timeline even when no new events arrive
  setInterval(() => { if (document.querySelector('.tab.on')?.dataset.tab === 'live') drawLiveCanvas(); }, 1000);
})();
