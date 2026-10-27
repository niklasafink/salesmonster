/* How a tenant judges a company as a customer: what kind of organisation it is (with a ceiling), how big (by the tenant's own measure,
   not always "bigger is better"), how close its business is to the offer, and what it has shown. The model picks one option per list
   (lib/company-profile.ts); lib/account-rating.ts turns the picks into points. See specs/lead-priorisierung/bewertung-je-mandant.md. */

export type Opt = { key: string; label: string; hint: string; pts: number };
/* cap null = not rated at all (test entry, competitor, own company) */
export type TypeOpt = { key: string; label: string; hint: string; cap: number | null };
export type Rubric = {
  key: string;
  /* who sells what to whom, for the model */
  brief: string;
  types: TypeOpt[]; sizes: Opt[]; fits: Opt[];
  /* company facts the model may tick, from its knowledge, the web or the notes */
  signals: Opt[];
  /* a registration from a mailbox like vergabe@ shows a team for exactly this work */
  teamBox?: RegExp; teamBoxText?: string;
  /* titles of people who decide or do the work */
  roles?: RegExp;
};

const UNKLAR: TypeOpt = { key: "unklar", label: "Unklar", hint: "Zu wenig bekannt, um die Art der Organisation zu bestimmen", cap: 70 };
const TEST: TypeOpt = { key: "test", label: "Testeintrag", hint: "Nur eindeutige Fälle: Tastaturmuster wie asdf, Namen wie Test, Muster oder Hans Wurst, Wegwerf-Domains, Spam, eigene Mitarbeiter mit +test-Adressen. "
  + "Eine Person mit Freemail-Adresse und ohne oder mit unbekannter Firma ist kein Testeintrag, sondern ein Kleinstbetrieb oder unklar", cap: null };

const VERGABEHERO: Rubric = {
  key: "vergabehero",
  brief: "VergabeHero verkauft eine KI-Plattform für öffentliche Ausschreibungen an Unternehmen, die sich auf Aufträge der öffentlichen Hand bewerben (Bieter). "
    + "Je größer der Bieter, desto wertvoller: Konzerne wie Hochtief oder Siemens sind ideale Partner. Wer selbst ausschreibt (Behörden, Kommunen), ist kein Kunde.",
  types: [
    { key: "bieter", label: "Bieter", hint: "Unternehmen, das sich auf öffentliche Aufträge bewirbt oder bewerben kann (Bau, Planung, IT, Dienstleistung, Lieferung)", cap: 100 },
    { key: "multiplikator", label: "Multiplikator", hint: "Kanzlei für Vergaberecht, Verband, Kammer, Berater für Angebote und Ausschreibungen: erreicht viele Bieter", cap: 65 },
    { key: "sektor", label: "Konzern, der ausschreibt", hint: "Konzern oder Versorger, der vor allem selbst ausschreibt (Deutsche Bahn, Stadtwerke, Netzbetreiber), mit bietenden Töchtern", cap: 60 },
    { key: "forschung", label: "Hochschule, Forschung", hint: "Hochschule, Universität, Forschungsinstitut", cap: 40 },
    { key: "auftraggeber", label: "Öffentlicher Auftraggeber", hint: "Behörde, Kommune, Stadt, Gemeinde, Landkreis, Jobcenter, Bundes- oder Landeseinrichtung, öffentliche Klinik: schreibt selbst aus", cap: 25 },
    { key: "wettbewerber", label: "Wettbewerber", hint: "Anbieter von Ausschreibungssuche oder Angebotssoftware (Vergabepilot, Bidfix, Patterno, Forgent, Vergabe Dashboard, cosinex, DTVP) oder VergabeHero selbst", cap: null },
    TEST, UNKLAR,
  ],
  sizes: [
    { key: "s1", label: "1–9 Mitarbeitende", hint: "Einzelperson, Kleinstbetrieb, auch Freemail ohne erkennbare Firma", pts: 6 },
    { key: "s10", label: "10–49 Mitarbeitende", hint: "", pts: 18 },
    { key: "s50", label: "50–249 Mitarbeitende", hint: "", pts: 34 },
    { key: "s250", label: "250–999 Mitarbeitende", hint: "", pts: 46 },
    { key: "s1000", label: "1.000–9.999 Mitarbeitende", hint: "", pts: 54 },
    { key: "s10000", label: "ab 10.000 Mitarbeitende", hint: "Konzern", pts: 60 },
  ],
  fits: [
    { key: "kern", label: "Branche mit vielen Ausschreibungen", hint: "Bau, Tiefbau, Planung, Ingenieure, Architektur, IT, Software, Facility Management, Reinigung, Sicherheit, Beratung, Schulung", pts: 30 },
    { key: "mittel", label: "Branche mit einigen Ausschreibungen", hint: "Industrie oder Handel mit öffentlichen Kunden: Medizintechnik, Fahrzeuge, Energie, Labor, Möbel, Entsorgung, Logistik", pts: 19 },
    { key: "unklar", label: "Branche unklar", hint: "", pts: 12 },
    { key: "schwach", label: "Branche mit wenigen Ausschreibungen", hint: "Gastronomie, Events, Einzelhandel, Werbeagentur, Privatkunden-Geschäft", pts: 10 },
  ],
  signals: [
    { key: "absage", label: "Notiz: passt nicht", hint: "In den Notizen steht, dass es nicht passt (zu wenige Ausschreibungen, kein Interesse, nur ein Mann, ist Auftraggeber)", pts: -15 },
    { key: "interesse", label: "Notiz: großes Interesse", hint: "In den Notizen steht großes Interesse, Testphase läuft gut oder nächste Schritte sind vereinbart", pts: 10 },
  ],
  teamBox: /(^|[._-])(vergabe|ausschreib\w*|tenders?|bids?|angebote?|kalkulation|submissions?)([._-]|$)/i,
  teamBoxText: "Postfach für Vergabe und Angebote",
  roles: /bid|angebot|vertrieb|sales|kalkulation|vergabe|ausschreibung|gesch[äa]ftsf|inhaber|ceo|owner|managing|leitung|head of/i,
};

