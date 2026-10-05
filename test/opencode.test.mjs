// The plugin loaded the way OpenCode loads it (an import, then the exported function called with a client)
// and its hooks driven as OpenCode drives them, against a stand-in Geniffy: the MCP server added to the config,
// the Geniffy commands typed in the chat, signing in, the system prompt opening with what Geniffy remembers,
// each turn saved in the background with secrets and code left out, pausing, and signing out.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startFake } from "./fake-geniffy.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.join(os.tmpdir(), "demo-app");

// The settings are read when the plugin is imported, so the stand-in comes first.
const fake = await startFake();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "geniffy-opencode-"));
Object.assign(process.env, { GENIFFY_API_URL: fake.base, GENIFFY_PLUGIN_HOME: home, GENIFFY_NO_BROWSER: "1", GENIFFY_LOGIN_WAIT_MS: "3000" });
const mod = await import("../index.mjs");
test.after(async () => {
  await fake.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function makeClient() {
  const c = {
    toasts: [], history: [],
    tui: { showToast: async ({ body }) => { c.toasts.push(body.message); return true; } },
    session: { messages: async () => ({ data: c.history }) },
  };
  return c;
}

function login() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "login.mjs")], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", opened = false;
    child.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/https?:\/\/\S+\/oauth\/authorize\S+/);
      if (m && !opened) {
        opened = true;
        fetch(m[0]).catch(() => {});
      }
    });
    child.on("close", (code) => resolve({ code, out }));
  });
}

async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

const said = (text) => ({ message: { role: "user" }, parts: [{ type: "text", text }] });

test("only the plugin function is exported, so OpenCode can load the module", () => {
  for (const [name, value] of Object.entries(mod)) assert.equal(typeof value, "function", name);
});

test("the memory tools join the config, and an existing entry is left alone", async () => {
  const hooks = await mod.GeniffyPlugin({ client: makeClient(), directory: project, worktree: project });
  const config = {};
  await hooks.config(config);
  assert.deepEqual(config.mcp.geniffy, { type: "remote", url: "https://api.geniffy.com/mcp", enabled: true });
  const mine = { mcp: { geniffy: { type: "remote", url: "https://example.test/mcp", headers: { Authorization: "Bearer x" } } } };
  await hooks.config(mine);
  assert.equal(mine.mcp.geniffy.url, "https://example.test/mcp");
});

test("signing in, the opening note, saving each turn, commands, pausing and signing out", async () => {
  const client = makeClient();
  const hooks = await mod.GeniffyPlugin({ client, directory: project, worktree: project });
  const system = async (sessionID) => {
    const output = { system: ["You are OpenCode."] };
    await hooks["experimental.chat.system.transform"]({ sessionID, model: {} }, output);
    return output.system;
  };

  // Signed out: the model is told how to sign in, and a command is answered by the plugin itself.
  assert.match((await system("s0")).at(-1), /not signed in.*type "geniffy login" in OpenCode/s);
  const status = said("geniffy status");
  await hooks["chat.message"]({ sessionID: "s0" }, status);
  assert.match(client.toasts.at(-1), /Not signed in to Geniffy/);
  assert.match(status.parts[0].text, /^\(The Geniffy plugin handled "geniffy status"/, "the model only acknowledges it");

  assert.equal((await login()).code, 0);

  // The note is worked out once per session, and holds this project and nothing from elsewhere.
  const note = (await system("s1")).at(-1);
  assert.match(note, /Prefers pnpm to npm\./);
  assert.match(note, /From earlier work on demo-app:\n- The demo-app API is written in Go\.  \(2026-10-01\)/);
  assert.doesNotMatch(note, /Lunch is at one/);
  assert.equal((await system("s1")).at(-1), note);

  // A turn: the prompt, the reply OpenCode keeps, then the session goes idle and the turn is saved.
  await hooks["chat.message"]({ sessionID: "s1" },
    said("We always deploy on Tuesdays. Use key " + "sk-" + "ant-abcdefghijklmnop1234" + " and password: hunter2hunter2"));
  client.history = [
    { info: { role: "user" }, parts: [{ type: "text", text: "We always deploy on Tuesdays." }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "Noted, Tuesday deploys.\n```js\nconsole.log('deploy')\n```\nDone." }] },
  ];
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.ok(await until(() => fake.s.remembered.length === 1), "saved in the background");
  const saved = fake.s.remembered[0];
  assert.equal(saved.title, "OpenCode: demo-app");
  assert.match(saved.messages[0].content, /\[secret removed\].*password: \[secret removed\]/);
  assert.doesNotMatch(JSON.stringify(saved), /sk-ant-|hunter2/);
  assert.equal(saved.messages[1].content, "Noted, Tuesday deploys.\n[code left out]\nDone.");

  // An idle session with no turn under way saves nothing; neither does a paused one.
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  await hooks["chat.message"]({ sessionID: "s1" }, said("geniffy pause"));
  assert.match(client.toasts.at(-1), /paused/);
  await hooks["chat.message"]({ sessionID: "s1" }, said("Our staging database is in Pune."));
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fake.s.remembered.length, 1);
  await hooks["chat.message"]({ sessionID: "s1" }, said("geniffy resume"));
  await hooks["chat.message"]({ sessionID: "s1" }, said("Our staging database is in Pune."));
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.ok(await until(() => fake.s.remembered.length === 2));

  await hooks["chat.message"]({ sessionID: "s1" }, said("geniffy logout"));
  assert.match(client.toasts.at(-1), /Signed out of Geniffy/);
  assert.ok(!fs.existsSync(path.join(home, "credentials.json")));
});

test("geniffy login signs in from inside OpenCode, whose own binary is not Node", async () => {
  const client = makeClient();
  const hooks = await mod.GeniffyPlugin({ client, directory: project, worktree: project });
  await hooks["chat.message"]({ sessionID: "s9" }, said("geniffy login"));
  assert.match(client.toasts.at(-1), /Opening your browser to sign in to Geniffy/);
  assert.ok(await until(() => [...fake.s.clients.values()].some((c) => c.client_name === "Geniffy for OpenCode")),
    "the sign-in started in this process, named for OpenCode on Geniffy's approval screen");
  await new Promise((r) => setTimeout(r, 3200)); // it gives up waiting for a browser
});
