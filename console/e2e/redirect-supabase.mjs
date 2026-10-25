// Loaded with --import into the browser suite's `next start` only. Sends the
// one fake Supabase host to the local PGlite server; every other request goes
// where it was going. The app's own host check (https, *.supabase.co) still
// runs on the URL it was given.
const target = process.env.E2E_SUPABASE_REDIRECT;
const host = "e2e-console.supabase.co";
if (target === undefined || !/^http:\/\/localhost:\d+$/.test(target)) {
  throw new Error("E2E_SUPABASE_REDIRECT must be http://localhost:<port>");
}
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.hostname !== host) return original(input, init);
  return original(`${target}${url.pathname}${url.search}`, init);
};
