# Herkunft der Einrichtungs-Prompts

Die Prompts in `index.ts` sind eigene deutsche Fassungen. Methodik und Fragenkataloge stammen sinngemäß aus diesen Repos, alle unter MIT-Lizenz:

| Repo | Übernommen für |
|---|---|
| [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) (`product-marketing`, `cold-email`, `prospecting`) | Profil-Abschnitte, B2B-Personas, Regeln für Erstkontakt-Mails |
| [growthenginenowoslawski/coldoutboundskills](https://github.com/growthenginenowoslawski/coldoutboundskills) (`icp-onboarding`, `icp-prompt-builder`, `campaign-copywriting`, `playbook-google-site-search`) | Website zuerst, Fragenreihenfolge, Hart-weich-Test, Feedback-Schleife mit zwei Runden ohne Korrektur, eine Suche pro Titel |
| [explorium-ai/gtm-skills](https://github.com/explorium-ai/gtm-skills) (`decision-makers-map`) | Rollen im Buying Committee |
| [zubair-trabzada/ai-sales-team-claude](https://github.com/zubair-trabzada/ai-sales-team-claude) (`sales-icp`) | Anlässe je Segment, Negativ-ICP |

Die Positionierungsfragen folgen April Dunfords „Obviously Awesome“ (Buch, kein Code).

Bewusst nicht eingebunden: inoffizielle LinkedIn-Zugänge (stickerdaniel/linkedin-mcp-server u. a.). Sie brauchen eine eingeloggte Browser-Sitzung, laufen nicht in Vercel-Funktionen und verstoßen gegen die LinkedIn-Nutzungsbedingungen. Personen kommen stattdessen aus Impressum, Team-Seiten und der öffentlichen Websuche.

Der Abschnitt „Was wir aus früheren Einrichtungen wissen“ fasst eigene Recherchen für Conformis und Chetti (Oktober 2026) zusammen: Multiplikatoren über Verbände, Einstieg über mittelgroße statt Konzern-Häuser, Berufsrecht und Datenschutz als erstes Kaufkriterium in regulierten Branchen, § 7 UWG bei E-Mail, Bitte um Feedback in der Testphase. Die Pflicht, Vorschläge selbst vorzubefüllen statt nach Kundennamen zu verlangen, folgt `icp-onboarding` Schritt 1 und 2 („pre-fill proposed answers“) und `product-marketing` („Auto-draft, dann korrigieren lassen“).
