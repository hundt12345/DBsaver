# DBsaver

Einfache Homepage für den Tagesbestpreis einer einfachen Zugfahrt: Start, Ziel und Reisetag wählen – DBsaver zeigt die günstigsten gefundenen Verbindungen für **eine erwachsene Person in der 2. Klasse**.

Die Haltestellensuche umfasst **alle** Haltestellen der DB-Haltestellendatenbank – Fernverkehrs- und Regionalbahnhöfe, S-Bahn, U-Bahn, Tram und Bus – und ergänzt sie um die Live-Treffer der DB-Suche.

> **Stand 09.10.2026:** Auf dem Render-Deployment blockt der Bot-Schutz der DB die Live-Anfragen an beide Upstreams (HTTP 452 bzw. 403), trotz TLS-1.2-Workaround und curl-Fallback. Die Haltestellensuche läuft über den Offline-Index weiter. Details unter „Datenquellen und Suchlogik“.

## Lokal starten

Voraussetzung: Node.js 22.11 bis 24.x.

```sh
npm install
npm start
```

Danach `http://localhost:3000` öffnen. Für die Entwicklung mit automatischem Neustart gibt es `npm run dev`.

## Datenquellen und Suchlogik

### Haltestellensuche (`GET /api/stations?q=…`)

Zwei Quellen werden parallel abgefragt und zu einer Liste verschmolzen:

1. **Live-Suche der DB** über [`db-vendo-client`](https://github.com/public-transport/db-vendo-client) – zuerst das Profil `db` (DB-Navigator-Backend), danach `dbweb` (bahn.de-Backend).
2. **Offline-Index** aus [`db-hafas-stations`](https://github.com/derhuerst/db-hafas-stations) (~292.000 Haltestellen inkl. Bus/Tram/U-Bahn) als Fallback. Der Index wird beim Start im Hintergrund kompakt aufgebaut (auf dem Render-Deployment am 09.10.2026 rund 25 s, ~100 MB Heap) und liefert auch dann Treffer, wenn die DB die Live-Suche blockiert oder drosselt.

Jeder Treffer wird kategorisiert (`Fernverkehr`, `Regionalverkehr`, `S-Bahn`, `U-Bahn`, `Bus/Tram`, `Haltestelle`) und bei Bedarf um die DB-Bahnhofsnummer ergänzt, damit auch eine Bushaltestelle einen Preis erhalten kann. Umlaut-lose Eingaben (`koeln`, `muenchen`) und Kürzel (`Hbf` ↔ `Hauptbahnhof`) werden aufgelöst. Fällt die Live-Suche aus, liefert die API `fallback: true` und die Oberfläche weist auf die Offline-Liste hin.

### Preisabfrage (`POST /api/search`)

Die Preisabfrage nutzt den bahn.de-Tagesbestpreis-Endpunkt (`angebote/tagesbestpreis`); `bestprice: true` vergleicht die günstigsten Abfahrten über den gewählten Tag. Die feste Traveller-Konfiguration ist eine erwachsene Person (`E`), zweite Klasse, einfache Fahrt.

* **Zwei Upstreams**: `db` (DB-Navigator-API, `app.services-bahn.de`) und `dbweb` (bahn.de-Web-API). Der zweite wird nur versucht, wenn der erste nichts liefert.
* **Transport mit TLS-Profil (kein verlässlicher Workaround)**: Die DB blockiert Server-Anfragen an ihrer Edge (Akamai) per TLS-Fingerprint (`403`/`452 OPS_BLOCKED`). DBsaver setzt deshalb einen eigenen HTTPS-Agent mit **erzwungenem TLS 1.2** (`maxVersion: TLSv1.2`), browserähnlicher Cipher-Reihenfolge, angepasster `supported_groups`-Reihenfolge (Hybrid-Gruppen zuerst) und ALPN auf HTTP/1.1 – gleicher TLS-1.2-Workaround wie bei sparpreis.guru, siehe [db-vendo-client#46](https://github.com/public-transport/db-vendo-client/issues/46). Das lässt den TLS-Handshake durch, die Sperre greift danach aber auf HTTP-Ebene: Auf dem Render-Deployment wurden beide Upstreams am 09.10.2026 trotz TLS 1.2 geblockt. Die Diskussion in db-vendo-client#46 sieht solche Workarounds als fragil an, weil die Sperre auf den TLS-Fingerprint reagiert und sich ändern kann.
* **curl-Fallback**: Antwortet die DB trotzdem mit Bot-Schutz, wird dieselbe Anfrage einmal über `curl` (HTTP/1.1, komprimiert, gleiche Header) wiederholt, sofern `curl` installiert ist. Im Log vom 09.10.2026 blieb dieser Weg ohne Erfolg (0 von 6 Versuchen), und jede geblockte Anfrage geht so doppelt an die DB. Steuerung über `DBSAVER_CURL` (`auto` = Standard, `off`, `force`); auf Render ist `off` die bessere Wahl, solange der Fallback nichts bringt.
* **Cache & Drosselung**: Ergebnisse werden 10 Minuten gecacht, identische parallele Anfragen zusammengeführt und global auf 2 Requests/Sekunde begrenzt. Pro Client-IP sind 30 Suchanfragen/Minute erlaubt.
* **Ehrliche Fehler**: Schlägt alles fehl, antwortet die API mit `503`, dem Grund pro Upstream (z. B. `Bot-Schutz der DB (OPS_BLOCKED)`) und dem Link zur bahn.de-Suche. Es werden keine Beispielpreise erfunden.

### Statusseite (`GET /api/status`)

Zeigt Version, Transport-Statistik, TLS-Gruppen, curl-Verfügbarkeit, Stationsindex und das Ergebnis einer Live-Probefrage pro Upstream. Praktisch, um auf Render zu sehen, ob die DB gerade blockiert. Der Endpunkt ist auf 1 Prüfung pro Minute gecacht.

## Umgebungsvariablen

| Variable | Bedeutung | Standard |
| --- | --- | --- |
| `PORT` | Listen-Port (Render setzt sie selbst) | `3000` |
| `DB_USER_AGENT` | Kontakt-User-Agent für die DB-Anfragen | `DBsaver/1.2 (+https://github.com/hundt12345/DBsaver)` |
| `DBSAVER_CURL` | curl-Fallback: `auto`, `off` oder `force` | `auto` |
| `DBSAVER_PRICE_CACHE_TTL_MS` | Cache-Dauer für Preisergebnisse | `600000` |
| `HTTPS_PROXY` / `HTTP_PROXY` | optionaler Proxy für ausgehende Anfragen (überschreibt den eigenen Agent) | – |

## Rechtliches und Grenzen

Die zugrunde liegenden DB-Endpunkte sind öffentliche, aber nicht als stabile Produkt-API garantierte Schnittstellen. Sie können geändert, gedrosselt oder blockiert werden – genau das passiert seit 2026 über den Bot-Schutz der DB. DBsaver fragt sparsam ab (Cache, Drosselung, Rate-Limit) und weist Preise immer als Momentaufnahme aus. Vor dem Kauf bitte das Angebot auf bahn.de prüfen.

Haltestellendaten: © Deutsche Bahn AG (CC BY 4.0) und © OpenStreetMap-Mitwirkende (ODbL 1.0) über `db-hafas-stations`. Die Alternativen bahn.guru und rome2rio sind keine Option: bahn.guru wurde wegen der abgeschalteten Alt-API archiviert, rome2rio bietet keine passende offene Preis-API.

## Auf Render deployen

`render.yaml` enthält eine Render-Blueprint-Konfiguration für einen Node-Webservice in Frankfurt. In Render **New → Blueprint** wählen und dieses Repository verbinden. Render führt `npm ci`, `npm run check`, `npm test` und `npm start` aus; der Health-Check verwendet `/api/health`. Der Server bindet an `0.0.0.0` und nutzt den von Render gesetzten `PORT`.

**Automatisches Deployment:** Ja. Ist der Render-Service mit diesem GitHub-Repository verbunden (Blueprint oder „Deploy from Git repository“), deployt Render jeden Push auf den verbundenen Branch automatisch – bei einem Blueprint ist das der Branch, der beim Anlegen gewählt wurde (üblicherweise `main`). Pull Requests und Pushes auf andere Branches lösen kein Deployment aus; ein Merge nach `main` schon. Abschalten geht über `autoDeployTrigger: off` in `render.yaml` oder im Dashboard unter *Settings → Auto-Deploy*. Prüfen lässt sich der Stand danach unter `/api/status`.

Nach dem Deploy eine echte Stations- und Preisabfrage testen: Die Preis- und Live-Haltestellensuche brauchen ausgehende HTTPS-Verbindungen zu den DB-Endpunkten. Render-Webservices können externe APIs aufrufen; ob die Suche dauerhaft funktioniert, hängt davon ab, ob die DB die Render-Ausgangs-IP und das TLS-Profil akzeptiert. `/api/health` prüft nur, ob die App läuft – nicht, ob die DB erreichbar ist. Am 09.10.2026 blockte die DB auf dem Render-Deployment beide Live-Upstreams (Probe-Suche mit HTTP 452 bzw. 403); der curl-Fallback half nicht. Die Haltestellensuche bleibt über den Offline-Index nutzbar. Den aktuellen Stand zeigt `/api/status`.

## Prüfen

```sh
npm run check
npm test
```
