# Motra

Ein persönliches Stimmungstagebuch als Web-App. Du trägst dreimal am Tag deine Stimmung ein (Morgen, Mittag, Abend), siehst den Verlauf als Grafik und kannst ihn neben deine Medikamente legen.

Die Daten liegen zuerst im Browser auf deinem Gerät (`localStorage`). Optional lassen sie sich über einen eigenen Cloudflare Worker zwischen deinen Geräten abgleichen, mit Login, Zwei-Faktor-Code und verschlüsselter Speicherung. Es gibt kein Tracking.

## Funktionen

Motra hat vier Reiter mit je einer Aufgabe: **Heute** zum Eintragen, **Verlauf** zum Verstehen, **Therapien** und **Alltag** zum Verwalten. Details öffnen sich in einem Fenster, wenn du etwas antippst.

- **Heute**
  - Stimmung auf einer Skala von −10 bis +10 (0 = okay) für Morgen, Mittag oder Abend; die fünf Gesichter stehen für −10, −5, 0, +5 und +10. Vergangene Tage über das Datum nachtragen. Gesicht gedrückt halten und zur Seite ziehen öffnet den Feinregler für Werte in halben Schritten dazwischen, z. B. +2,5 oder +3. (Intern werden die Werte weiter als 1 bis 5 gespeichert, damit Sicherungen und Sync unverändert funktionieren.)
  - Speichern geht mit zwei Tipps: Der erste fragt „Aktivitäten?“ und öffnet „Was war heute?“, damit du sie nicht vergisst; der zweite speichert.
  - Unter den Gesichtern zwei Reiter: **„Was war heute?“** (standardmäßig offen) und **„Notiz“** (ohne dass die Tastatur von selbst aufgeht). In „Was war heute?“ setzt du Aktivitäten mit einem Tipp oder nimmst sie weg, neue mit „＋ Neu“. Laufende Zeitspannen und Krankheiten stehen darüber, ein Tipp zeigt Details und beendet sie. Ein Zähler am Reiter zeigt, wie viel für den Tag eingetragen ist.
  - „Deine Woche“: die letzten 7 Tage als Farbraster.
- **Verlauf**
  - Eine Ansicht (7 T, 30 T, 90 T, 1 J, Alle) für alles. Kennzahlen: Durchschnitt, Veränderung, Anzahl Einträge.
  - Eine Grafik: Stimmungskurve, darunter die Zeitleiste und ein Farbstreifen für Morgen, Mittag und Abend. Über drei Schalter lassen sich Medikamente, Therapien (jeweils mit Dosis bzw. Häufigkeit unter dem Balken) und Aktivitäten einzeln als beschriftete Zeilen einblenden; sie stehen direkt unter der Zeitleiste, senkrechte Linien markieren Beginn, Änderung und Ende, der Farbstreifen rückt dann ans Ende. Krankheitstage liegen rot gestreift im Hintergrund. Finger auf einem Balken zeigt nur dieses Medikament bzw. diese Aktivität; die anderen treten in den Hintergrund.
  - „Was auffällt“: Medikamente und Aktivitäten mit dem größten Unterschied der Stimmung an Tagen mit und ohne.
  - Durchschnitt nach Tageszeit und alle Stimmungen als Liste.
- **Therapien**
  - Medikamente mit Dosis und Therapien mit Häufigkeit (Therapien auch im Voraus geplant). Ein Tipp öffnet die Details: Dosis ändern, absetzen oder wieder aufnehmen, Stimmung mit und ohne, jede Veränderung im Vergleich 4 Wochen vorher zu Woche 3 bis 6 danach, Bearbeiten und Archivieren.
- **Alltag**
  - Was gerade läuft, alle Aktivitäten mit Details (Stimmung mit und ohne, bei Zeitspannen die 4 Wochen davor, währenddessen und die 4 Wochen danach, alle Einträge, für einen Tag nachtragen, nach einer beendeten Zeitspanne eine neue starten, archivieren) und „Zeitspanne anlegen“ für Urlaub, Kurse und Ähnliches.
  - „Krank“: eine Krankheit eintragen (auch ab heute), die laufende beenden, frühere ansehen und nachtragen. Solange du krank bist, steht sie auch auf „Heute“ bei den laufenden Einträgen.
- **Archiv:** Medikamente, Therapien und Aktivitäten lassen sich archivieren statt löschen. Sie verschwinden aus den Listen, aus der Grafik im Verlauf und aus „Was auffällt“. Die Daten bleiben erhalten; wiederhergestellt ist alles wieder da.
- **Daten:** Sicherung als JSON herunterladen und wiederherstellen, CSV-Tabelle für den Arzttermin, Beispieldaten zum Ausprobieren.
- **Synchronisierung (optional):** In den Einstellungen mit E-Mail, Passwort und Code aus einer Authenticator-App anmelden. Danach gleicht Motra beim Öffnen, nach jedem Speichern und alle zwei Minuten ab.
- **Erinnerungen:** Mitteilungen zu frei wählbaren Zeiten für Morgen, Mittag und Abend, auch wenn die App geschlossen ist. Ist eine Tageszeit schon eingetragen, entfällt die Erinnerung. Auf iPhone/iPad muss Motra auf dem Home-Bildschirm liegen.
- **Offline und installierbar:** Die App lässt sich zum Home-Bildschirm hinzufügen (PWA) und funktioniert danach auch ohne Internet.

Der Stand vor dem Umbau liegt im Branch `checkpoint-1`.

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
