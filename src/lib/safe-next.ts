/* ?next= target after login: only paths on this origin. Resolving through URL catches tricks like /%09/evil.example,
   which the browser would otherwise turn into //evil.example */
export function safeNext(search: string, origin: string) {
  const n = new URLSearchParams(search).get("next");
  if (!n) return "/";
  try {
    const u = new URL(n, origin);
    return u.origin === origin ? u.pathname + u.search + u.hash : "/";
  } catch { return "/"; }
}
