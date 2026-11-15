# LinkedIn-Kampagnen ohne Fremdanbieter

Das Portal plant die Kampagnen und passt auf, dass niemand doppelt angeschrieben wird. Gesendet wird von einem Worker auf deinem Mac.
Der Worker steuert ein echtes (unsichtbares) Chromium über Playwright und ruft die interne Schnittstelle, die auch linkedin.com nutzt (Voyager),
als `fetch` im Seitenkontext auf. Dadurch lässt der Bot-Schutz von Cloudflare die Anfragen durch. Geklickt wird nichts: Der Worker lädt nur den
Feed und schickt `fetch`-Aufrufe, angemeldet mit deinem Sitzungs-Cookie `li_at`. Die Schnittstelle ist nicht dokumentiert; ändert LinkedIn sie,
stehen die Adressen gesammelt in `EP` in `bridge/linkedin.mjs`. Gesteuert wird alles über den Claude-Connector (Tools `linkedin_*`).

Automatisierung mit dem eigenen Login verstößt gegen die LinkedIn-Nutzervereinbarung und kann zur Einschränkung des Kontos führen.
Die Standardlimits sind deshalb niedrig gehalten. Erhöhe sie nur schrittweise.

## Einrichten

1. Playwright-Browser installieren: `npx playwright install chromium` (einmalig; der Worker braucht das Chromium von Playwright).
2. Tabellen anlegen: `npx drizzle-kit push` (legt `li_senders`, `li_campaigns`, `li_enrollments` und `li_actions` an).
3. Absender anlegen und Token holen: `npx tsx scripts/li-sender.ts <deine Portal-E-Mail>`.
4. `~/.salesmonster/linkedin.env` anlegen:

   ```
   LI_API=https://<deine Portal-Domain>
   LI_TOKEN=li_…
   ```

5. Einmal anmelden: `npm run li:login`. Ist der Worker schon angemeldet (Profil, gespeichertes Cookie oder ein Browser auf dem Mac), ist es
   sofort fertig. Sonst öffnet sich ein Browserfenster auf linkedin.com: Dort meldest du dich einmal an (inkl. Code/2FA). Sobald dein Feed
   erscheint, erkennt der Worker die Anmeldung von selbst, schließt das Fenster und merkt sich die Sitzung dauerhaft in seinem Profil
   `~/.salesmonster/linkedin-profile`. Das ist der empfohlene Weg: Die Sitzung lebt dann im Browser des Workers und wird von LinkedIn nicht als
   fremd behandelt. Alternativen ohne Fenster: `npm run li:login -- --paste` (li_at von Hand einfügen), oder der Worker liest li_at aus deinen
   Browsern (Chrome/Safari/eigenes Profil) — dafür fragt macOS einmal nach dem Schlüsselbund („Chrome/Chromium Safe Storage“), „Immer erlauben“.
6. Probe ohne Senden: `npm run li:probe -- https://www.linkedin.com/in/<jemand>/` zeigt, was der Worker liest
   (Mitglieds-ID, Abstand, vernetzt, Anfrage offen, Verlauf). `LI_DEBUG=1` davor zeigt jeden Seiten- und API-Aufruf mit Status.
   Zum Zusehen `LI_HEADFUL=1` setzen, dann öffnet sich das Browserfenster.
7. Worker starten: `npm run li:worker` (läuft im Terminal; `--once` erledigt genau eine Aktion). Der Mac muss in der Sendezeit wach sein.
   Autostart: `npm run li:autostart` richtet einen launchd-Agenten ein, der den Worker bei jeder Anmeldung am Mac startet und nach einem
   Absturz neu startet (Log: `~/.salesmonster/linkedin-worker.log`). `npm run li:autostart -- off` entfernt ihn wieder.

## Anmeldung bleibt erhalten

