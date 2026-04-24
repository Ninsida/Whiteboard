# Whiteboard

Ein vollständiges, reaktionsschnelles Whiteboard für den Browser — statisches HTML/CSS/JS, keine Build-Tools, keine Abhängigkeiten.

## Features

- **Tablet/Stylus** mit Drucksensitivität (Pointer Events API) — funktioniert mit iPad + Apple Pencil, Surface Pen, Wacom, Samsung S-Pen, etc.
- **Mehrere Tabs/Boards** — für verschiedene Personen oder Themen, umbenennbar, duplizierbar
- **Persistenz** — alles wird lokal in IndexedDB gespeichert. Reload verliert nichts.
- **Bilder & Dateien** per Drag & Drop, Einfügen aus Zwischenablage oder per Button. Skalierbar, verschiebbar.
- **Text & Kommentare** — Doppelklick zum Bearbeiten, optional als gelber Kommentar-Sticky.
- **Stift, Marker, Radierer** — Objekt-Eraser (löscht ganze Striche, die er trifft)
- **Pan & Zoom** — Zwei-Finger-Pinch auf Touch, Mausrad zum Zoomen, Leertaste+Ziehen zum Verschieben
- **Undo/Redo** (Strg+Z / Strg+Shift+Z)
- **Export** als PNG oder JSON (inkl. eingebetteter Bilder), **Import** aus JSON
- **Hintergründe**: weiß, Raster, Punkte, Linien
- **Keine Libraries** — reines Vanilla-JS, läuft schnell auch auf Tablets

## Tastenkürzel

| Taste | Aktion |
|---|---|
| `P` | Stift |
| `M` | Marker |
| `E` | Radierer |
| `T` | Text / Kommentar |
| `V` | Auswählen / Verschieben |
| `H` oder `Leertaste halten` | Leinwand verschieben |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+S` | Explizit speichern |
| `Ctrl+T` | Neuer Tab |
| `Entf` | Ausgewähltes Objekt löschen |
| `Doppelklick` mit Text-Tool | Text an Position einfügen |

## Auf GitHub Pages hosten

1. Repo zu GitHub pushen (diese Dateien im Root)
2. Repo-Einstellungen → **Pages** → Source: `Deploy from a branch`, Branch: `main` (oder den Branch deiner Wahl), Folder: `/ (root)`
3. URL abwarten, dann `https://<user>.github.io/<repo>/` öffnen

Die App ist eine komplett statische Seite — keine Server-Logik, keine Build-Schritte.

## Lokal testen

Ein einfacher Static-Server reicht (nicht direkt per `file://` öffnen, weil ES-Module CORS brauchen):

```bash
python3 -m http.server 8000
# oder
npx serve .
```

Dann http://localhost:8000 öffnen.

## Datenspeicherung

Alles wird ausschließlich lokal im Browser gespeichert (IndexedDB, pro Domain). Keine Daten werden versendet. Wenn du den Browser-Speicher löschst oder den Browser wechselst, sind die Boards weg — nutze dann **Export JSON**, um sie mitzunehmen.

## Dateistruktur

```
index.html      # Einstieg + Markup
styles.css      # UI-Styling
js/app.js       # Tabs, Toolbar, Persistenz, Shortcuts
js/board.js     # Zeichnen, Pan/Zoom, Undo, Items
js/storage.js   # IndexedDB-Wrapper
.nojekyll       # GitHub Pages: nicht durch Jekyll schicken
```
