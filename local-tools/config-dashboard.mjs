#!/usr/bin/env node
// Standalone step-config editor for Antfarm workflows.
// Run from inside the antfarm install dir so it can use the local `yaml`
// dependency and find `dist/cli/cli.js` for apply-changes:
//   cd ~/.openclaw/workspace/antfarm && node local-tools/config-dashboard.mjs
// Then open http://localhost:3334
//
// Delegation variants: each agent role's live AGENTS.md/SOUL.md can be
// swapped between workflows/<wf>/agents/<role>/variants/claude-only/ and
// .../variants/cursor-delegated/. If a role has no cursor-delegated
// variant folder (e.g. browser-qa — Cursor's CLI has no browser
// capability), that option is disabled in the UI, not hidden silently.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";

const PORT = process.env.CONFIG_DASHBOARD_PORT ? Number(process.env.CONFIG_DASHBOARD_PORT) : 3334;
const ANTFARM_ROOT = process.cwd();
const WORKFLOWS_DIR = path.join(ANTFARM_ROOT, "workflows");
const CLI_PATH = path.join(ANTFARM_ROOT, "dist", "cli", "cli.js");

const KNOWN_MODELS = [
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-4-5",
  "anthropic/claude-haiku-4-5",
];

function listWorkflowIds() {
  if (!fs.existsSync(WORKFLOWS_DIR)) return [];
  return fs.readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(WORKFLOWS_DIR, name, "workflow.yml")));
}

function workflowYmlPath(workflowId) {
  return path.join(WORKFLOWS_DIR, workflowId, "workflow.yml");
}

function agentDir(workflowId, agentId) {
  return path.join(WORKFLOWS_DIR, workflowId, "agents", agentId);
}

function variantDir(workflowId, agentId, variant) {
  return path.join(agentDir(workflowId, agentId), "variants", variant);
}

function readFirstNonEmptyLine(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const line = content.split("\n").find((l) => l.trim().length > 0) ?? "";
    return line.replace(/^#\s*/, "").trim();
  } catch {
    return "";
  }
}

function classifyDelegation(title) {
  const t = title.toLowerCase();
  if (t.includes("cursor-assisted")) return "cursor-assisted";
  if (t.includes("cursor-delegated")) return "cursor-delegated";
  return "claude-only";
}

function availableVariants(workflowId, agentId) {
  const base = path.join(agentDir(workflowId, agentId), "variants");
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(base, e.name, "AGENTS.md")))
    .map((e) => e.name);
}

function getWorkflowConfig(workflowId) {
  const ymlPath = workflowYmlPath(workflowId);
  if (!fs.existsSync(ymlPath)) return null;
  const doc = YAML.parseDocument(fs.readFileSync(ymlPath, "utf-8"));
  const parsed = doc.toJS();

  const agentsById = new Map();
  for (const a of parsed.agents ?? []) agentsById.set(a.id, a);

  const steps = (parsed.steps ?? []).map((s) => {
    const agentDef = agentsById.get(s.agent);
    const liveTitle = readFirstNonEmptyLine(path.join(agentDir(workflowId, s.agent), "AGENTS.md"));
    const variants = availableVariants(workflowId, s.agent);
    return {
      stepId: s.id,
      agentId: s.agent,
      model: agentDef?.model ?? null,
      activeDelegation: classifyDelegation(liveTitle),
      availableVariants: variants.length ? variants : ["claude-only"],
    };
  });

  return { workflowId, steps };
}

function setAgentModel(workflowId, agentId, model) {
  const ymlPath = workflowYmlPath(workflowId);
  if (!fs.existsSync(ymlPath)) return { ok: false, error: "workflow not found" };
  const raw = fs.readFileSync(ymlPath, "utf-8");
  const doc = YAML.parseDocument(raw);
  const agents = doc.get("agents");
  if (!agents || !agents.items) return { ok: false, error: "no agents block found in workflow.yml" };

  let found = false;
  for (const item of agents.items) {
    const idVal = item.get ? item.get("id") : undefined;
    if (idVal === agentId) {
      item.set("model", model);
      found = true;
      break;
    }
  }
  if (!found) return { ok: false, error: `agent '${agentId}' not found in agents block` };

  fs.writeFileSync(ymlPath, doc.toString());
  return { ok: true };
}

