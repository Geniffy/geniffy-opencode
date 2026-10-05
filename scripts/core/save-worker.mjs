// Saves one turn from the outbox (core/outbox.mjs) and deletes it first, so it can never be sent twice.
import fs from "node:fs";
import { save } from "./memory.mjs";

const file = process.argv[2];
let turn = null;
try {
  turn = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.rmSync(file, { force: true });
} catch {}
if (turn) await save(turn.prompts, turn.reply, turn.cwd);
