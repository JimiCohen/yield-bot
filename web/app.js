/* Yield Bot dashboard — opportunity-first, plain-English, click-only. */

const $ = (s) => document.querySelector(s);
const fmt$ = (n) => (n == null ? "—" : (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: n != null && Math.abs(n) < 100 ? 2 : 0 }));
const pct = (n) => (n == null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(0) + "%");
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 90 ? "just now" : s < 3600 ? Math.round(s / 60) + "m ago" : Math.round(s / 3600) + "h ago"; };

async function get(p) { return (await fetch(p)).json(); }
async function post(p, b) { return (await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) })).json(); }

// ---- click-only confirm dialog ----
function confirmDialog(title, body, okLabel, okClass) {
  return new Promise((resolve) => {
    $("#confirm-title").textContent = title;
    $("#confirm-body").textContent = body;
    const ok = $("#confirm-ok"); ok.textContent = okLabel; ok.className = okClass || "primary";
    $("#confirm").hidden = false;
    const done = (v) => { $("#confirm").hidden = true; ok.onclick = null; $("#confirm-cancel").onclick = null; resolve(v); };
    ok.onclick = () => done(true);
    $("#confirm-cancel").onclick = () => done(false);
  });
}

let STATE = { auto: false, mode: "paper", validationPassed: false };

// ---- top bar + gate ----
async function refreshStatus() {
  const s = await get("/api/status");
  STATE.mode = s.mode; STATE.validationPassed = s.validation.passed;
  STATE.auto = s.tasks.paper.state === "running" || s.tasks.live.state === "running";
  const live = s.tasks.live.state === "running";

  $("#venue").textContent = s.venue || "—";
  $("#m-mode").textContent = live ? "LIVE 🔴" : "Paper (practice)";
  $("#m-mode").style.color = live ? "var(--red)" : "var(--text)";
  $("#run-dot").className = "dot" + (STATE.auto ? " live" : "");

  const tog = $("#auto-toggle");
  tog.textContent = STATE.auto ? "Auto-trading ON" : "Start auto-trading";
  tog.className = "big " + (STATE.auto ? "primary" : "");
  $("#auto-hint").textContent = STATE.auto
    ? "Bot is finding & managing the best pools automatically"
    : "One click: the bot deploys & manages the top strategies";

  // gate banner — plain words
  const v = s.validation, th = v.thresholds;
  if (v.passed) {
    $("#gate-banner").className = "banner ready";
    $("#gate-banner").innerHTML = `✅ <b>Validated.</b> The strategy proved itself on ${v.entries} practice trades — real-money trading is unlocked.`;
  } else {
    $("#gate-banner").className = "banner locked";
    $("#gate-banner").innerHTML = `🔒 <b>Proving the strategy on practice money first.</b> ${v.entries} of ${th.validation_min_entries} test trades done — real money unlocks automatically when it’s proven. Your money is safe until then.`;
  }
  return s;
}

