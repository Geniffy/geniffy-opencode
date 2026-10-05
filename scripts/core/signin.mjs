// Signs this computer in to Geniffy in the browser: the same sign-in Claude.ai and ChatGPT use (OAuth with
// PKCE), answered by a short-lived listener on 127.0.0.1. Nothing to copy, and no key to keep.
import { randomBytes } from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { MCP_URL, SCOPES, discover, fetchWithin, pkce, writeJson } from "./lib.mjs";
import { TOOL_NAME } from "./tool.mjs";

const WAIT_MS = Number(process.env.GENIFFY_LOGIN_WAIT_MS) || 5 * 60_000; // tests wait less

export function openBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {}
}

const page = (title, line) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;background:#fafaf8;color:#1a1814;display:grid;place-items:center;min-height:90vh;margin:0">
<main style="max-width:26rem;padding:2rem"><h1 style="font-size:1.4rem;margin:0 0 .5rem">${title}</h1><p style="margin:0;color:#5e574c">${line}</p></main>`;

// Resolves to { ok, message, scope }: never throws, so a hook or a tool can report what happened as it is.
// `onUrl` hears the address to open, for a caller that shows it before the browser does.
export async function signIn({ onUrl = () => {}, browser = !process.env.GENIFFY_NO_BROWSER } = {}) {
  let meta;
  try {
    meta = await discover();
  } catch (err) {
    return { ok: false, message: err.message };
  }

  const server = http.createServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const finish = (result) => {
    server.close();
    return result;
  };

  const registered = await fetchWithin(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: `Geniffy for ${TOOL_NAME}`, redirect_uris: [redirectUri],
                           grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
                           token_endpoint_auth_method: "none", scope: SCOPES }),
  }, 10000).catch(() => null);
  if (!registered?.ok) return finish({ ok: false, message: "Couldn't start the sign-in with Geniffy. Try again in a moment." });
  const { client_id: clientId } = await registered.json();

  const { verifier, challenge } = pkce();
  const expected = randomBytes(16).toString("base64url");
  const url = `${meta.authorization_endpoint}?${new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: SCOPES, state: expected,
    code_challenge: challenge, code_challenge_method: "S256", resource: MCP_URL,
  })}`;
  onUrl(url);
  if (browser) openBrowser(url);

  const answer = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), WAIT_MS);
    server.on("request", (req, res) => {
      const q = new URL(req.url, redirectUri).searchParams;
      if (!req.url.startsWith("/callback") || q.get("state") !== expected) {
        res.writeHead(404).end();
        return;
      }
      const ok = q.get("code") && !q.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(ok
        ? page("Connected", `Your Geniffy memory is connected to ${TOOL_NAME}. You can close this tab.`)
        : page("Not connected", "Nothing was shared. You can close this tab."));
      clearTimeout(timer);
      resolve(q);
    });
  });

  if (!answer) return finish({ ok: false, message: "The sign-in timed out. Try again." });
  if (answer.get("error")) {
    return finish({ ok: false, message: answer.get("error") === "access_denied" ? "You chose not to connect, so nothing was shared."
      : `Geniffy didn't connect: ${answer.get("error_description") || answer.get("error")}.` });
  }
  if (answer.get("iss") && answer.get("iss") !== meta.issuer) {
    return finish({ ok: false, message: "The sign-in answer came from the wrong place, so it was ignored." });
  }

  const exchanged = await fetchWithin(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: answer.get("code"), redirect_uri: redirectUri,
                                client_id: clientId, code_verifier: verifier, resource: MCP_URL }),
  }, 10000).catch(() => null);
  const tokens = exchanged ? await exchanged.json().catch(() => ({})) : {};
  if (!exchanged?.ok || !tokens.access_token) return finish({ ok: false, message: "Geniffy didn't finish the sign-in. Try again." });

  const scope = tokens.scope || SCOPES;
  writeJson("credentials.json", {
    issuer: meta.issuer, client_id: clientId, access_token: tokens.access_token, refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000, scope, signed_in_at: new Date().toISOString(),
  });
  return finish({
    ok: true, scope,
    message: scope.includes("memory:write")
      ? `Signed in to Geniffy. New chats in ${TOOL_NAME} start with what Geniffy remembers, and what you discuss is saved as you go.`
      : `Signed in to Geniffy, reading only: new chats start with what Geniffy remembers, and nothing is saved.`,
  });
}
