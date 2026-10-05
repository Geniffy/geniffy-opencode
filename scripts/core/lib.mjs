// Shared by every script: where the plugin's files live, the sign-in, calls to the Geniffy memory tools, and
// what is kept out of anything saved. Node 18 or later, no dependencies.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SIGN_IN, TOOL } from "./tool.mjs";

export const API = (process.env.GENIFFY_API_URL || "https://api.geniffy.com").replace(/\/+$/, "");
export const MCP_URL = `${API}/mcp`;
export const SCOPES = "memory:read memory:write";
const PROTOCOL = "2025-11-25";

// Everything the plugin keeps on this computer, in one folder of its own.
export const HOME = process.env.GENIFFY_PLUGIN_HOME || path.join(os.homedir(), ".geniffy", TOOL);
const file = (name) => path.join(HOME, name);

// ── files ───────────────────────────────────────────────────────────────────────────────────────────────
export function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8"));
  } catch {
    return null;
  }
}

// Written whole and then renamed into place, so a reader never sees half a file, and readable only by this
// user where the system allows it.
export function writeJson(name, value) {
  fs.mkdirSync(path.dirname(file(name)), { recursive: true, mode: 0o700 });
  const tmp = file(`${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file(name));
}

export function removeFile(name) {
  fs.rmSync(file(name), { recursive: true, force: true });
}

// Turns that never finished (a closed window, a crash), a couple of days old, are cleared out.
export function sweepTurns(olderThanMs = 2 * 24 * 3600_000) {
  const dir = file("turns");
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (Date.now() - fs.statSync(p).mtimeMs > olderThanMs) fs.rmSync(p, { force: true });
    }
  } catch {}
}

export const state = () => readJson("state.json") || {};
export const setState = (patch) => writeJson("state.json", { ...state(), ...patch });

// ── the sign-in ─────────────────────────────────────────────────────────────────────────────────────────
export class NotSignedIn extends Error {
  constructor() {
    super(`Not signed in to Geniffy: ${SIGN_IN}.`);
    this.name = "NotSignedIn";
  }
}

export const credentials = () => readJson("credentials.json");

// Saving needs a sign-in that allowed it, and saving not paused.
export const canSave = () => {
  const creds = credentials();
  return Boolean(creds && String(creds.scope || "").includes("memory:write") && !state().paused);
};

let metadata;
export async function discover() {
  if (!metadata) {
    const res = await fetchWithin(`${API}/.well-known/oauth-authorization-server`, {}, 8000);
    if (!res.ok) throw new Error(`Geniffy's sign-in is not reachable (HTTP ${res.status}).`);
    metadata = await res.json();
  }
  return metadata;
}

export function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

// A refresh token works once: Geniffy treats a second use as theft and ends the sign-in. Several hooks can
// need a fresh token at the same moment, so a refresh happens under a lock, and whoever gets the lock second
// finds the token already refreshed.
async function withLock(fn) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const lock = file("refresh.lock");
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 20000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

const FRESH_FOR_MS = 60_000;

// A token that works for at least another minute, refreshed if it needs to be; null when signed out.
export async function accessToken({ force = false } = {}) {
  let creds = credentials();
  if (!creds) return null;
  if (!force && creds.expires_at - Date.now() > FRESH_FOR_MS) return creds.access_token;
  const seen = creds.access_token;
  return withLock(async () => {
    creds = credentials();
    if (!creds) return null;
    if (creds.access_token !== seen || (!force && creds.expires_at - Date.now() > FRESH_FOR_MS)) {
      return creds.access_token; // another process refreshed while this one waited
    }
    const meta = await discover();
    const res = await fetchWithin(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: creds.refresh_token,
                                  client_id: creds.client_id, resource: MCP_URL }),
    }, 8000);
    if (!res.ok) {
      // Only a refusal of the refresh token itself means the sign-in is over; anything else may pass.
      const body = await res.json().catch(() => ({}));
      if (body.error === "invalid_grant" || body.error === "invalid_client") removeFile("credentials.json");
      return null;
    }
    const t = await res.json();
    writeJson("credentials.json", { ...creds, access_token: t.access_token, refresh_token: t.refresh_token || creds.refresh_token,
                                    expires_at: Date.now() + (t.expires_in || 3600) * 1000, scope: t.scope || creds.scope });
    return t.access_token;
  });
}