const CHETTI: Rubric = {
  key: "chetti",
  brief: "Chetti verkauft Sprach-KI an Zahnarztpraxen, die beim Behandlungsgespräch zuhört und den Karteikarteneintrag schreibt. "
    + "Ideal sind inhabergeführte Praxen mit etwa 2 bis 6 Zahnärzten. Ein MVZ kann gut sein, wenn ihm effiziente, einheitliche Abläufe wichtig sind.",
  types: [
    { key: "praxis", label: "Inhabergeführte Praxis", hint: "Zahnarztpraxis oder Berufsausübungsgemeinschaft, der Inhaber entscheidet selbst", cap: 100 },
    { key: "mvz_effizient", label: "MVZ mit Fokus auf Abläufe", hint: "Zahnärztliches MVZ oder Praxisgruppe, die sichtbar auf effiziente, einheitliche Abläufe setzt: zentrales QM, Digitalisierung, mehrere Standorte mit gleichen Prozessen", cap: 100 },
    { key: "mvz", label: "MVZ-Kette", hint: "MVZ oder Kette mit Zentrale ohne erkennbaren Fokus auf Abläufe, Entscheidung fern der Praxis", cap: 70 },
    { key: "multiplikator", label: "Multiplikator", hint: "Zahnärztekammer, KZV, Fortbildungsanbieter, Study Club, Praxisnetzwerk", cap: 85 },
    { key: "abgabe", label: "Praxis vor Abgabe", hint: "Inhaber kurz vor Ruhestand oder Praxisabgabe", cap: 30 },
    { key: "fremd", label: "Kein Kunde", hint: "Dentallabor, Anbieter von Praxissoftware oder Sprachlösungen, Depot, Hersteller", cap: null },
    TEST, UNKLAR,
  ],
  sizes: [
    { key: "b1", label: "1 Behandler", hint: "Einzelpraxis", pts: 18 },
    { key: "b2", label: "2–3 Behandler", hint: "", pts: 54 },
    { key: "b4", label: "4–6 Behandler", hint: "", pts: 60 },
    { key: "b7", label: "7–15 Behandler", hint: "", pts: 48 },
    { key: "b16", label: "über 15 Behandler", hint: "große Gruppe oder Kette", pts: 42 },
    { key: "bx", label: "Behandlerzahl unklar", hint: "", pts: 30 },
  ],
  fits: [
    { key: "chirurgie", label: "Viel Dokumentation", hint: "Schwerpunkt Implantologie, Oralchirurgie, Parodontologie oder Prothetik: lange Aufklärung, viel GOZ", pts: 30 },
    { key: "allgemein", label: "Allgemeine Zahnheilkunde", hint: "", pts: 22 },
    { key: "kinder", label: "Kinderzahnheilkunde", hint: "", pts: 17 },
    { key: "kfo", label: "Kieferorthopädie", hint: "", pts: 12 },
    { key: "keine", label: "Keine Praxis", hint: "Multiplikator oder keine Behandlung", pts: 18 },
  ],
  signals: [
    { key: "jung", label: "Übernahme oder Gründung in den letzten 5 Jahren", hint: "", pts: 10 },
    { key: "personal", label: "Sucht ZFA oder ZMV", hint: "Stellenanzeige für ZFA, ZMV oder Praxismanagement", pts: 8 },
    { key: "digital", label: "Digital ausgestattet", hint: "DVT, Intraoralscanner, Online-Terminbuchung, digitale Abformung", pts: 6 },
    { key: "region", label: "Rhein-Main, München oder NRW", hint: "", pts: 4 },
  ],
  roles: /inhaber|zahnarzt|zahnärztin|praxismanag|zmv|gesch[äa]ftsf|leitung/i,
};

