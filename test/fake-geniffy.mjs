// A stand-in for Geniffy's sign-in and MCP server, strict where the real one is: PKCE checked, codes used once,
// refresh tokens rotated, and a refresh token used twice ends the whole sign-in.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

const id = (p) => `${p}${randomBytes(12).toString("hex")}`;

export async function startFake({ accessTtl = 3600, scope = "memory:read memory:write" } = {}) {
  const s = {
    clients: new Map(), codes: new Map(), access: new Map(), refresh: new Map(),
    refreshCalls: 0, revoked: [], remembered: [], ended: false, deny: false, scope, accessTtl,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    let raw = "";
    for await (const c of req) raw += c;
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(obj));
    };
    const form = () => Object.fromEntries(new URLSearchParams(raw));
    const issue = (family) => {
      const at = id("gnf_at_"), rt = id("gnf_rt_");
      s.access.set(at, { exp: Date.now() + s.accessTtl * 1000, family });
      s.refresh.set(rt, { family, used: false });
      return { access_token: at, refresh_token: rt, token_type: "Bearer", expires_in: s.accessTtl, scope: s.scope };
    };

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, { issuer: base, authorization_endpoint: `${base}/oauth/authorize`,
                         token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`,
                         revocation_endpoint: `${base}/oauth/revoke`, code_challenge_methods_supported: ["S256"] });
    }
    if (url.pathname === "/oauth/register" && req.method === "POST") {
      const body = JSON.parse(raw);
      const clientId = id("gnfc_");
      s.clients.set(clientId, body);
      return json(201, { client_id: clientId, ...body });
    }
    if (url.pathname === "/oauth/authorize") {
      const q = url.searchParams;
      const client = s.clients.get(q.get("client_id"));
      if (!client || !client.redirect_uris.includes(q.get("redirect_uri")) || q.get("code_challenge_method") !== "S256") {
        return json(400, { error: "invalid_request" });
      }
      const back = new URL(q.get("redirect_uri"));
      back.searchParams.set("state", q.get("state"));
      back.searchParams.set("iss", base);
      if (s.deny) {
        back.searchParams.set("error", "access_denied");
      } else {
        const code = id("code_");
        s.codes.set(code, { client: q.get("client_id"), redirect: q.get("redirect_uri"), challenge: q.get("code_challenge") });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { Location: back.toString() }).end();
      return;
    }
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      const f = form();
      if (f.grant_type === "authorization_code") {
        const c = s.codes.get(f.code);
        s.codes.delete(f.code);
        const verified = c && createHash("sha256").update(f.code_verifier || "").digest("base64url") === c.challenge;
        if (!verified || c.redirect !== f.redirect_uri || c.client !== f.client_id) return json(400, { error: "invalid_grant" });
        return json(200, issue(id("family_")));
      }
      if (f.grant_type === "refresh_token") {
        s.refreshCalls += 1;
        const r = s.refresh.get(f.refresh_token);
        if (!r || s.ended) return json(400, { error: "invalid_grant" });
        if (r.used) {
          s.ended = true; // reuse: the whole sign-in ends, as Geniffy's does
          return json(400, { error: "invalid_grant" });
        }
        r.used = true;
        return json(200, issue(r.family));
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/oauth/revoke" && req.method === "POST") {
      s.revoked.push(form());
      return json(200, {});
    }
    if (url.pathname === "/mcp" && req.method === "POST") {
      const token = (req.headers.authorization || "").replace(/^Bearer /, "");
      const a = s.access.get(token);
      if (!a || a.exp < Date.now() || s.ended) {
        return json(401, { error: "invalid_token" }, { "WWW-Authenticate": 'Bearer error="invalid_token"' });
      }
      const { id: rid, method, params } = JSON.parse(raw);
      const ok = (result) => json(200, { jsonrpc: "2.0", id: rid, result });
      const toolResult = (data) => ok({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false });
      if (method === "ping") return ok({});
      if (method === "tools/call") {
        const { name, arguments: args } = params;
        if (name === "profile") {
          return toolResult({ subject: null, lasting: [{ topic: "tools", value: "Prefers pnpm to npm." }],
                              current: [{ topic: "work", value: "Shipping the Claude Code plugin." }], memories: 12 });
        }
        if (name === "search") {
          return toolResult({ results: [
            { id: "memory:1", title: "x", url: "u", text: "The demo-app API is written in Go.", said_at: "2026-10-01T09:00:00Z",
              source: { title: "Claude Code: demo-app" } },
            { id: "memory:2", title: "y", url: "u", text: "Lunch is at one.", said_at: "2026-09-30T09:00:00Z",
              source: { title: "Call with Priya" } },
          ] });
        }
        if (name === "remember") {
          if (!s.scope.includes("memory:write")) return json(200, { jsonrpc: "2.0", id: rid, error: { code: -32602, message: "Unknown tool" } });
          s.remembered.push(args);
          return toolResult({ source: { id: "source:abc", title: args.title }, message: "Saved." });
        }
      }
      return json(200, { jsonrpc: "2.0", id: rid, error: { code: -32601, message: "Method not found" } });
    }
    json(404, { error: "not_found" });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, s, close: () => new Promise((ok) => server.close(ok)) };
}
