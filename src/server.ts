import Fastify from "fastify";
import { OrchestratorService } from "./orchestrator.service.js";
import { IntegrationRegistry, type JsonRecord } from "./registry.js";
import { verifyPatchInSandbox } from "./simulator.js";

interface InterceptedIncident {
  id: string;
  integrationId: string;
  capturedAt: string;
  errorLog: string;
  payload: JsonRecord;
  diagnostic?: string;
  patchedCode?: string;
  verification?: string;
  outcome: "intercepted" | "healed" | "rejected" | "failed";
}

const modelName = process.env.OPENAI_MODEL || "gpt-5.6";
const demoMode = process.env.GHOSTWORKER_DEMO_MODE === "true";
const registry = new IntegrationRegistry();
const orchestrator = new OrchestratorService();
const incidents: InterceptedIncident[] = [];
const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "info" } });

const asRecord = (value: unknown): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Webhook payload must be a JSON object");
  return value as JsonRecord;
};

const formatError = (error: unknown): string => error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const addIncident = (incident: InterceptedIncident): void => {
  incidents.unshift(incident);
  incidents.splice(50);
};

const dashboardHtml = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Ghostworker | Autonomous Recovery Console</title>
    <style>
      :root { color-scheme: dark; --ink: #f5f7ff; --muted: #9aa6c6; --line: rgba(157, 177, 255, .17); --surface: rgba(14, 20, 42, .82); --error: #ff6983; --mint: #59f2c1; --violet: #9985ff; --bg: #060817; }
      * { box-sizing: border-box; }
      body { min-width: 320px; margin: 0; color: var(--ink); background: radial-gradient(circle at 10% 0%, #182b63 0, transparent 31rem), radial-gradient(circle at 90% 100%, #371766 0, transparent 35rem), var(--bg); font: 15px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(1440px, calc(100% - 40px)); margin: 0 auto; padding: 42px 0; }
      .topbar { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-bottom: 30px; }
      .eyebrow { margin: 0 0 7px; color: var(--mint); font-size: 11px; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; }
      h1 { margin: 0; font-size: clamp(28px, 4vw, 46px); letter-spacing: -.045em; }
      .subtitle { margin: 8px 0 0; color: var(--muted); }
      .status { display: flex; align-items: center; gap: 9px; flex: none; border: 1px solid var(--line); border-radius: 999px; padding: 9px 13px; background: rgba(7, 11, 30, .72); color: #d7e0ff; font-size: 12px; font-weight: 700; }
      .pulse { width: 9px; height: 9px; border-radius: 50%; background: var(--mint); box-shadow: 0 0 0 0 rgba(89, 242, 193, .65); animation: pulse 1.8s infinite; }
      @keyframes pulse { 75%, 100% { box-shadow: 0 0 0 9px rgba(89, 242, 193, 0); } }
      .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 13px; margin-bottom: 18px; }
      .metric, .panel { border: 1px solid var(--line); background: var(--surface); box-shadow: 0 18px 50px rgba(0, 0, 0, .2); backdrop-filter: blur(16px); }
      .metric { border-radius: 14px; padding: 15px 18px; }
      .metric small { display: block; color: var(--muted); font-size: 11px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
      .metric strong { display: block; margin-top: 4px; font-size: 22px; }
      .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; }
      .panel { min-height: 510px; overflow: hidden; border-radius: 17px; }
      .panel-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 21px 22px 17px; border-bottom: 1px solid var(--line); }
      .panel h2 { margin: 0; font-size: 17px; letter-spacing: -.015em; }
      .panel-label { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
      .tag { border: 1px solid currentColor; border-radius: 999px; padding: 3px 8px; font-size: 10px; font-weight: 800; letter-spacing: .09em; }
      .tag.error { color: var(--error); } .tag.patch { color: var(--mint); }
      .content { padding: 21px 22px; }
      .field { margin-bottom: 17px; }
      .field:last-child { margin-bottom: 0; }
      .field-label { display: block; margin-bottom: 7px; color: var(--muted); font-size: 10px; font-weight: 800; letter-spacing: .11em; text-transform: uppercase; }
      pre { min-height: 52px; max-height: 230px; margin: 0; overflow: auto; border: 1px solid rgba(157, 177, 255, .13); border-radius: 10px; padding: 13px; background: rgba(2, 4, 14, .68); color: #ced7fc; font: 12px/1.65 "SFMono-Regular", Consolas, "Liberation Mono", monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
      .error-code { color: #ffb2c0; } .patch-code { color: #b8fae5; }
      .empty { display: grid; min-height: 370px; place-items: center; color: var(--muted); text-align: center; }
      .empty div { max-width: 300px; } .empty strong { display: block; margin-bottom: 7px; color: #d6ddf9; font-size: 15px; }
      .outcome { display: inline-flex; margin-top: 2px; border-radius: 999px; padding: 4px 8px; background: rgba(89, 242, 193, .1); color: var(--mint); font-size: 11px; font-weight: 800; text-transform: uppercase; }
      .outcome.failed, .outcome.rejected { background: rgba(255, 105, 131, .12); color: var(--error); }
      @media (max-width: 800px) { main { width: min(100% - 26px, 1440px); padding: 26px 0; } .topbar { align-items: flex-start; flex-direction: column; } .metrics, .grid { grid-template-columns: 1fr; } .panel { min-height: 0; } }
    </style>
  </head>
  <body>
    <main>
      <header class="topbar">
        <div><p class="eyebrow">Ghostworker / Production Telemetry</p><h1>Autonomous Recovery Console</h1><p class="subtitle">Live drift interception, agentic repair, and verified hot-swap telemetry.</p></div>
        <div class="status"><span class="pulse"></span><span id="modelName">Connecting…</span></div>
      </header>
      <section class="metrics" aria-label="System metrics"><article class="metric"><small>Active integrations</small><strong id="routeCount">0</strong></article><article class="metric"><small>Healing events</small><strong id="healingCount">0</strong></article><article class="metric"><small>Polling cadence</small><strong>1.5s</strong></article></section>
      <section class="grid">
        <article class="panel"><header class="panel-header"><div><h2>❌ Intercepted Schema Mismatch Error</h2><p class="panel-label">Captured failure envelope and incoming transaction.</p></div><span class="tag error">INTERCEPT</span></header><div class="content" id="errorPanel"><div class="empty"><div><strong>Standing by for a drift event</strong>Run the simulation script to stream an intercepted webhook failure here.</div></div></div></article>
        <article class="panel"><header class="panel-header"><div><h2>✨ Codex Auto-Generated Structural Patch</h2><p class="panel-label">Model diagnosis, candidate adapter, and verification result.</p></div><span class="tag patch">REPAIR</span></header><div class="content" id="patchPanel"><div class="empty"><div><strong>Awaiting repair proposal</strong>Verified code corrections appear after the recovery pipeline runs.</div></div></div></article>
      </section>
    </main>
    <script>
      const byId = (id) => document.getElementById(id);
      const createField = (label, value, className) => {
        const field = document.createElement("section"); field.className = "field";
        const title = document.createElement("span"); title.className = "field-label"; title.textContent = label;
        const body = document.createElement("pre"); body.className = className || ""; body.textContent = value;
        field.append(title, body); return field;
      };
      const emptyPanel = (text) => { const wrapper = document.createElement("div"); wrapper.className = "empty"; const message = document.createElement("div"); message.textContent = text; wrapper.append(message); return wrapper; };
      const updateDashboard = (data) => {
        byId("modelName").textContent = data.demoMode ? (data.model || "OpenAI") + " demo mode · no external API" : (data.model || "OpenAI") + " connected";
        byId("routeCount").textContent = String((data.activeRoutes || []).length);
        byId("healingCount").textContent = String((data.healingLogs || []).length);
        const incident = (data.incidents || [])[0];
        const errorPanel = byId("errorPanel"); const patchPanel = byId("patchPanel");
        errorPanel.replaceChildren(); patchPanel.replaceChildren();
        if (!incident) { errorPanel.append(emptyPanel("No intercepted webhook failures yet.")); patchPanel.append(emptyPanel("No patch proposals have been generated yet.")); return; }
        const metadata = document.createElement("section"); metadata.className = "field";
        const metaLabel = document.createElement("span"); metaLabel.className = "field-label"; metaLabel.textContent = "Incident metadata";
        const outcome = document.createElement("span"); outcome.className = "outcome " + incident.outcome; outcome.textContent = incident.outcome + " · " + incident.integrationId + " · " + new Date(incident.capturedAt).toLocaleTimeString();
        metadata.append(metaLabel, outcome); errorPanel.append(metadata, createField("Caught runtime error", incident.errorLog, "error-code"), createField("Transaction payload", JSON.stringify(incident.payload, null, 2)));
        patchPanel.append(createField("Diagnostic adjustment", incident.diagnostic || "Recovery agents are still evaluating this incident."), createField("Refactored adapter code", incident.patchedCode || "No candidate patch was produced.", "patch-code"), createField("Verification evidence", incident.verification || "Pending sandbox verification."));
      };
      const poll = async () => {
        try { const response = await fetch("/api/v1/status", { headers: { Accept: "application/json" }, cache: "no-store" }); if (!response.ok) throw new Error("Status request failed: " + response.status); updateDashboard(await response.json()); }
        catch (error) { console.error("Ghostworker telemetry polling error", error); byId("modelName").textContent = "Telemetry reconnecting…"; }
      };
      poll(); window.setInterval(poll, 1500);
    </script>
  </body>
</html>`;

app.get("/dashboard", async (_request, reply) => reply.type("text/html; charset=utf-8").send(dashboardHtml));

app.post<{ Params: { integrationId: string }; Body: JsonRecord }>("/api/v1/webhook-ingress/:integrationId", async (request, reply) => {
  const adapter = registry.get(request.params.integrationId);
  if (!adapter) return reply.code(404).send({ error: "Unknown integration" });

  let payload: JsonRecord | undefined;
  try {
    payload = asRecord(request.body);
    const output = adapter.execute(structuredClone(payload));
    request.log.info({ integrationId: adapter.integrationId, revision: adapter.revision }, "[GHOSTWORKER][PROXY][PASS] adapter mapped webhook");
    return reply.code(200).send({ status: 200, integrationId: adapter.integrationId, revision: adapter.revision, data: output });
  } catch (originalError) {
    const errorLog = formatError(originalError);
    const capturedPayload = payload ?? (request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body : { receivedPayload: request.body ?? null });
    const incident: InterceptedIncident = { id: request.id, integrationId: adapter.integrationId, capturedAt: new Date().toISOString(), errorLog, payload: structuredClone(capturedPayload), outcome: "intercepted" };
    addIncident(incident);
    request.log.warn({ integrationId: adapter.integrationId, errorLog }, "[GHOSTWORKER][HEAL][TRIGGER] adapter failure isolated");
    try {
      payload ??= asRecord(request.body);
      const proposal = await orchestrator.healWorkflowFailure(adapter.code, errorLog, payload);
      incident.diagnostic = proposal.diagnostic;
      incident.patchedCode = proposal.refactoredCode;
      const verification = await verifyPatchInSandbox(proposal.refactoredCode, payload);
      incident.verification = verification.reason;
      if (!verification.approved || !verification.execute) {
        incident.outcome = "rejected";
        registry.recordHealing({ integrationId: adapter.integrationId, outcome: "rejected", diagnostic: proposal.diagnostic, errorLog: verification.reason, model: modelName });
        return reply.code(422).send({ error: "Repair rejected", diagnostic: proposal.diagnostic, verification: verification.reason });
      }
      const updated = registry.hotSwap(adapter.integrationId, proposal.refactoredCode, verification.execute);
      incident.outcome = "healed";
      registry.recordHealing({ integrationId: updated.integrationId, outcome: "healed", diagnostic: proposal.diagnostic, errorLog, model: modelName });
      request.log.info({ integrationId: updated.integrationId, revision: updated.revision, model: modelName, sandbox: verification.modelEvidence }, "[GHOSTWORKER][GPT-5.6][HOT-SWAP] verified repair deployed");
      return reply.code(200).send({ status: 200, healed: true, integrationId: updated.integrationId, revision: updated.revision, data: verification.output });
    } catch (healingError) {
      const healingLog = formatError(healingError);
      incident.outcome = "failed";
      incident.verification = healingLog;
      registry.recordHealing({ integrationId: adapter.integrationId, outcome: "failed", diagnostic: "Healing pipeline failed closed", errorLog: healingLog, model: modelName });
      request.log.error({ integrationId: adapter.integrationId, healingLog }, "[GHOSTWORKER][HEAL][FAIL-CLOSED] repair unavailable");
      return reply.code(502).send({ error: "Adapter failed and repair did not pass verification", requestId: request.id });
    }
  }
});

app.get("/api/v1/status", async () => ({ model: modelName, demoMode, incidents: [...incidents], ...registry.status() }));

const seedCode = "(payload) => { if (!payload.id) { throw new Error('Schema Mismatch: missing root payload property id'); } return { eventId: String(payload.id), receivedAt: new Date().toISOString() }; }";
registry.register("example", seedCode, new Function(`return (${seedCode})`)() as (payload: JsonRecord) => JsonRecord);

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: Number(process.env.PORT || 3000), host: process.env.HOST || "0.0.0.0" });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

await start();
