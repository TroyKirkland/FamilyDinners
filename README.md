# Family Dinners — Weekly Planner

A small, dependency-free weekly planner for family dinners, hosted on GitHub Pages with data shared via a `data.json` file in the repo.

For each day of the week you can:

- Write a **Dinner** idea.
- Tick each person as **Home** or **Away**.
- See a summary: how many people are home, and the locked-in dinner when everyone's in.

## Run it locally

It's plain HTML/CSS/JS — no build step, no install.

```sh
open index.html
# or, if your browser is fussy about file://:
python3 -m http.server 8000   # then visit http://localhost:8000
```

## How sharing works

The page reads/writes a `data.json` file in this repo through the [GitHub Contents API](https://docs.github.com/en/rest/repos/contents). Everyone who opens the deployed page sees the same data, polled every 30 seconds. Edits you make are debounced (~1s) and committed back to the file with a SHA so two people editing at the same time won't clobber each other.

There is **no backend** — the GitHub repo itself is the database. That means:

- ✅ Free, no extra accounts, no services
- ✅ Lives entirely in this repo (your data is versioned in git)
- ⚠️ Every save = one API call. Fine for a family; not fine for thousands of users
- ⚠️ Requires a GitHub PAT to write. Anyone with the token can edit

## One-time setup (do this before sharing with the family)

1. **Push this code to GitHub** (see below).
2. **Create a Personal Access Token (classic, fine-grained):**
   - Go to <https://github.com/settings/tokens?type=beta>
   - Click **Generate new token** (fine-grained)
   - Resource owner: your account
   - **Repository access:** "Only select repositories" → choose `TroyKirkland/FamilyDinners`
   - **Permissions → Repository permissions → Contents:** Read and write
   - Generate and copy the token (it shows only once)
3. **Open the deployed page** and click **⚙ Settings** in the header.
4. Fill in:
   - Owner: `TroyKirkland`
   - Repo: `FamilyDinners`
   - Branch: `main`
   - File path: `data.json`
   - Token: paste the PAT
5. Click **Test connection** to verify. You should see "Connection OK".
6. Check **"Migrate existing local data into the shared file"** if you already have people/votes in your browser cache, then click **Save**.

Give the token to your family the same way you'd share a password. They each open the page, click **⚙ Settings**, and paste the token. Their local data will be visible in the same `data.json`.

> **Security note:** the PAT sits in each user's `localStorage`. Treat it like a password — anyone with the token can edit your `data.json`. If it leaks, revoke it at <https://github.com/settings/tokens?type=beta> and create a new one.

## Files

- `index.html` — markup
- `styles.css` — styling
- `app.js` — state, GitHub backend, rendering
- `data.json` — created automatically the first time the app saves

## Push to GitHub & enable Pages

```sh
cd /Users/troykirkland/Documents/Code/Project1
git init
git add .
git commit -m "Initial commit: family dinner planner"
git branch -M main
git remote add origin git@github.com:TroyKirkland/FamilyDinners.git
git push -u origin main
```

Then in the GitHub UI:

1. Go to **Settings → Pages**.
2. **Source:** "Deploy from a branch", branch `main`, folder `/ (root)`.
3. Save. After a minute or two, your site is at `https://<your-username>.github.io/FamilyDinners/`.
4. Open that URL, set the PAT in **⚙ Settings**, done.

## How conflicts are handled

When two people edit at the same time:

- Each save includes the file's current SHA (returned from the last read).
- If a save fails with `409 Conflict` (someone else wrote first), the app re-reads the file, merges: **people union**, **dinners per-day last-writer-wins**, **votes union (any "home" tick wins)**, then retries. Up to 3 attempts.
- The page polls every 30 seconds to pick up changes from other devices, and the **↻ Refresh** button does it on demand.

## Clearing data

The page reads/writes `data.json` in the repo. To wipe it:

- **One device:** open **⚙ Settings** and clear the token. The page falls back to local-only mode (no `data.json` reads/writes). To go back to sharing, paste the token again.
- **Everyone / start over:** delete `data.json` from the repo (or empty its contents to `{}`).