const CONFORMIS: Rubric = {
  key: "conformis",
  brief: "Conformis verkauft eine KI-Plattform für Gap-Analysen gegen DORA, MaRisk, KWG und AMLR. Ideal sind kleinere Wirtschaftsprüfungsgesellschaften (etwa 1 bis 5 Berufsträger), "
    + "am besten mit Prüfungsmandaten bei Finanzinstituten. Danach kleine Institute mit schlanker Compliance. Big Four und Großbanken haben eigene Freigabewege und Tools.",
  types: [
    { key: "wpg", label: "Wirtschaftsprüfung", hint: "WPG oder Wirtschaftsprüfer-Praxis, auch gemischt mit Steuerberatung", cap: 100 },
    { key: "institut", label: "Finanzinstitut", hint: "Wertpapier-, Zahlungs-, Leasing- oder Factoringinstitut, Privat- oder Auslandsbank, Krypto-Verwahrer", cap: 90 },
    { key: "pruefverband", label: "Prüfungsverband", hint: "Genossenschaftlicher Prüfungsverband, Prüfungsstelle eines Sparkassenverbands", cap: 80 },
    { key: "verband", label: "Verband", hint: "Berufs- oder Branchenverband, Netzwerk: erreicht viele Mitglieder", cap: 75 },
    { key: "beratung", label: "Aufsichtsrechtliche Beratung", hint: "Beratung zu Regulatorik und Compliance für Finanzinstitute", cap: 70 },
    { key: "bigfour", label: "Big Four oder großes Netzwerk", hint: "Deloitte, PwC, EY, KPMG, große Mid-Tier-Netzwerke mit zentraler IT-Freigabe", cap: 35 },
    { key: "grossbank", label: "Großbank", hint: "Großbank oder Konzernbank mit eigener Compliance-Abteilung", cap: 30 },
    { key: "fremd", label: "Kein Kunde", hint: "Anbieter eigener GRC-Software, Bundesverband deutscher Banken und sein Prüfungsverband (Kontakt besteht)", cap: null },
    TEST, UNKLAR,
  ],
  sizes: [
    { key: "wpg_klein", label: "Kleine WPG (1–5 Berufsträger)", hint: "bis etwa 50 Mitarbeitende", pts: 60 },
    { key: "wpg_mittel", label: "Mittlere WPG (6–15 Berufsträger)", hint: "", pts: 42 },
    { key: "wpg_gross", label: "Große WPG (über 15 Berufsträger)", hint: "Mid-Tier oder Netzwerk", pts: 18 },
    { key: "org_klein", label: "Unter 20 Mitarbeitende", hint: "Institut, Verband oder Beratung", pts: 36 },
    { key: "org_mittel", label: "20–500 Mitarbeitende", hint: "Institut, Verband oder Beratung", pts: 48 },
    { key: "org_gross", label: "Über 500 Mitarbeitende", hint: "Institut, Verband oder Beratung", pts: 18 },
    { key: "unklar", label: "Größe unklar", hint: "", pts: 24 },
  ],
  fits: [
    { key: "fs", label: "Prüft oder ist Finanzinstitut", hint: "Prüfungsmandate bei Banken oder Instituten belegt, oder selbst Institut unter WpI-MaRisk, MiCA, DORA oder MaRisk", pts: 30 },
    { key: "aufsicht", label: "Berührt Aufsichtsrecht", hint: "Prüfung oder Beratung mit etwas Bezug zu Finanzinstituten oder GwG", pts: 18 },
    { key: "keine", label: "Kein Bezug zu Finanzinstituten", hint: "", pts: 6 },
  ],
  signals: [
    { key: "leitung", label: "Neue Leitung", hint: "Neuer Prüfungsvorstand, neue Geschäftsführung oder Compliance-Leitung", pts: 10 },
    { key: "fachbeitrag", label: "Vortrag oder Fachbeitrag zu DORA oder MaRisk", hint: "", pts: 8 },
    { key: "stelle", label: "Sucht Bankprüfer", hint: "Stellenanzeige für Prüfung von Finanzinstituten", pts: 8 },
    { key: "region", label: "Rhein-Main", hint: "", pts: 4 },
  ],
  roles: /wirtschaftspr|partner|gesch[äa]ftsf|inhaber|compliance|pr[üu]fungs|vorstand|revision|isb/i,
};

export const RUBRICS: Record<string, Rubric> = { vergabehero: VERGABEHERO, chetti: CHETTI, conformis: CONFORMIS };
/* until a tenant names its rubric in settings, these tenants have one */
const BY_SLUG: Record<string, string> = { vh: "vergabehero", chetti: "chetti", "conformis-grc": "conformis" };

export const rubricOf = (t: { slug: string; settings: { rubric?: string } }): Rubric | null => RUBRICS[t.settings.rubric || BY_SLUG[t.slug] || ""] ?? null;
