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

## Host the dashboard on Netlify

The hosted dashboard reads metrics only from the visitor's own Windows PC. Each visitor must install Node.js 20+, download this project, and start the local agent; the website does not upload or store their metrics.

1. Connect this repository to Netlify. The included `netlify.toml` builds and publishes only the static dashboard files.
2. On the visitor's PC, open PowerShell in the downloaded project folder and set the origin to the exact HTTPS address of your Netlify site:

   ```powershell
   npm.cmd ci
   $env:PULSE_DASHBOARD_ORIGIN = "https://your-site.netlify.app"
   npm.cmd start
   ```

3. Open the Netlify site in a supported browser and choose **Connect to this PC**. The browser may ask for permission to access the local network. The agent accepts requests only from the configured site origin and stays bound to `127.0.0.1`.

The visitor can disconnect by closing the agent's terminal. Do not enable Tailscale Funnel or expose port 3000. For a custom domain, configure that exact HTTPS origin in `PULSE_DASHBOARD_ORIGIN` instead.

## Private remote access with Tailscale

Pulse reads hardware metrics from the Windows computer where it runs. To view that computer's dashboard remotely, keep Pulse on Windows and use Tailscale for private access; do not expose port 3000 directly or use Tailscale Funnel.

1. Install and sign in to Tailscale on the Windows PC and the devices that should access the dashboard. Use the device's HTTPS MagicDNS name from your tailnet (for example, `https://my-pc.example-tailnet.ts.net`).
2. In the PowerShell window where Pulse will run, set the origin to that exact HTTPS origin and start Pulse:

   ```powershell
   $env:PULSE_PUBLIC_ORIGIN = "https://my-pc.example-tailnet.ts.net"
   npm.cmd start
   ```

3. In a second PowerShell window on the PC, start Tailscale Serve to proxy the private HTTPS address to Pulse:

   ```powershell
   tailscale serve --bg http://127.0.0.1:3000
   ```

4. Open the HTTPS MagicDNS address on an enrolled device. Keep both Pulse and Tailscale running. Tailscale Serve is private to your tailnet; do not enable Funnel.

`PULSE_PUBLIC_ORIGIN` allows only that configured HTTPS origin and host in addition to Pulse's existing localhost access. It does not make Pulse listen on a network interface; the Tailscale proxy connects to the loopback server. Use Tailscale's device/user access controls to decide who can reach the machine.

## Monitoring and API

- CPU usage, processor model, logical core count, and clock speed come from local operating-system counters.
- RAM use and availability are sampled locally.
- NVIDIA cards use `nvidia-smi` when available. AMD cards use the temperature sensor exposed by the installed Radeon driver; other Windows adapters are identified by their DXGI adapter LUID and matched to Windows per-adapter GPU-engine and memory counters. The card with dedicated video memory is shown as the primary GPU; integrated graphics remain visible in system details.
- GPU temperature is available only when the vendor driver exposes a supported sensor. Unsupported GPU temperature or memory readings are shown as unavailable.
- Dashboard updates are streamed over local Server-Sent Events at `/api/events`. JSON endpoints are `/api/health`, `/api/device`, `/api/metrics`, `/api/history?range=6h`, and `/api/alerts?limit=20`.
- Samples are collected every two seconds; chart history is saved every ten seconds. History and alerts remain on this computer.
- CPU, GPU, and memory alerts are raised when a threshold is exceeded continuously for ten seconds. Thresholds are defined near the top of `server.js`.

Pulse has no login or account. In the Netlify setup, the static site connects directly to the visitor's local agent; metrics and history remain on that PC and are not sent to Netlify.
