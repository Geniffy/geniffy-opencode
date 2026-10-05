// "geniffy login", "geniffy status" and the rest, typed in the chat. A hook catches them before the model sees
// them, so they work the same in every app, with or without slash commands of its own.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { call, credentials, discover, fetchWithin, removeFile, setState, state } from "./lib.mjs";
import { signIn } from "./signin.mjs";
import { SIGN_IN, TOOL_NAME } from "./tool.mjs";

const NAMES = ["login", "logout", "status", "pause", "resume", "help"];
const PATTERN = new RegExp(`^\\s*/?geniffy[\\s:_-]+(${NAMES.join("|")})\\s*\\.?\\s*$`, "i");

// The command a prompt is, or null for an ordinary prompt.
export function command(prompt) {
  const m = PATTERN.exec(String(prompt || ""));
  return m ? m[1].toLowerCase() : null;
}

const LOGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "login.mjs");

// `here`: run the sign-in in this process, for an app that keeps its plugins running (OpenCode, whose own
// binary is not Node). Otherwise it gets a process of its own, as a hook's process ends with the hook.
export async function run(name, { here = false } = {}) {
  if (name === "login") {
    // The sign-in waits for the browser for up to five minutes, longer than an app waits for a hook, so it
    // runs on its own and the chat goes on.
    if (here) {
      signIn().catch(() => {});
    } else {
      const child = spawn(process.execPath, [LOGIN], { detached: true, stdio: "ignore", env: process.env });
      child.on("error", () => {});
      child.unref();
    }
    return "Opening your browser to sign in to Geniffy. When the page says Connected, new chats start with what " +
      "Geniffy remembers and what you discuss is saved. (geniffy status shows where it stands.)";
  }
  if (name === "logout") return logout();
  if (name === "status") return status();
  if (name === "pause") {
    setState({ paused: true });
    removeFile("turns");
    return "Saving to Geniffy is paused. Chats still start with what it remembers. geniffy resume turns saving back on.";
  }
  if (name === "resume") {
    setState({ paused: false });
    return "Saving to Geniffy is back on, after every turn.";
  }
  return `Geniffy memory in ${TOOL_NAME}. Type: geniffy login (connect), geniffy status, geniffy pause, ` +
    "geniffy resume, geniffy logout. To see or erase your memory, open https://geniffy.com/app.";
}

async function logout() {
  const creds = credentials();
  if (!creds) return "Not signed in to Geniffy on this computer.";
  try {
    const meta = await discover();
    if (meta.revocation_endpoint) {
      await fetchWithin(meta.revocation_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: creds.refresh_token, token_type_hint: "refresh_token", client_id: creds.client_id }),
      }, 8000);
    }
  } catch {}
  removeFile("credentials.json");
  removeFile("turns");
  return "Signed out of Geniffy on this computer, and nothing more is saved from here. Your memory itself is " +
    "unchanged: to see or erase it, open https://geniffy.com/app.";
}

async function status() {
  const creds = credentials();
  if (!creds) return `Not signed in to Geniffy: ${SIGN_IN}.`;
  let working = true;
  try {
    await call("ping", {}, { timeoutMs: 8000 });
  } catch (err) {
    working = err.name === "NotSignedIn" ? false : null;
  }
  const s = state();
  const canWrite = String(creds.scope || "").includes("memory:write");
  const since = String(creds.signed_in_at || "").slice(0, 10);
  const lines = [
    working === false ? `The sign-in no longer works: ${SIGN_IN} again.`
      : working === null ? `Signed in to Geniffy${since ? ` since ${since}` : ""}, but Geniffy didn't answer just now.`
      : `Signed in to Geniffy${since ? ` since ${since}` : ""}, ${canWrite ? "reading and saving" : "reading only"}.`,
    !canWrite ? "Saving: off (this sign-in allows reading only)."
      : s.paused ? "Saving: paused (geniffy resume turns it back on)." : "Saving: on, after every turn.",
  ];
  if (s.last_saved_at) lines.push(`Last saved: ${s.last_saved_at.replace("T", " ").slice(0, 16)} UTC, from ${s.last_saved_project}.`);
  if (s.last_error) lines.push(`Last problem: ${s.last_error}`);
  return lines.join("\n");
}
