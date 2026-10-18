"use client";
import type { EnrichField } from "@/db/schema";
import { ENRICH } from "./lead-dialog";
import { Icon, useDialog } from "./ui";

type Filled = Partial<Record<"salutation" | "first" | "last" | "role" | "email" | "phone" | "linkedin" | "website" | "city", string>>;
/* one searched lead as the enrich route returns it, with the name the list shows */
export type EnrichDone = { id: number; name: string; found: Filled; missed: EnrichField[]; error?: string };

const label = (f: EnrichField) => ENRICH.find(([k]) => k === f)?.[1] ?? f;
const valueOf = (found: Filled, f: EnrichField) => f === "person" ? [found.salutation, found.first, found.last].filter(Boolean).join(" ") : found[f];

/* What a run found for whom and what it did not; leads skipped because an earlier search came back empty are counted.
   With live set the run is still going: the title counts along and the latest lead comes first */
export function EnrichReport({ done, skipped, stopped, live, onOpen, onClose }: { done: EnrichDone[]; skipped: number; stopped: boolean; live?: { done: number; total: number }; onOpen: (id: number) => void; onClose: () => void }) {
  const ref = useDialog(onClose);
  const hit = done.filter(d => Object.keys(d.found).length).length, err = done.filter(d => d.error).length;
  return <div className="ov" onClick={e => e.target === e.currentTarget && onClose()}><div className="dlg imp" ref={ref} role="dialog" aria-modal="true" aria-label="Anreicherung">
    <div className="dlg-h">{live ? <span>Anreicherung läuft <span className="num f3">{live.done}/{live.total}</span></span> : stopped ? "Anreicherung gestoppt" : "Anreicherung abgeschlossen"}<button className="btn gh ic" onClick={onClose} aria-label="Schließen"><Icon n="x" /></button></div>
    <div className="enr-sum num">
      <span><b>{hit}</b> ergänzt</span>
      <span><b>{done.length - hit - err}</b> ohne Treffer</span>
      {err > 0 && <span className="bad"><b>{err}</b> Fehler</span>}
      {skipped > 0 && <span title="Bei einer früheren Suche ohne Treffer, diesmal nicht erneut geprüft"><b>{skipped}</b> übersprungen</span>}
    </div>
    {live && !done.length && <div className="f3">Noch kein Lead fertig</div>}
    <ul className="enr-rep">{(live ? [...done].reverse() : done).map(d => {
      const got = ENRICH.map(([k]) => k).filter(f => valueOf(d.found, f));
      return <li key={d.id}>
        <button className="lnk" onClick={() => onOpen(d.id)}>{d.name}</button>
        {d.error ? <div className="bad">{d.error}</div> : <>
          {got.map(f => <div key={f} className="hit"><Icon n="check" /><span className="f3">{label(f)}</span><span className="v">{valueOf(d.found, f)}</span></div>)}
          {d.missed.length > 0 && <div className="miss"><Icon n="x" /><span>Nicht gefunden: {d.missed.map(label).join(", ")}</span></div>}
          {!got.length && !d.missed.length && <div className="f3">Schon vollständig</div>}
        </>}
      </li>;
    })}</ul>
  </div></div>;
}
