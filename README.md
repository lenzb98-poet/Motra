# Sutra

Ein persönliches Stimmungstagebuch als Web-App. Du trägst dreimal am Tag deine Stimmung ein (Morgen, Mittag, Abend), siehst den Verlauf als Grafik und kannst ihn neben deine Medikamente legen.

Alle Daten bleiben im Browser auf deinem Gerät (`localStorage`). Es gibt keinen Server, kein Konto und kein Tracking.

## Funktionen

- **Heute:** Stimmung auf einer 5er-Skala von „Sehr schlecht“ bis „Sehr gut“, mit optionaler Notiz. Die Tageszeit wird automatisch vorgewählt. Vergangene Tage lassen sich nachtragen.
- **Deine Woche:** Die letzten 7 Tage als Raster (Tageszeit × Tag). Ein Tipp auf ein Feld öffnet diesen Eintrag.
- **Verlauf:** Durchschnitt, Veränderung zum Zeitraum davor, Grafik mit Einzelwerten, Tagesdurchschnitt und 7-Tage-Schnitt sowie Auswertung nach Tageszeit. Zeiträume: 7 Tage, 30 Tage, 90 Tage, 1 Jahr oder alles.
- **Medikamente:** Name, Dosis und Startdatum erfassen, Dosis ändern, absetzen oder wieder aufnehmen. Darunter siehst du:
  - Stimmung und Einnahme-Zeiträume übereinander auf einer gemeinsamen Zeitachse
  - die Ø Stimmung an Tagen mit und ohne Einnahme
  - für jeden Beginn, jede Dosisänderung und jedes Absetzen: 4 Wochen vorher im Vergleich zu Woche 3 bis 6 danach (viele Medikamente wirken erst nach einigen Wochen)
- **Daten:** Sicherung als JSON herunterladen und wiederherstellen. Export als CSV-Tabelle für den Arzttermin. Beispieldaten zum Ausprobieren.
- **Offline und installierbar:** Die App lässt sich zum Home-Bildschirm hinzufügen (PWA) und funktioniert danach auch ohne Internet.

## Online stellen mit GitHub Pages

1. Auf GitHub im Repository **Settings → Pages** öffnen.
2. Unter „Build and deployment“ als Source **Deploy from a branch** wählen, Branch **main** und Ordner **/ (root)**, dann **Save**.
3. Nach ein bis zwei Minuten ist die App unter `https://lenzb98-poet.github.io/Sutra/` erreichbar.
4. Auf dem iPhone in Safari öffnen, **Teilen → Zum Home-Bildschirm**. Auf Android im Chrome-Menü **App installieren**.

## Lokal starten

Es gibt keinen Build-Schritt. Ein beliebiger statischer Server reicht:

```sh
python3 -m http.server 8000
```

Dann `http://localhost:8000` öffnen.

## Aufbau

| Datei | Inhalt |
|---|---|
| `index.html` | Grundgerüst, Ansichten und Icons |
| `css/styles.css` | Dunkles Design, Farben als CSS-Variablen |
| `js/store.js` | Datenmodell, Speicherung, Auswertungen, Sicherung |
| `js/charts.js` | SVG-Grafiken mit Tooltip und Tastaturbedienung |
| `js/app.js` | Oberfläche und Abläufe |
| `js/util.js` | Datums- und DOM-Hilfen |
| `sw.js` | Service Worker für den Offline-Betrieb |

Nach Änderungen an den Dateien die Versionsnummer `CACHE` in `sw.js` erhöhen, damit installierte Apps die neue Version laden.

## Wichtig

Sutra zeigt, wie Stimmung und Einnahme zeitlich zusammenfallen. Die App zeigt keine Ursachen und ersetzt keine ärztliche Beratung. Ändere Medikamente nur nach Rücksprache mit deiner Ärztin oder deinem Arzt.

Die Schrift *Bricolage Grotesque* steht unter der SIL Open Font License (`fonts/OFL.txt`).
