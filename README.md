# MWO Boutique Finder: setup guide

This folder is a complete website. Netlify hosts it, keeps your Anthropic API key hidden on the server, and stores the shared pipeline. Setup takes about 30 minutes, and you don't need to write any code.

**What's in the folder**

| Path | What it does |
|---|---|
| `public/index.html` | The page people use |
| `netlify/edge-functions/claude.js` | Calls Claude with your key, runs live web searches, and streams results back to the page |
| `netlify/functions/api.mjs` | Checks access codes and saves the pipeline |
| `netlify/lib/core.js` | Shared logic: prompts, access codes, daily limits |
| `netlify.toml`, `package.json` | Netlify settings. Don't edit them. |

---

## 1. Get a fresh API key and set a spending cap

1. Go to **console.anthropic.com**, then **API Keys**.
2. **Delete the key you pasted into the chat earlier.** Treat it as exposed.
3. Click **Create Key**, name it `boutique-finder`, and copy it. You'll paste it into Netlify in step 4 and nowhere else.
4. Go to **Settings, then Limits**, and set a **monthly spend limit**, for example $50. That's your safety net.
5. Under **Billing**, add credit if the account has none.

**Rough costs:** one store search runs about 8 web lookups. With Claude Sonnet 5.5, that's roughly **$0.15 to $0.40 per search**: $10 per 1,000 web lookups plus reading the search results. Drafts and briefs cost about a cent each.

## 2. Put the folder on GitHub

Netlify builds the server functions from a GitHub repository. The drag-and-drop upload doesn't support them.

1. Create a free account at **github.com** if you don't have one.
2. Click **+**, then **New repository**. Name it `boutique-finder`, choose **Private**, and click **Create repository**.
3. On the new repo page, click **uploading an existing file**.
4. Unzip the folder on your computer. Open it, select **everything inside it**, and drag it into the GitHub upload area. Include `public`, `netlify`, `netlify.toml`, `package.json` and `README.md`. The folders keep their structure.
5. Click **Commit changes**.

## 3. Connect the repo to Netlify

1. Create a free account at **app.netlify.com**. Signing up with GitHub is easiest.
2. Click **Add new project**, then **Import an existing project**, then **GitHub**, and pick `boutique-finder`.
3. Leave the build settings as they are. `netlify.toml` already sets them.
4. Click **Deploy**. This first deploy will load, but searches won't work until you add the key in step 4.

## 4. Add your secrets (environment variables)

In Netlify, open your project, then **Project configuration**, then **Environment variables**, then **Add a variable**. Add these:

| Key | Value | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | your new key from step 1 | Tick **Contains secret values** |
| `ACCESS_CODES` | see below | Who can sign in. Also tick **secret**. |
| `DAILY_SEARCH_LIMIT` | `25` | Optional. Store searches per code per day. |
| `DAILY_DRAFT_LIMIT` | `150` | Optional. Drafts and briefs per code per day. |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Optional. This is already the default. |
| `MAX_WEB_SEARCHES` | `8` | Optional. Web lookups per store search. Lower it to save money. |

**Writing `ACCESS_CODES`:** list your codes, separated by commas, each as `name:code`. Add `:admin` to your own.

```
amy:cobalt-dot-4417:admin, chakiboo:knee-patch-2291
```

- **Name each client's code after their brand**, like `chakiboo`. The name is also the client's private pipeline.
- Clients see only their own pipeline. Your admin code sees every client's pipeline. When you search or add stores as admin, they're filed under whatever is in the Brand field.
- Pick codes that are hard to guess: two or three words plus a number works well.
- To remove someone's access, delete their entry and redeploy.

After saving the variables, go to **Deploys**, then **Trigger deploy**, then **Deploy project**. New variables only take effect after a redeploy.

## 5. Test it

1. Open the `https://something.netlify.app` address Netlify gives you.
2. Sign in with your admin code.
3. Run one search. You'll see the live web lookups as they happen, and results arrive in about one to two minutes.
4. Add a store to the pipeline, change its stage, and reload. It should still be there.

If something fails, the page shows a plain-English message. For more detail, open **Logs**, then **Functions** or **Edge Functions**, in Netlify.

## 6. Put it on your own domain (optional)

To use something like `finder.machinewashonly.com`:

1. In Netlify, go to **Domain management**, then **Add a domain**, and enter `finder.yourdomain.com`.
2. Netlify shows a **CNAME** target, like `your-site.netlify.app`.
3. In **Squarespace**, go to **Settings**, then **Domains**, your domain, **DNS**, then **Add record**:
   - Type: **CNAME**
   - Host: **finder**
   - Data: the Netlify target from step 2
4. Wait up to an hour. Netlify adds HTTPS automatically.
5. On your Squarespace site, add a button or menu link that points to the new address.

## Changing things later

- **Add or remove a client:** edit `ACCESS_CODES`, then trigger a redeploy.
- **Change the look or wording:** edit `public/index.html` on GitHub with the pencil icon. Netlify redeploys automatically.
- **Change what Claude is asked:** the prompts are in `netlify/lib/core.js`, in `buildSearch` and `buildDraft`.

## Good to know

- **Your key never reaches the browser.** The page only talks to your own Netlify functions, and they add the key on the server.
- **Clients don't need Claude accounts.** All usage bills to your Anthropic account, within the daily limits you set.
- **The pipeline lives in Netlify Blobs,** Netlify's built-in storage. It stays across deploys and needs no setup. If two people edit the same client's pipeline at the same moment, the last save wins. That's fine for a small team.
- **Search results are researched, not guaranteed.** Stores marked **Verify** couldn't be fully confirmed online, so check before visiting.
- **Daily limits reset at midnight UTC,** which is 8pm Eastern in summer and 7pm in winter.
