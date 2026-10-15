# Neo Sisra admin interface

React + Vite interface for the existing bot's `/api/admin` API. Authentication,
audiences, broadcasts, and delivery counts are supplied by the Node server.
No bot token or admin password is included in the client build.

```powershell
npm --prefix admin ci
npm --prefix admin run build
```

The build creates `admin/dist/` and regenerates the root `admin-assets.cjs`.
That CommonJS file contains the HTML, JavaScript, and CSS as base64 assets so
the existing bot deployment can serve the UI without a frontend runtime.
Commit `admin-assets.cjs` with frontend changes; `admin/dist/` and
`admin/node_modules/` are build output.

For development, start the admin API at `http://127.0.0.1:8787` with that
`ADMIN_ORIGIN`, then run:

```powershell
npm --prefix admin run dev
```

Open `http://127.0.0.1:5173`. The localhost-only Vite development server proxies
`/api` to port 8787 and rewrites its Host and Origin consistently. Production
uses a same-origin `/api/admin` endpoint and does not use that development proxy.

For Vercel, deploy only the contents of `admin/dist/` together with
`admin/vercel.json` in a separate staging directory. The configuration expects
already-built assets (`outputDirectory: "."`); do not deploy the repository or
the `admin/` source directory with it. Its external rewrite forwards the API
to the bot server over HTTPS. Keep the production Vercel alias equal to the
bot's `ADMIN_ORIGIN` and the Nginx upstream Host. No Vercel environment secret
or Telegram token is needed. See [production setup](../docs/ADMIN.md).

The UI requests confirmation before broadcasting. A pending broadcast UUID
is retained in session storage until its server result is known, including
across page refresh and reauthentication. An uncertain request must be checked
with the same UUID before a new broadcast can be sent. All displayed audience
and delivery numbers come from the API. The demo server is explicitly marked
when its dashboard response includes `demoMode: true`.