// ── the memory tools ────────────────────────────────────────────────────────────────────────────────────
export class ToolError extends Error {
  name = "ToolError";
}

async function rpc(token, method, params, timeoutMs) {
  return fetchWithin(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
               "MCP-Protocol-Version": PROTOCOL, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }, timeoutMs);
}

// One JSON-RPC call to Geniffy's MCP server with this computer's sign-in, retried once with a fresh token
// when the server says the token is no longer good.
export async function call(method, params = {}, { timeoutMs = 15000 } = {}) {
  let token = await accessToken();
  if (!token) throw new NotSignedIn();
  let res = await rpc(token, method, params, timeoutMs);
  if (res.status === 401) {
    token = await accessToken({ force: true });
    if (!token) throw new NotSignedIn();
    res = await rpc(token, method, params, timeoutMs);
    if (res.status === 401) throw new NotSignedIn();
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw new ToolError(`Geniffy answered HTTP ${res.status}.`);
  if (body.error) throw new ToolError(body.error.message || "Geniffy refused the call.");
  return body.result;
}

export async function tool(name, args = {}, opts) {
  const result = await call("tools/call", { name, arguments: args }, opts);
  if (result.isError) throw new ToolError(result.content?.[0]?.text || `${name} failed.`);
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text || "{}");
}

export async function fetchWithin(url, init, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── what is never saved ─────────────────────────────────────────────────────────────────────────────────
// Keys, tokens, passwords and private keys are replaced before anything leaves this computer. Matched by
// shape, so a secret pasted into a prompt is caught whatever it belongs to.
const GONE = "[secret removed]";
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bgnf_(?:live|test|at|rt)_[A-Za-z0-9_-]{12,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{12,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bpypi-[A-Za-z0-9_-]{40,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\brzp_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/g,
];
const LABELLED = /\b((?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|token|auth[_-]?token)["']?\s*[:=]\s*)(["']?)(?!\[secret removed\])([^\s"']{6,})\2/gi;
const URL_PASSWORD = /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^:\s/'"@]+:)[^@\s'"]{3,}@/gi;

export function scrub(text) {
  let out = String(text || "");
  for (const rx of SECRETS) out = out.replace(rx, GONE);
  out = out.replace(LABELLED, (_m, label, q) => `${label}${q}${GONE}${q}`);
  out = out.replace(URL_PASSWORD, (_m, head) => `${head}${GONE}@`);
  return out;
}

// What one exchange becomes before it is saved: code blocks left out (code lives in the repository, and a
// memory is for what was decided), secrets removed, and each side kept short.
const PER_SIDE = 4000;

function tidy(text) {
  const prose = String(text || "").replace(/```[\s\S]*?(?:```|$)/g, "[code left out]");
  const clean = scrub(prose).replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > PER_SIDE ? `${clean.slice(0, PER_SIDE - 1).trimEnd()}…` : clean;
}

// The conversation to save for one turn, or null when there is nothing worth a memory.
export function exchange(prompts, reply) {
  const said = prompts.map(tidy).filter(Boolean).join("\n\n");
  const answer = tidy(reply);
  if (!said || said.replace(/\[code left out\]|\[secret removed\]/g, "").trim().length < 12) return null;
  const messages = [{ role: "user", content: said }];
  if (answer) messages.push({ role: "assistant", content: answer });
  return messages;
}

export function projectName(cwd) {
  return path.basename(path.resolve(cwd || process.cwd())) || "a project";
}

// ── hooks ───────────────────────────────────────────────────────────────────────────────────────────────
export async function hookInput() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export function reply(obj) {
  process.stdout.write(JSON.stringify(obj));
}

// A conversation's prompts wait here until the turn they belong to is finished.
export const turnFile = (id) => path.join("turns", `${String(id || "unknown").replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
