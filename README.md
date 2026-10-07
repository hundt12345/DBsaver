# DBsaver

Einfache Homepage für den Tagesbestpreis einer einfachen Zugfahrt: Startbahnhof, Zielbahnhof und Reisetag wählen – DBsaver zeigt die günstigsten gefundenen Verbindungen für **eine erwachsene Person in der 2. Klasse**.

## Lokal starten

Voraussetzung: Node.js 20.10 bis 24.x.

```sh
npm install
npm start
```

Danach `http://localhost:3000` öffnen. Für die Entwicklung mit automatischem Neustart gibt es `npm run dev`.

## Datenquelle und Suchlogik

Die Bahnhofssuche und Preisabfrage laufen serverseitig über [`db-vendo-client`](https://github.com/public-transport/db-vendo-client) mit dessen `dbweb`-Profil. Die Preisabfrage nutzt den bahn.de-Tagesbestpreis-Endpunkt (`angebote/tagesbestpreis`); `bestprice: true` vergleicht Abfahrten über den gewählten Tag. Die feste Traveller-Konfiguration ist eine erwachsene Person (`E`), zweite Klasse, einfache Fahrt.

Die zugrunde liegenden bahn.de-/DB-Endpunkte sind öffentliche, aber nicht als stabile Produkt-API garantierte Schnittstellen. Sie können geändert, gedrosselt oder blockiert werden. Wenn die Live-Bahnhofssuche ausfällt, nutzt DBsaver den mitgelieferten `db-hafas-stations`-Index als Fallback; Preisabfragen bleiben immer live und zeigen bei Nichterreichbarkeit ausdrücklich keinen Beispielpreis. Die Bahnhofsdaten stehen unter CC BY 4.0 und ODbL 1.0 (Deutsche Bahn AG und OpenStreetMap-Mitwirkende). Preis und Verfügbarkeit sind eine Momentaufnahme; vor dem Kauf bitte das Angebot auf bahn.de prüfen. Bei einer öffentlichen Bereitstellung sollten zusätzlich Nutzungsbedingungen, Datenschutz, Rate-Limits und Caching geprüft werden.

## Auf Render deployen

`render.yaml` enthält eine Render-Blueprint-Konfiguration für einen Node-Webservice in Frankfurt. In Render **New → Blueprint** wählen und dieses Repository verbinden. Render führt `npm ci` und `npm start` aus; der Health-Check verwendet `/api/health`. Der Server bindet an `0.0.0.0` und nutzt den von Render gesetzten `PORT`.

Die Preis- und Live-Bahnhofssuche benötigen ausgehende HTTPS-Verbindungen zu den DB/bahn.de-Endpunkten. Render-Webservices können externe APIs aufrufen; ob die Suche dauerhaft funktioniert, hängt trotzdem davon ab, dass DB die Render-Ausgangs-IP und die verwendeten öffentlichen Endpunkte akzeptiert. `/api/health` prüft nur, ob die App läuft – nicht, ob bahn.de erreichbar ist. Nach dem Deploy daher eine echte Stations- und Preisabfrage testen. Es wird kein DB-API-Schlüssel hinterlegt; wenn die API nicht erreichbar ist, zeigt die App keine Beispielpreise an.

## Prüfen

```sh
npm run check
npm test
```
