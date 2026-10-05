// A finished turn is saved by a process of its own, so the app never waits on the network when a turn ends.
// The turn is written to the outbox first, then that process picks it up: whatever happens to it, nothing
// is sent twice, and a turn it never got to is swept away with the rest after two days.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOME, writeJson } from "./lib.mjs";

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "save-worker.mjs");

export function saveLater(prompts, reply, cwd) {
  if (!prompts?.length) return;
  const name = path.join("turns", `out-${Date.now()}-${randomBytes(4).toString("hex")}.json`);
  writeJson(name, { prompts, reply: reply || "", cwd: cwd || "" });
  const child = spawn(process.execPath, [WORKER, path.join(HOME, name)], { detached: true, stdio: "ignore", env: process.env });
  child.on("error", () => {});
  child.unref();
}