// ---- the money map ----
async function refreshOpps() {
  const d = await get("/api/opportunities");
  $("#m-deployed").textContent = `${fmt$(d.deployedUsd)} / ${fmt$(d.capitalUsd)}`;
  if (!d.opportunities || d.opportunities.length === 0) {
    $("#opps").innerHTML = `<div class="empty">Scanning pools… the best opportunities will appear here within a minute.</div>`;
    return;
  }
  const slotsFull = d.openCount >= d.maxPositions;
  let best = true;
  $("#opps").innerHTML = d.opportunities.map((o) => {
    const apr = o.ney_apr_pct;
    const good = o.viable;
    const cls = good ? (best ? "opp best" : "opp") : "opp dim";
    const isBest = good && best; if (good) best = false;
    const flagNote = o.flags.includes("ADVISORY_APY_UNRECONCILED") ? "data unverified"
      : o.flags.includes("ONCHAIN_GROSS_SUSPECT") ? "yield looks too high — discounted"
      : o.held ? "you're in this" : good ? "ready to deploy" : "not worth it right now";
    let btn;
    if (o.held) btn = `<span class="pill held">In your portfolio</span>`;
    else if (!good) btn = `<span class="pill skip">Skipped</span>`;
    else if (slotsFull) btn = `<button disabled>Portfolio full</button>`;
    else if (!o.fitsCapital) btn = `<button disabled>Not enough capital free</button>`;
    else btn = `<button class="deploy" data-pool="${o.pool}" data-pair="${o.pair}" data-size="${Math.round(o.position_usd)}" data-apr="${apr.toFixed(0)}">Deploy ${fmt$(o.position_usd)} →</button>`;
    return `<div class="${cls}">
      <div class="opp-pair">${o.pair} <span class="muted tiny">±${((o.width_mult-1)*100).toFixed(o.width_mult<1.01?2:1)}%</span></div>
      <div class="opp-apr ${apr>=0?"pos":"neg"}">${pct(apr)} <small>net APR</small></div>
      <div class="opp-line"><span class="muted">Suggested amount</span><span class="v">${fmt$(o.position_usd)}</span></div>
      <div class="opp-line"><span class="muted">Est. earnings</span><span class="v">${fmt$(o.net_usd_h)}/wk · ${fmt$(o.net_usd_h*52/12)}/mo</span></div>
      <div class="opp-line"><span class="muted">Status</span><span class="v">${flagNote}</span></div>
      <div class="opp-foot">${btn}</div>
    </div>`;
  }).join("");

  document.querySelectorAll(".deploy").forEach((b) => b.addEventListener("click", async () => {
    const { pool, pair, size, apr } = b.dataset;
    const liveWord = STATE.mode === "live" && STATE.validationPassed ? "REAL money" : "practice money";
    const okClass = liveWord.startsWith("REAL") ? "live" : "primary";
    const ok = await confirmDialog(
      `Deploy ${fmt$(+size)} into ${pair}?`,
      `This opens a position with ${liveWord} at about ${apr}% net APR and the bot manages it automatically (rebalances, exits if it stops being profitable). You can close it anytime.`,
      liveWord.startsWith("REAL") ? "Deploy real money" : "Deploy",
      okClass,
    );
    if (!ok) return;
    b.disabled = true; b.textContent = "Deploying…";
    const r = await post("/api/control/deploy", { pool });
    if (!r.ok) alert(r.output || "Could not deploy.");
    setTimeout(refreshAll, 1500);
  }));
}

// ---- positions ----
async function refreshPositions() {
  const p = await get("/api/positions");
  if (!p.open || p.open.length === 0) {
    $("#positions").innerHTML = `<div class="empty">No money deployed yet. Pick a strategy above, or hit <b>Start auto-trading</b>.</div>`;
    return;
  }
  $("#positions").innerHTML = p.open.map((pos) => {
    const c = p.checks.find((x) => x.payload.paperId === pos.id)?.payload;
    const upnl = c ? c.valueUsd + c.feesUsd + c.pendingAeroUsd - pos.position_usd : null;
    const inRange = c ? (c.tick >= pos.tick_lower && c.tick < pos.tick_upper) : null;
    return `<div class="pos">
      <div class="pos-top"><b>${pos.pair}</b>
        ${inRange===null?"":inRange?'<span class="inrange">● earning</span>':'<span class="outrange">● paused (out of range)</span>'}</div>
      <div class="row"><span>Deployed</span><span>${fmt$(pos.position_usd)}</span></div>
      <div class="row"><span>Earned so far</span><span>${fmt$(pos.fees_usd + (c?.pendingAeroUsd||0))}</span></div>
      <div class="row"><span>Profit/loss</span><span class="pos-pnl ${upnl>=0?"pos":"neg"}">${fmt$(upnl)}</span></div>
      <div style="margin-top:.6rem"><button class="ghost danger" data-id="${pos.id}">Close position</button></div>
    </div>`;
  }).join("");
  document.querySelectorAll("[data-id]").forEach((b) => b.addEventListener("click", async () => {
    const ok = await confirmDialog("Close this position?", "The bot will cash out and record the result. You keep all earnings minus a small exit cost.", "Close it", "danger");
    if (!ok) return;
    await post("/api/control/paper/close", { id: +b.dataset.id });
    setTimeout(refreshAll, 1500);
  }));
}

