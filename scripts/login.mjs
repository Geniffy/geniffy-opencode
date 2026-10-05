// Signs this computer in to Geniffy (core/signin.mjs). Run by "geniffy login" in the chat, or by hand:
//   node scripts/login.mjs
import { signIn } from "./core/signin.mjs";

const result = await signIn({ onUrl: (url) => console.log(`Opening your browser to sign in to Geniffy.\nIf it doesn't open, go to:\n${url}\n`) });
console.log(result.message);
process.exit(result.ok ? 0 : 1);
