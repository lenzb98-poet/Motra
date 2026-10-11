# Motra

Ein persönliches Stimmungstagebuch als Web-App. Du trägst dreimal am Tag deine Stimmung ein (Morgen, Mittag, Abend), siehst den Verlauf als Grafik und kannst ihn neben deine Medikamente legen.

Die Daten liegen zuerst im Browser auf deinem Gerät (`localStorage`). Optional lassen sie sich über einen eigenen Cloudflare Worker zwischen deinen Geräten abgleichen, mit Login, Zwei-Faktor-Code und verschlüsselter Speicherung. Es gibt kein Tracking.

## Funktionen

- **Heute:** Stimmung auf einer 5er-Skala von „Sehr schlecht“ bis „Sehr gut“, mit optionaler Notiz. Die Tageszeit wird automatisch vorgewählt. Vergangene Tage lassen sich nachtragen.
- **Feinregler:** Gesicht gedrückt halten und zur Seite ziehen: Unter den Gesichtern erscheint ein Regler für Zwischenwerte wie 3,6. Einfaches Tippen wählt weiter ganze Werte.
- **Deine Woche:** Die letzten 7 Tage als Raster (Tageszeit × Tag). Ein Tipp auf ein Feld öffnet diesen Eintrag.
- **Verlauf:** Durchschnitt, Veränderung zum Zeitraum davor, Grafik mit Einzelwerten, Tagesdurchschnitt und 7-Tage-Schnitt sowie Auswertung nach Tageszeit. Zeiträume: 7 Tage, 30 Tage, 90 Tage, 1 Jahr oder alles.
- **Auf einen Blick:** Unter der Verlaufsgrafik zeigt ein Farbraster für jeden Zeitraum Morgen, Mittag und Abend übereinander, eine Spalte pro Tag. Bei 7 und 30 Tagen sind es einzelne Felder, bei 90 Tagen, 1 Jahr und „Alle“ gehen sie zu einer durchgehenden Farbfläche ineinander über. Ein Tipp (oder Darüberfahren mit dem Finger) zeigt die Werte des Tages und führt auf Wunsch zum Eintrag.
- **Medikamente & Therapien:** Medikamente mit Dosis oder Therapien mit Häufigkeit/Art erfassen (Therapien auch im Voraus: geplanter Beginn, geplante Änderung oder geplantes Ende), ändern, absetzen bzw. beenden oder wieder aufnehmen. Oben wählst du, ob du alles, nur Medikamente oder nur Therapien sehen willst; die Liste lässt sich zuklappen. Darunter siehst du:
  - Stimmung und Einnahme-Zeiträume übereinander auf einer gemeinsamen Zeitachse
  - die Ø Stimmung an Tagen mit und ohne Einnahme
  - für jeden Beginn, jede Dosisänderung und jedes Absetzen: 4 Wochen vorher im Vergleich zu Woche 3 bis 6 danach (viele Medikamente wirken erst nach einigen Wochen)
- **Anderes:** Separat neben dem Filter: Dinge eintragen, die du gemacht oder erlebt hast, entweder an einem Tag (z. B. Morgenroutine, ein gutes Gespräch) oder als Zeitraum wie bei Medikamenten (z. B. Urlaub, ein Yogakurs; ohne Ende läuft er weiter, bis du ihn beendest). Schon genutzte Einträge erscheinen als Schnellauswahl. Du siehst sie als Markierungen unter dem Stimmungsverlauf, die Ø Stimmung an Tagen mit und ohne (bei Wiederkehrendem) bzw. die Woche davor und danach (bei einmaligen Momenten) oder die 4 Wochen davor, die Zeit währenddessen und die 4 Wochen danach (bei Zeiträumen) und eine Chronik zum Bearbeiten.
- **Archiv:** Medikamente, Therapien und „Anderes“-Einträge lassen sich archivieren statt löschen. Sie verschwinden aus den Listen und stehen in einem aufklappbaren „Archiv“ darunter, von wo du sie wiederherstellen kannst. Grafik und Auswertung berücksichtigen sie weiterhin, die Geschichte bleibt vollständig. Bei „Anderes“ lässt sich über „Aktivitäten verwalten“ auch eine ganze Aktivität (alle Einträge mit demselben Namen) auf einmal archivieren oder zurückholen.
- **Einträge beim Stimmungseintrag:** Unter den Gesichtern stehen zwei eingeklappte Reiter, „Einträge“ und „Notiz“. „Einträge“ klappt eine Auswahl auf, in der du einzelne Einträge für den gewählten Tag mit einem Tipp setzt (oder wieder wegnimmst) und neue hinzufügst. Ein Zähler am Reiter zeigt, wie viele es für den Tag schon gibt.
- **Daten:** Sicherung als JSON herunterladen und wiederherstellen. Export als CSV-Tabelle für den Arzttermin. Beispieldaten zum Ausprobieren.
- **Synchronisierung (optional):** In den Einstellungen mit E-Mail, Passwort und Code aus einer Authenticator-App anmelden. Danach gleicht Motra beim Öffnen, nach jedem Speichern und alle zwei Minuten ab.
- **Erinnerungen:** Echte Mitteilungen zu frei wählbaren Zeiten für Morgen, Mittag und Abend, auch wenn die App geschlossen ist. Ist eine Tageszeit schon eingetragen, entfällt die Erinnerung. Kein Konto nötig; auf iPhone/iPad muss Motra auf dem Home-Bildschirm liegen.
- **Offline und installierbar:** Die App lässt sich zum Home-Bildschirm hinzufügen (PWA) und funktioniert danach auch ohne Internet.

