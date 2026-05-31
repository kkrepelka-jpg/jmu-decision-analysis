# Decision Analysis Workbench — Netlify deployment (with working Claude AI)

This folder is a complete static site **plus a serverless function** that makes the
"Suggest with AI" buttons work on the live site.

```
netlify-package/
├── index.html                    ← the whole app (all assets inlined)
├── netlify.toml                  ← build + routing config (don't edit)
└── netlify/functions/chat.js     ← Claude proxy (holds your API key server-side)
```

## One-time setup: your Anthropic API key

The AI buttons call Claude through the serverless function so your key never ships
to the browser. You need an Anthropic API key:

1. Get one at **https://console.anthropic.com** → API Keys.
2. You'll add it to Netlify as an environment variable named **`ANTHROPIC_API_KEY`**
   (steps below). **Never** put the key in any file in this folder.

## Deploy

### Option A — Git repo (recommended; functions deploy automatically)
1. Push this folder to a GitHub/GitLab repo.
2. Netlify → **Add new site → Import an existing project** → pick the repo.
3. Build settings: leave **build command empty**; **publish directory** = the folder
   containing `index.html` (`.` if this folder is the repo root). Netlify reads
   `netlify.toml` for the rest.
4. After the first deploy: **Site configuration → Environment variables → Add a
   variable** → key `ANTHROPIC_API_KEY`, value = your key. Then **Deploys → Trigger
   deploy → Clear cache and deploy site** so the function picks up the key.

### Option B — Drag-and-drop
Netlify Drop (app.netlify.com/drop) deploys the static files but **not** functions.
Use the Netlify CLI or a Git repo instead so `netlify/functions/chat.js` ships.

### Option C — Netlify CLI
```bash
npm install -g netlify-cli
cd netlify-package
netlify deploy --prod
netlify env:set ANTHROPIC_API_KEY "sk-ant-..."   # then redeploy
```

## How it works

```
Browser (AI button)  →  POST /api/chat  →  netlify/functions/chat.js  →  Anthropic API
                     ←        { text }   ←        (adds secret key)     ←
```

- The front-end first tries the in-app preview helper; on a live deploy that's absent,
  so it automatically POSTs to `/api/chat`.
- The function uses **Claude Haiku** (`claude-3-5-haiku-latest`) — fast and inexpensive.
  To change the model, edit `MODEL` at the top of `netlify/functions/chat.js`.
- The coach receives the relevant slice of the user's workbench (situation,
  alternatives, scores, ethics notes) as context with each request.

## Costs & limits

- Haiku is Anthropic's cheapest model; each button press is a single short request.
- **Built-in rate limiting:** the function caps each visitor IP at **8 requests/minute**
  and **200/day** (tune `MAX_PER_WINDOW` / `MAX_PER_DAY` at the top of
  `netlify/functions/chat.js`). This is an in-memory deterrent — it resets on cold
  starts and isn't shared across concurrent instances. For hard limits, back it with
  a shared store (Netlify Blobs or Upstash Redis); see the note at the bottom of the
  function file.

## Troubleshooting

- **Buttons say the helper isn't wired up** → the function didn't deploy. Make sure you
  used Git or the CLI (not drag-and-drop) and that `netlify/functions/chat.js` is present.
- **"Server is missing ANTHROPIC_API_KEY"** → add the env var, then redeploy.
- **502 / Anthropic API error** → usually an invalid key or billing not enabled on your
  Anthropic account.

## Privacy

Each visitor's workbench is saved only in their own browser (`localStorage`). The only
data sent anywhere is the prompt + context for a given AI request, which goes to
Anthropic via your function.