function setAgentVariant(workflowId, agentId, variant) {
  const srcDir = variantDir(workflowId, agentId, variant);
  if (!fs.existsSync(path.join(srcDir, "AGENTS.md"))) {
    return { ok: false, error: `variant '${variant}' not available for agent '${agentId}'` };
  }
  const destDir = agentDir(workflowId, agentId);
  for (const file of ["AGENTS.md", "SOUL.md"]) {
    const src = path.join(srcDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(destDir, file));
    }
  }
  return { ok: true };
}

function reinstallWorkflow(workflowId) {
  if (!fs.existsSync(CLI_PATH)) {
    return { ok: false, error: `CLI not found at ${CLI_PATH} — run this script from the antfarm root (cd ~/.openclaw/workspace/antfarm)` };
  }
  try {
    const uninstallOut = execFileSync("node", [CLI_PATH, "workflow", "uninstall", workflowId, "--force"], { encoding: "utf-8" });
    const installOut = execFileSync("node", [CLI_PATH, "workflow", "install", workflowId], { encoding: "utf-8" });
    return { ok: true, output: `${uninstallOut}\n${installOut}` };
  } catch (err) {
    return { ok: false, error: err?.stderr?.toString?.() || err?.message || String(err) };
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      try {
        resolve(chunks ? JSON.parse(chunks) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Antfarm — Step Config</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 24px 64px; background: #0f1115; color: #e7e9ee;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; }
  .wrap { max-width: 1180px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .subtitle { color: #9aa2b1; font-size: 13px; margin: 0 0 20px; }
  select { background: #171a21; color: #e7e9ee; border: 1px solid #262b36; border-radius: 6px;
           padding: 6px 8px; font-size: 13px; width: 100%; }
  select:disabled { opacity: .4; cursor: not-allowed; }
  table { width: 100%; border-collapse: collapse; background: #171a21; border: 1px solid #262b36;
          border-radius: 10px; overflow: hidden; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: #9aa2b1;
       padding: 10px 14px; border-bottom: 1px solid #262b36; }
  td { padding: 10px 14px; border-bottom: 1px solid #262b36; font-size: 13px; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  .hint { color: #6b7280; font-size: 11px; margin-top: 4px; }
  button { background: #5b8cff; color: #fff; border: none; border-radius: 6px; padding: 7px 14px;
           font-size: 13px; cursor: pointer; font-weight: 600; }
  button:hover { background: #4676ea; }
  button.secondary { background: #262b36; }
  button.secondary:hover { background: #323847; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .status { font-size: 12.5px; color: #9aa2b1; white-space: pre-wrap; margin-top: 16px; padding: 12px;
            background: #171a21; border: 1px solid #262b36; border-radius: 8px; display: none; max-height: 240px; overflow: auto; }
  .status.show { display: block; }
  .status.error { color: #ff8080; }
  .dirty-flag { color: #e8b339; font-size: 11px; margin-left: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Step Config — <span id="wf-name"></span></h1>
  <p class="subtitle">Change which model coordinates each step and whether it delegates to Cursor, then Apply to reinstall the workflow.</p>
  <div class="toolbar">
    <div id="dirty-note"></div>
    <button id="apply-btn" class="secondary" disabled>Apply changes (reinstall workflow)</button>
  </div>
  <table>
    <thead><tr><th style="width:14%">Step</th><th style="width:14%">Agent</th><th style="width:26%">Coordinator model</th><th style="width:26%">AI Service</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="status" class="status"></div>
</div>
<script>
const KNOWN_MODELS = ${JSON.stringify(KNOWN_MODELS)};
let pendingModel = {};    // agentId -> model
let pendingVariant = {};  // agentId -> variant
let workflowId = new URLSearchParams(location.search).get("workflow") || "thecoach-dev";

async function load() {
  const res = await fetch("/api/config?workflow=" + encodeURIComponent(workflowId));
  const data = await res.json();
  document.getElementById("wf-name").textContent = data.workflowId;
  const rows = document.getElementById("rows");
  rows.innerHTML = "";
  for (const step of data.steps) {
    const tr = document.createElement("tr");
    const modelOptions = KNOWN_MODELS.map(m =>
      \`<option value="\${m}" \${m === step.model ? "selected" : ""}>\${m}</option>\`
    ).join("");
    const hasCursor = step.availableVariants.includes("cursor-delegated");
    const variantOptions = \`
      <option value="claude-only" \${step.activeDelegation === "claude-only" ? "selected" : ""}>Claude only</option>
      <option value="cursor-delegated" \${!hasCursor ? "disabled" : ""} \${step.activeDelegation !== "claude-only" ? "selected" : ""}>
        Cursor-delegated\${!hasCursor ? " (not available for this step)" : ""}
      </option>
    \`;
    tr.innerHTML = \`
      <td><strong>\${step.stepId}</strong></td>
      <td>\${step.agentId}</td>
      <td><select data-role="model" data-agent="\${step.agentId}">\${modelOptions}</select></td>
      <td>
        <select data-role="variant" data-agent="\${step.agentId}" \${!hasCursor ? "" : ""}>\${variantOptions}</select>
        \${!hasCursor ? '<div class="hint">Cursor has no browser-driving capability — this step stays Claude-only.</div>' : ""}
      </td>
    \`;
    rows.appendChild(tr);
  }
  rows.querySelectorAll("select[data-role='model']").forEach(sel => {
    sel.addEventListener("change", () => { pendingModel[sel.dataset.agent] = sel.value; updateDirty(); });
  });
  rows.querySelectorAll("select[data-role='variant']").forEach(sel => {
    sel.addEventListener("change", () => { pendingVariant[sel.dataset.agent] = sel.value; updateDirty(); });
  });
}

function updateDirty() {
  const n = Object.keys(pendingModel).length + Object.keys(pendingVariant).length;
  document.getElementById("dirty-note").innerHTML = n
    ? \`<span class="dirty-flag">\${n} unsaved change(s)</span>\`
    : "";
  document.getElementById("apply-btn").disabled = n === 0;
}

document.getElementById("apply-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  statusEl.className = "status show";
  statusEl.textContent = "Saving changes...";
  document.getElementById("apply-btn").disabled = true;
  try {
    for (const [agentId, model] of Object.entries(pendingModel)) {
      const r = await fetch("/api/config/save-model", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: workflowId, agentId, model }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(\`\${agentId} model: \${d.error}\`);
    }
    for (const [agentId, variant] of Object.entries(pendingVariant)) {
      const r = await fetch("/api/config/save-variant", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: workflowId, agentId, variant }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(\`\${agentId} variant: \${d.error}\`);
    }
    statusEl.textContent = "Saved. Reinstalling workflow...";
    const r2 = await fetch("/api/config/apply", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow: workflowId }),
    });
    const d2 = await r2.json();
    if (!d2.ok) {
      statusEl.className = "status show error";
      statusEl.textContent = "Save succeeded but reinstall failed:\\n" + d2.error;
    } else {
      statusEl.className = "status show";
      statusEl.textContent = "Applied.\\n\\n" + d2.output;
      pendingModel = {}; pendingVariant = {};
      updateDirty();
      await load();
    }
  } catch (e) {
    statusEl.className = "status show error";
    statusEl.textContent = "Error: " + e.message;
  }
});

load();
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === "/api/workflows") {
    return json(res, listWorkflowIds());
  }

  if (p === "/api/config" && req.method === "GET") {
    const wf = url.searchParams.get("workflow") ?? "thecoach-dev";
    const cfg = getWorkflowConfig(wf);
    return cfg ? json(res, cfg) : json(res, { error: "workflow not found" }, 404);
  }

  if (p === "/api/config/save-model" && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, { ok: false, error: "invalid JSON body" }, 400);
    const result = setAgentModel(body.workflow, body.agentId, body.model);
    return json(res, result, result.ok ? 200 : 400);
  }

  if (p === "/api/config/save-variant" && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, { ok: false, error: "invalid JSON body" }, 400);
    const result = setAgentVariant(body.workflow, body.agentId, body.variant);
    return json(res, result, result.ok ? 200 : 400);
  }

  if (p === "/api/config/apply" && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, { ok: false, error: "invalid JSON body" }, 400);
    const result = reinstallWorkflow(body.workflow);
    return json(res, result, result.ok ? 200 : 500);
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML);
});

server.listen(PORT, () => {
  console.log(`Step config dashboard: http://localhost:${PORT}`);
  console.log(`Antfarm root: ${ANTFARM_ROOT}`);
  console.log(`Workflows dir: ${WORKFLOWS_DIR}`);
});
