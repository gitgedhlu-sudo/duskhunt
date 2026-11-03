# DuskHunt

Real-world GPS manhunt. **Hunters vs Shadows** on real streets, playable in a phone browser.

## How a match plays
- **3 min head start** – Shadows run, Hunters wait.
- **Location pings every 3 min** – Hunters see where each Shadow was at ping time (plus a compass to the nearest one).
- **Play zone** – default 150 m radius; the host can set any value from 50 to 400 m.
- **Zone shrinks every 10 min** – Shadows who leave the zone are revealed live to Hunters.
- **30 min clock** – Shadows win if any survive; Hunters win if all are caught.
- Shadows tap **I GOT TAGGED** when caught.

## Run locally
```bash
npm install
npm start            # http://localhost:3000   (landing at /, game at /play)
npm run dev          # same, but 20x faster timers for testing
```
Browsers only allow GPS on **HTTPS or localhost**. Railway gives you HTTPS automatically.

## Deploy on Railway
1. Push this folder to a GitHub repo.
2. On https://railway.app → **New Project → Deploy from GitHub repo** → pick it.
3. Railway detects Node and runs `npm start` (config in `railway.json`). It sets `PORT` for you.
4. Service → **Settings → Networking → Generate Domain** (or add your custom domain).
5. Open `https://<your-domain>/play` on two phones and test.

Environment variables (optional): `TIME_SCALE` (default `1`; set `20` to test fast).

## Important notes
- **Run exactly 1 replica.** Matches live in server memory (no database), so a restart or redeploy ends active matches.
- Update `public/privacy.html` and `public/terms.html` (they are templates) and add a contact email.
- Map tiles come from OpenStreetMap's public servers, which is fine for small use. For heavy traffic use a tile provider (MapTiler, Stadia, etc.).
- Android app later: wrap `/play` with Capacitor or a TWA.

## Structure
```
server.js          Express + Socket.IO game server (rooms, roles, pings, zone, tagging)
public/index.html  Landing page
public/play.html   Game UI
public/js/play.js  Client: GPS, map, compass, HUD
public/css/style.css
railway.json       Railway config
```
