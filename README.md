# Pulse system monitor

Pulse is a local-only Windows dashboard for monitoring CPU, GPU, and memory usage. The monitor binds to `127.0.0.1` and does not send system metrics to an online service.

## Run it

Install Node.js 20 or newer, then run these commands from the project folder:

```powershell
npm.cmd ci
npm.cmd start
```

Open `http://127.0.0.1:3000` in a browser and keep the Node.js process running while using the dashboard. Do not open `index.html` directly or use Live Server; the dashboard requires the local API served by `server.js`.

The service binds only to `127.0.0.1`, so it is not accessible from other computers. To choose a different local port:

```powershell
$env:PORT = "3001"; npm.cmd start
```

To stop monitoring, press Ctrl+C in the terminal. Metrics history is stored on this computer in `.pulse-data\history.json` and retained for up to seven days.

## Monitoring and API

- CPU usage, processor model, logical core count, and clock speed come from local operating-system counters.
- RAM use and availability are sampled locally.
- NVIDIA cards use `nvidia-smi` when available. AMD cards use the temperature sensor exposed by the installed Radeon driver; other Windows adapters are identified by their DXGI adapter LUID and matched to Windows per-adapter GPU-engine and memory counters. The card with dedicated video memory is shown as the primary GPU; integrated graphics remain visible in system details.
- GPU temperature is available only when the vendor driver exposes a supported sensor. Unsupported GPU temperature or memory readings are shown as unavailable.
- Dashboard updates are streamed over local Server-Sent Events at `/api/events`. JSON endpoints are `/api/health`, `/api/device`, `/api/metrics`, `/api/history?range=6h`, and `/api/alerts?limit=20`.
- Samples are collected every two seconds; chart history is saved every ten seconds. History and alerts remain on this computer.
- CPU, GPU, and memory alerts are raised when a threshold is exceeded continuously for ten seconds. Thresholds are defined near the top of `server.js`.

Pulse is intentionally local-only. It has no login, account, cloud sync, public web service, or remote telemetry upload.