// ---- forecast ----
async function refreshForecast() {
  const d = await get("/api/opportunities");
  const top = (d.opportunities || []).filter((o) => o.viable).slice(0, d.maxPositions || 3);
  const wkly = top.reduce((a, o) => a + o.net_usd_h, 0);
  const daily = wkly / 7;
  // decay-aware month: pockets compress; assume capture halves ~every 2 weeks,
  // backfilled by rotation. Conservative effective factor on the naive run-rate.
  const horizons = [
    { label: "1 month", days: 30, factor: 0.65 },
    { label: "3 months", days: 91, factor: 0.5 },
    { label: "6 months", days: 182, factor: 0.4 },
    { label: "1 year", days: 365, factor: 0.35 },
  ];
  $("#forecast").innerHTML = horizons.map((h) => `
    <div class="fc"><div class="fc-label">${h.label}</div>
      <div class="fc-val">${fmt$(daily * h.days * h.factor)}</div>
      <div class="fc-sub">on ${fmt$(d.deployedUsd || top.reduce((a,o)=>a+o.position_usd,0))} working</div></div>`).join("");
  $("#forecast-note").textContent = top.length
    ? `Based on the ${top.length} best strategies the bot found, at ~${fmt$(daily)}/day today — discounted for pools getting crowded over time (the honest part: these returns shrink as others copy them, so later months earn less).`
    : "No profitable strategies detected right now — the bot waits in cash rather than lose money.";
}

// ---- advanced (collapsed) ----
async function refreshAdvanced() {
  const s = await get("/api/status");
  $("#adv-state").textContent = `paper ${s.tasks.paper.state} · backtest ${s.tasks.backtest.state}`;
  const v = s.validation, th = v.thresholds;
  $("#validation").innerHTML = [
    ["Test trades done", `${v.entries} / ${th.validation_min_entries}`, v.entries >= th.validation_min_entries],
    ["Predictions matched reality", v.signAgreement==null?"—":`${(v.signAgreement*100).toFixed(0)}% / ${th.validation_min_sign_agreement*100}%`, v.signAgreement!=null && v.signAgreement>=th.validation_min_sign_agreement],
    ["Returns realistic (not over-promised)", v.meanRatio==null?"—":`${v.meanRatio.toFixed(2)}×`, v.meanRatio!=null && v.meanRatio>=th.validation_ratio_min && v.meanRatio<=th.validation_ratio_max],
  ].map(([k,val,ok]) => `<div class="gatebar"><span>${k}</span><span class="${ok?"pos":"neg"}">${val} ${ok?"✓":"✗"}</span></div>`).join("");
  const dec = await get("/api/decisions?limit=30");
  $("#decisions").innerHTML = dec.decisions.map((x) => `<div class="r"><span class="muted">${ago(x.ts)}</span> ${x.kind} ${x.decision} <span class="muted">${x.payload.pair||""} ${x.payload.reasons?.join("; ")||x.payload.triggers?.join("; ")||""}</span></div>`).join("");
}

// ---- master controls ----
$("#auto-toggle").addEventListener("click", async () => {
  if (STATE.auto) { await post("/api/control/paper/stop"); setTimeout(refreshAll, 800); return; }
  const goLive = STATE.mode === "live" && STATE.validationPassed;
  const ok = await confirmDialog(
    goLive ? "Start REAL-money auto-trading?" : "Start auto-trading (practice money)?",
    goLive
      ? "The bot will deploy REAL money into the best pools it finds and manage them 24/7. It only trades strategies that passed validation. You can pause anytime."
      : "The bot will trade with practice money to find and prove the best strategies. No real funds are used. This also builds the track record that unlocks real trading.",
    goLive ? "Start real trading" : "Start practice trading",
    goLive ? "live" : "primary",
  );
  if (!ok) return;
  await post(goLive ? "/api/control/live/start" : "/api/control/paper/start", goLive ? { confirm: "LIVE" } : {});
  attachLogs(); setTimeout(refreshAll, 1200);
});
$("#paper-stop").addEventListener("click", async () => { await post("/api/control/paper/stop"); setTimeout(refreshAll, 800); });
$("#bt-run").addEventListener("click", async () => { await post("/api/control/backtest/start", { days: 14 }); attachLogs("backtest"); $("#bt-run").textContent = "Running…"; setTimeout(() => { $("#bt-run").textContent = "Run 14-day backtest"; }, 4000); });

// ---- logs ----
let es = null;
function attachLogs(task = "paper") {
  if (es) es.close();
  es = new EventSource(`/api/logs/${task}`);
  es.onmessage = (e) => { const el = $("#logs"); el.textContent += JSON.parse(e.data) + "\n"; el.scrollTop = el.scrollHeight; };
}

// ---- boot ----
function refreshAll() {
  const q = (p) => p.catch(() => {});
  q(refreshStatus()); q(refreshOpps()); q(refreshPositions()); q(refreshForecast()); q(refreshAdvanced());
}
refreshAll();
attachLogs();
setInterval(refreshAll, 7000);
