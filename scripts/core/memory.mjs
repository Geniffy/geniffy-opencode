// What a session starts with, and what a finished turn leaves behind: the two things every Geniffy plugin
// does, whatever app it lives in.
import { canSave, credentials, exchange, projectName, setState, tool } from "./lib.mjs";
import { SIGN_IN, TOOL_NAME } from "./tool.mjs";

const words = (item) => (typeof item === "string" ? item : item?.value || item?.text || "").trim();
const when = (m) => String(m.said_at || m.learned_at || "").slice(0, 10);

export const SIGNED_OUT = `The Geniffy memory plugin is installed but not signed in, so nothing is remembered yet. ` +
  `If the user asks about memory, tell them to ${SIGN_IN}.`;

// The note a session starts with: what lasts about the person, what is going on now, and what earlier work on
// this project left behind. Short, because it is read at the start of every session.
// Resolves to { signedIn, total, text }.
export async function recall(cwd) {
  if (!credentials()) return { signedIn: false, total: 0, text: SIGNED_OUT };
  const project = projectName(cwd);
  const [profile, found] = await Promise.allSettled([
    tool("profile", {}, { timeoutMs: 6000 }),
    tool("search", { query: project, limit: 10 }, { timeoutMs: 6000 }),
  ]);
  if ([profile, found].some((r) => r.status === "rejected" && r.reason?.name === "NotSignedIn") && !credentials()) {
    return { signedIn: false, total: 0, text: SIGNED_OUT };
  }

  const lasting = profile.status === "fulfilled" ? (profile.value.lasting || []).map(words).filter(Boolean).slice(0, 8) : [];
  const current = profile.status === "fulfilled" ? (profile.value.current || []).map(words).filter(Boolean).slice(0, 5) : [];
  // Search ranks without judging, so only what belongs to this project is kept: memories saved from its own
  // sessions, or ones that name it.
  const named = new RegExp(`\\b${project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const projectMemories = found.status === "fulfilled"
    ? (found.value.results || []).filter((m) => named.test(m.text || "") || named.test(m.source?.title || "")).slice(0, 6)
    : [];

  const lines = [];
  if (lasting.length) lines.push("What lasts:", ...lasting.map((t) => `- ${t}`));
  if (current.length) lines.push("What is going on now:", ...current.map((t) => `- ${t}`));
  if (projectMemories.length) {
    lines.push(`From earlier work on ${project}:`, ...projectMemories.map((m) => `- ${m.text}${when(m) ? `  (${when(m)})` : ""}`));
  }
  const total = lasting.length + current.length + projectMemories.length;
  const intro = "You have this user's Geniffy memory: what they told AI tools before, each memory from a real source. " +
    "Use it when it helps and don't recite it. When it doesn't cover something, say so instead of guessing. " +
    "The Geniffy memory tools can search for more.";
  return {
    signedIn: true, total,
    text: total ? `${intro}\n\n${lines.join("\n")}`.slice(0, 2400)
      : `This user's Geniffy memory is connected, and holds nothing yet about them or ${project}. It learns from this session.`,
  };
}

// Saves one finished turn, who said what kept, secrets and code left out. Geniffy learns the facts in it;
// nothing here waits for that. Resolves to true when something was saved.
export async function save(prompts, reply, cwd) {
  if (!canSave()) return false;
  const messages = exchange(prompts || [], reply);
  if (!messages) return false;
  const project = projectName(cwd);
  try {
    await tool("remember", { messages, title: `${TOOL_NAME}: ${project}` }, { timeoutMs: 20000 });
    setState({ last_saved_at: new Date().toISOString(), last_saved_project: project, last_error: null });
    return true;
  } catch (err) {
    setState({ last_error: `${new Date().toISOString()} ${err.message}` });
    return false;
  }
}
