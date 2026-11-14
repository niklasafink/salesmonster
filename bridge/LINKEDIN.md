# LinkedIn-Kampagnen ohne Fremdanbieter

Das Portal plant die Kampagnen und passt auf, dass niemand doppelt angeschrieben wird. Gesendet wird von einem Worker auf deinem Mac,
in einem eigenen Chrome-Profil mit deinem LinkedIn-Login. Gesteuert wird alles über den Claude-Connector (Tools `linkedin_*`).

Automatisierung mit dem eigenen Login verstößt gegen die LinkedIn-Nutzervereinbarung und kann zur Einschränkung des Kontos führen.
Die Standardlimits sind deshalb niedrig gehalten. Erhöhe sie nur schrittweise.

## Einrichten

1. Tabellen anlegen: `npx drizzle-kit push` (legt `li_senders`, `li_campaigns`, `li_enrollments` und `li_actions` an).
2. Absender anlegen und Token holen: `npx tsx scripts/li-sender.ts <deine Portal-E-Mail>`.
3. `~/.salesmonster/linkedin.env` anlegen:

   ```
   LI_API=https://<deine Portal-Domain>
   LI_TOKEN=li_…
   ```

4. Einmal anmelden: `npm run li:login`. Es öffnet sich ein Chrome-Fenster mit einem eigenen Profil (`~/.salesmonster/linkedin-profile`).
5. Probe ohne Klick: `npm run li:probe -- https://www.linkedin.com/in/<jemand>/` zeigt, was der Worker auf dem Profil erkennt
   (vernetzt, Anfrage offen, Vernetzen-Knopf, Nachricht-Knopf).
6. Worker starten: `npm run li:worker` (läuft im Terminal; `--once` erledigt genau eine Aktion). Der Mac muss in der Sendezeit wach sein.

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

## Limits (Standard)

15 Anfragen am Tag, 80 in 7 Tagen, 25 Nachrichten, 40 Profilprüfungen, Montag bis Freitag 9 bis 18 Uhr, 3 bis 8 Minuten Pause zwischen
zwei Aktionen. Ändern über `linkedin_settings`.

Kostenlose Konten dürfen im Monat nur wenige Anfragen mit Notiz senden. Meldet LinkedIn das, warten Kampagnen mit
`noteFallback: pausieren` bis zum Monatsanfang. Kampagnen mit `ohne_notiz` senden die Anfrage dann ohne Notiz.
