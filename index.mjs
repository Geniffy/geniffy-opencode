// Geniffy for OpenCode. Add it to opencode.json ("plugin": ["opencode-geniffy"]) and OpenCode gains:
//   the Geniffy memory tools (the remote MCP server, added to the config unless one named "geniffy" is there);
//   each session's system prompt opening with what Geniffy remembers about the person and this project;
//   each finished turn saved to Geniffy in the background, secrets and code left out;
//   "geniffy login", "geniffy status" and the rest, typed in the chat and answered by the plugin.
// The core (scripts/core) is the same in every Geniffy plugin; this file is OpenCode's adapter.
import { canSave } from "./scripts/core/lib.mjs";
import { command, run } from "./scripts/core/commands.mjs";
import { recall, save } from "./scripts/core/memory.mjs";

// Every export of this module is taken for a plugin, and OpenCode refuses one that is not a function: so
// nothing else here is exported.
const MCP = { type: "remote", url: "https://api.geniffy.com/mcp", enabled: true };

const textOf = (parts) => (parts || []).filter((p) => p?.type === "text" && !p.synthetic).map((p) => p.text || "").join("\n").trim();
const listOf = (res) => (Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []);

export const GeniffyPlugin = async ({ client, directory, worktree }) => {
  const cwd = worktree || directory || process.cwd();
  const notes = new Map(); // sessionID -> the note it opens with, worked out once per session
  const turns = new Map(); // sessionID -> the prompts of the turn under way

  const toast = (message, variant = "info") => client?.tui?.showToast?.({ body: { message, variant } })?.catch?.(() => {});

  return {
    // The memory tools: OpenCode signs in to them itself (opencode mcp auth geniffy).
    config: async (config) => {
      config.mcp = config.mcp || {};
      if (!config.mcp.geniffy) config.mcp.geniffy = { ...MCP };
    },

    "experimental.chat.system.transform": async (input, output) => {
      const id = input?.sessionID;
      if (!id) return;
      if (!notes.has(id)) notes.set(id, recall(cwd).then((r) => r.text, () => ""));
      const note = await notes.get(id);
      if (note) output.system.push(note);
    },

    "chat.message": async (input, output) => {
      const id = input?.sessionID;
      const typed = textOf(output?.parts);
      const name = command(typed);
      if (name) {
        // Answered here: the person sees the answer, and the model is told only to acknowledge it.
        const answer = await run(name, { here: true });
        toast(answer);
        for (const part of output.parts || []) {
          if (part?.type === "text") part.text = "";
        }
        const first = (output.parts || []).find((p) => p?.type === "text");
        const line = `(The Geniffy plugin handled "geniffy ${name}" and showed the person this: ${answer}) ` +
          "Reply with that in one short sentence, and do nothing else.";
        if (first) first.text = line;
        return;
      }
      if (id && typed && canSave()) {
        const turn = turns.get(id) || { prompts: [] };
        turn.prompts.push(typed);
        turns.set(id, turn);
      }
    },

    event: async ({ event }) => {
      if (event?.type !== "session.idle") return;
      const id = event.properties?.sessionID;
      const turn = id && turns.get(id);
      if (!turn) return;
      turns.delete(id);
      let reply = "";
      try {
        const messages = listOf(await client.session.messages({ path: { id } }));
        const last = [...messages].reverse().find((m) => m?.info?.role === "assistant");
        reply = textOf(last?.parts);
      } catch {}
      // Saved here, without holding OpenCode up: the plugin lives as long as OpenCode does.
      save(turn.prompts, reply, cwd).catch(() => {});
    },
  };
};

export default GeniffyPlugin;
