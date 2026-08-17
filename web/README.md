# NetPulse DPI web console

The dashboard is served by `../server.py`, which also exposes its local API:

- `GET /api/health` — whether `dpi_engine` is built and available;
- `POST /api/inspections` — receives the selected PCAP and blocking rules;
- `GET /api/inspections/<id>` — returns engine status, logs, and metrics;
- `GET /api/inspections/<id>/output` — downloads the filtered PCAP after a successful run.

The interface and API use the same origin. Do not open `index.html` directly—start the server from the repository root and use the URL it prints.