Der Worker hält die Sitzung im eigenen Chromium-Profil (`~/.salesmonster/linkedin-profile`). Das Cookie `li_at` gilt bei LinkedIn etwa ein Jahr
und überlebt Neustarts. Nach einem Neustart läuft der Worker mit der Sitzung im Profil weiter, ohne dass du etwas tust. Erklärt LinkedIn das
Cookie für ungültig (Abmelden im Browser, Passwortwechsel, „überall abmelden“), holt der Worker alle 5 Minuten das aktuelle `li_at` aus den
Browsern auf dem Mac: Du bleibst nur in einem Browser bei linkedin.com angemeldet, mehr nicht. Solange keine Sitzung da ist, steht der Absender
im Portal auf Pause („LinkedIn-Anmeldung abgelaufen“); sobald der Worker wieder angemeldet ist, hebt er die Pause selbst auf. Eine von Hand
gesetzte Pause bleibt bestehen.

## Bot-Schutz (gelöst am 14.11.2026)

LinkedIn liegt hinter Cloudflare (`__cf_bm`), das Anfragen ohne echten Browser abweist und ein so genutztes `li_at` entwertet. Der Worker fährt
deshalb ein echtes Chromium über Playwright, lädt den Feed und ruft die Voyager-API als `fetch` im Seitenkontext auf — mit den Cookies, der
Cloudflare-Freigabe und dem TLS-Fingerabdruck eines echten Browsers. Geklickt wird nichts. Getestet am 14.11.: Lesen von Profil, eigenem Konto
und offenen Anfragen lief damit sauber durch. Weniger Anfragen in kurzer Zeit sind sicherer; wird zu schnell zu viel gelesen, antwortet LinkedIn
zeitweise mit 401, dann hilft eine Pause.

## Ablauf über Claude

1. `linkedin_campaign_save`: Notiz (leer = Anfrage ohne Notiz) und optional Folgenachrichten mit Abstand in Tagen.
2. `linkedin_enroll` ohne `confirm` zeigt, wer aufgenommen und wer übersprungen wird. Mit `confirm: true` werden die Leads aufgenommen.
3. `linkedin_campaign_status` mit `aktiv` startet die Kampagne.
4. `linkedin_status` und `linkedin_people` zeigen Fortschritt, Antworten und Fehler.

## Schutz gegen doppeltes Anschreiben

- Ein LinkedIn-Profil kommt höchstens einmal in eine Kampagne, über alle Kampagnen und Mandanten hinweg (eindeutiger Index auf dem Profil).
- Übersprungen wird außerdem, wer schon über SendPilot/Sendler lief, per Mail angeschrieben oder geplant ist, geantwortet hat,
  bestehender Kontakt oder registriert ist oder auf der Sperrliste steht.
- Jeder Sendeschritt kann je Person nur einmal vergeben werden. Es läuft immer nur eine Aktion zugleich.
- Kommt keine Rückmeldung, gilt die Aktion als „unklar“. Sie wird nicht wiederholt. Der Worker prüft auf LinkedIn, ob die Anfrage offen
  oder die Nachricht im Verlauf steht, und erst wenn das sicher nicht der Fall ist, kommt der Schritt erneut.
- Vor jeder Folgenachricht liest der Worker den Verlauf. Hat die Person geantwortet, wird nichts gesendet und die Folge endet.
- Vor jeder Anfrage prüft der Worker das Profil: schon vernetzt oder Anfrage schon offen heißt, es wird nichts gesendet.
- Kann der Worker den Verlauf nicht lesen, sendet er keine Folgenachricht.

## Limits (Standard)

15 Anfragen am Tag, 80 in 7 Tagen, 25 Nachrichten, 40 Profilprüfungen, Montag bis Freitag 9 bis 18 Uhr, 3 bis 8 Minuten Pause zwischen
zwei Aktionen. Ändern über `linkedin_settings`.

Kostenlose Konten dürfen im Monat nur wenige Anfragen mit Notiz senden. Meldet LinkedIn das, warten Kampagnen mit
`noteFallback: pausieren` bis zum Monatsanfang. Kampagnen mit `ohne_notiz` senden die Anfrage dann ohne Notiz.
