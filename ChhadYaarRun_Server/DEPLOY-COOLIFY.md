# Deploying on your Hostinger server with Coolify

One small container serves **the game, the data and the admin panel**. The game
itself stays plain static files, so there is no extra load on it while playing.

## What's in this folder

| | |
|---|---|
| `server.js` | Node server: static game + API + admin panel + Excel export |
| `public/` | the game (index.html, ai/, icons, service worker) |
| `Dockerfile` | how Coolify builds it |
| `package.json` | one dependency (`xlsx`) for the Excel file |
| `data/` | created at runtime — holds `db.json` with all entries |

## Deploy

1. Push this folder to a Git repository (GitHub/GitLab), or use Coolify's
   "Upload" / local repository option.
2. In Coolify: **+ New → Resource → Application**, pick the repository.
3. Build pack: **Dockerfile**. Port: **3000**.
4. **Environment variables:**

   | Name | Value |
   |---|---|
   | `ADMIN_KEY` | a long random password — needed for the admin panel and exports |
   | `DATA_DIR` | `/data` |
   | `MIN_SCORE_CONSULT` | `5000` |
   | `PACKAGES_FOR_FULL` | `3` |
   | `MAX_VOUCHERS_DAY` | `5` |
   | `OPD_CODES` | `50` |
   | `PHC_CODES` | `30` |
   | `VALID_TILL` | `31 Oct 2026` |

5. **Persistent storage — do not skip.** Add a volume mounted at **`/data`**.
   Without it every redeploy wipes the entries and the issued codes.
6. Set your domain (e.g. `heartday.fortismohali.in`) and let Coolify issue the
   **HTTPS certificate**. The camera only works over HTTPS.
7. Health check path: `/healthz`.
8. Deploy.

## Using it

* **Game:** `https://your-domain/`
* **Admin panel:** `https://your-domain/admin` — enter the `ADMIN_KEY` once.
  Shows runs today, players, best score, vouchers used today, codes left, and
  the last 200 entries. Buttons download **Excel** and **CSV**.
* **Excel any time:** `https://your-domain/api/export.xlsx?key=YOUR_ADMIN_KEY`
  (two sheets: every entry, and a Vouchers-only sheet.)

## Why codes come from the server

"One voucher per phone number" and "max 5 per day" cannot be enforced on the
device — two tablets would each issue their own codes. The server hands out
`FHMHEART@OPD - 01…50` and `FHMHEART@PHC - 01…30` in order, never twice.

If the network drops mid-activation, the game stores the run on the device and
shows "please show this screen at the Fortis desk" instead of inventing a code.
Staff can press **Ctrl+Shift+U** later to send those stored runs to the server.

## Backups

`db.json` lives in the `/data` volume. Download the Excel at the end of each
day as your backup — that is the simplest safe habit.

## Keeping the game fast

The game is served as static files with long cache headers for the AI files, so
a returning device loads instantly. The API is only called **once per finished
run** — never during play.