## Online stellen mit GitHub Pages

1. Auf GitHub im Repository **Settings → Pages** öffnen.
2. Unter „Build and deployment“ als Source **Deploy from a branch** wählen, Branch **main** und Ordner **/ (root)**, dann **Save**.
3. Nach ein bis zwei Minuten ist die App unter `https://lenzb98-poet.github.io/Sutra/` erreichbar.
4. Auf dem iPhone in Safari öffnen, **Teilen → Zum Home-Bildschirm**. Auf Android im Chrome-Menü **App installieren**.

## Synchronisierung auf Cloudflare einrichten

Der Worker `motra` liefert die App aus und stellt unter `/api/` den Sync-Server bereit (`worker/index.js`, Konfiguration in `wrangler.jsonc`, Datenbank D1 `motra`). Er wird bei jedem Push auf `main` automatisch veröffentlicht.

Einmalig im Cloudflare-Dashboard unter **Workers & Pages → motra → Settings → Variables and Secrets** drei Einträge vom Typ **Secret** anlegen:

| Name | Wert |
|---|---|
| `ALLOWED_EMAILS` | E-Mail-Adressen, die sich anmelden dürfen, mit Komma getrennt |
| `DATA_KEY` | 32 zufällige Bytes als Base64, verschlüsselt die Daten auf dem Server. Nicht mehr ändern, sonst sind gespeicherte Daten unlesbar. |
| `SETUP_CODE` | ein Code deiner Wahl, wird nur beim allerersten Passwort gebraucht |

Danach in Motra: Einstellungen → **Synchronisierung einrichten** → E-Mail → Passwort festlegen → Authenticator-App hinzufügen → Wiederherstellungscodes sichern.

**Zugang verloren?** Ist die Authenticator-App weg und kein Wiederherstellungscode mehr da, lässt sich das Konto im Cloudflare-Dashboard zurücksetzen (D1 → motra → Console): `DELETE FROM users; DELETE FROM sessions;`. Danach richtest du Passwort und Zwei-Faktor neu ein, die gespeicherten Daten bleiben erhalten.

## Erinnerungen

Der Worker verschickt Mitteilungen per Web Push (`worker/push.js`). Ein Cron-Trigger (`wrangler.jsonc`, jede Minute) prüft, welche Erinnerungen fällig sind. Die dafür nötigen VAPID-Schlüssel erzeugt der Worker beim ersten Aufruf selbst und speichert sie in D1 (Tabelle `config`). Es sind keine weiteren Einstellungen nötig. Gespeichert werden pro Gerät nur die Push-Adresse, die Uhrzeiten, die Zeitzone und welche Tageszeiten heute schon erledigt sind, keine Stimmungen oder Notizen.

## Lokal starten

Es gibt keinen Build-Schritt. Ein beliebiger statischer Server reicht:

```sh
python3 -m http.server 8000
```

Dann `http://localhost:8000` öffnen. Mit Sync-Server: eine Datei `.dev.vars` mit den drei Werten oben anlegen und `npx wrangler dev` starten.

## Aufbau

| Datei | Inhalt |
|---|---|
| `index.html` | Grundgerüst, Ansichten und Icons |
| `css/styles.css` | Dunkles Design, Farben als CSS-Variablen |
| `js/store.js` | Datenmodell, Speicherung, Auswertungen, Sicherung |
| `js/charts.js` | SVG-Grafiken mit Tooltip und Tastaturbedienung |
| `js/app.js` | Oberfläche und Abläufe |
| `js/util.js` | Datums- und DOM-Hilfen |
| `js/sync.js` | Abgleich mit dem Server |
| `worker/index.js` | Sync-Server: Login, Zwei-Faktor, verschlüsselte Ablage |
| `worker/push.js` | Erinnerungen: Web Push, Zeitplan |
| `js/push.js` | Erinnerungen auf dem Gerät einrichten |
| `sw.js` | Service Worker für den Offline-Betrieb |

Nach Änderungen an den Dateien die Versionsnummer `CACHE` in `sw.js` erhöhen, damit installierte Apps die neue Version laden.

## Wichtig

Motra zeigt, wie Stimmung und Einnahme zeitlich zusammenfallen. Die App zeigt keine Ursachen und ersetzt keine ärztliche Beratung. Ändere Medikamente nur nach Rücksprache mit deiner Ärztin oder deinem Arzt.

Die Schrift *Bricolage Grotesque* steht unter der SIL Open Font License (`fonts/OFL.txt`).
