// What never leaves the computer: every kind of secret a developer pastes, by shape, and what a turn becomes.
import assert from "node:assert/strict";
import test from "node:test";
import { exchange, scrub } from "../scripts/core/lib.mjs";

// Every sample is assembled at run time, so no secret scanner (ours or GitHub's) sees a key-shaped string here.
const k = (...parts) => parts.join("");

const SECRETS = [
  k("gnf_", "live_", "a".repeat(43)),
  k("gnf_", "rt_", "b".repeat(24)),
  k("sk-", "ant-api03-", "c".repeat(30)),
  k("sk-", "proj-", "d".repeat(40)),
  k("AK", "IA", "E".repeat(16)),
  k("eyJ", "a".repeat(20), ".eyJ", "b".repeat(20), ".", "c".repeat(20)),
  k("AI", "za", "f".repeat(35)),
  k("gh", "p_", "g".repeat(36)),
  k("github_", "pat_", "h".repeat(40)),
  k("gl", "pat-", "i".repeat(20)),
  k("np", "m_", "j".repeat(36)),
  k("py", "pi-", "k".repeat(60)),
  k("xo", "xb-", "1234567890-abcdefghij"),
  k("sk", "_live_", "l".repeat(24)),
  k("rzp", "_live_", "m".repeat(14)),
];

test("keys and tokens of every common shape are removed", () => {
  for (const secret of SECRETS) {
    const out = scrub(`before ${secret} after`);
    assert.equal(out, "before [secret removed] after", secret.slice(0, 6));
  }
});

test("labelled passwords, connection strings and private keys are removed, and their labels kept", () => {
  assert.equal(scrub(k("pass", 'word = "correct-horse-battery"')), 'password = "[secret removed]"');
  assert.equal(scrub(k("API_", "KEY: abcdef123456")), "API_KEY: [secret removed]");
  assert.equal(scrub(k("client_", "secret=s3cr3tvalue")), "client_secret=[secret removed]");
  assert.equal(scrub(`Token: ${SECRETS[7]}`), "Token: [secret removed]", "a known key after a label is removed once");
  assert.equal(scrub(k("api_", `key="${SECRETS[3]}"`)), 'api_key="[secret removed]"');
  assert.equal(scrub(k("postgres://app:", "hunter22@db.example.com:5432/prod")),
               "postgres://app:[secret removed]@db.example.com:5432/prod");
  const begin = (kind) => k("-----BEGIN ", kind, " PRI", "VATE KEY-----");
  const end = (kind) => k("-----END ", kind, " PRI", "VATE KEY-----");
  assert.equal(scrub(`${begin("RSA")}\nMIIEow\n${end("RSA")}`), "[secret removed]");
  assert.equal(scrub(`${begin("OPENSSH")}\ncut off mid-paste`), "[secret removed]");
});

test("ordinary words are left alone", () => {
  const prose = "Use the token bucket algorithm. Our password policy needs 12 characters. Deploy key rotation is monthly.";
  assert.equal(scrub(prose), prose);
});

test("a turn keeps prose, leaves code out, and is skipped when there is nothing to remember", () => {
  const m = exchange(["We ship on Tuesdays.", "```sql\nselect 1\n```"], "Agreed.\n```js\nx()\n```");
  assert.deepEqual(m, [{ role: "user", content: "We ship on Tuesdays.\n\n[code left out]" },
                       { role: "assistant", content: "Agreed.\n[code left out]" }]);
  assert.equal(exchange(["ok"], "Done."), null);
  assert.equal(exchange(["```\nonly code here\n```"], "Fixed."), null);
  assert.equal(exchange([`My key is ${SECRETS[2]}`], "Thanks."), null, "a prompt that was only a secret says nothing");
  const long = exchange(["x".repeat(9000)], "");
  assert.equal(long[0].content.length, 4000);
  assert.equal(long.length, 1, "no reply, no assistant line");
});
