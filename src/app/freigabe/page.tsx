import { LoginArt } from "@/components/login-art";
import { authParams, authRequest } from "@/lib/oauth";

/* Consent step of the connector login; the session is enforced by the proxy, the form posts to /api/oauth/authorize */
export default async function Freigabe({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const p = authParams(new URLSearchParams(Object.entries(await searchParams).filter((e): e is [string, string] => typeof e[1] === "string")));
  const a = await authRequest(p);
  return (
    <div className="login">
      <LoginArt />
      <main className="lg-side">
        {"fatal" in a ? <div className="lg-form"><h1>Freigabe nicht möglich</h1><div className="warn">{a.fatal}</div></div>
          : <form className="lg-form" method="post" action="/api/oauth/authorize">
            <h1>{a.name} Zugriff auf Sales Monster erlauben</h1>
            {[...p].map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            <button className="btn pri wide lg-go" name="allow" value="1" autoFocus>Erlauben</button>
            <button className="btn sec wide lg-go" name="allow" value="0">Abbrechen</button>
          </form>}
      </main>
    </div>
  );
}
