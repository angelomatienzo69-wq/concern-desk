# Free deployment (Render free web service + Neon free Postgres) - about 15 minutes, no card needed

The app uses PostgreSQL when `DATABASE_URL` is set, otherwise a local SQLite file.
Render's free plan has no persistent disk, so the database lives on Neon instead.

## 1. Create the free database (Neon)
1. Sign up at https://neon.tech (free, no card). Create a project (any name, nearest region).
2. On the project dashboard click **Connect** and copy the connection string. It looks like
   `postgresql://user:password@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require`
   Keep it private. The app creates and seeds the tables itself on first start.

## 2. Put the code on GitHub
Create an empty repo, then from this folder:
`git init && git add . && git commit -m "init" && git branch -M main && git remote add origin <your-repo-url> && git push -u origin main`

## 3. Create the free web service (Render)
1. https://render.com -> sign up with GitHub -> **New -> Web Service** -> pick the repo.
2. Settings: Runtime **Node**, Build Command `npm install`, Start Command `node server.js`, Instance Type **Free**.
3. Environment variables:
   - `DATABASE_URL` = your Neon connection string
   - `SEED_PASSWORD` = password for the demo accounts (not a personal one)
   - `NODE_ENV` = `production`
   - `NODE_VERSION` = `22.14.0`
4. **Create Web Service**. When the log shows "running ... (PostgreSQL)" and the status is Live, open the URL.

## 4. Verify
Log in as `demo.admin@email.com` and `demo.user@email.com` with your SEED_PASSWORD, submit and process a few concerns.
**Prove persistence:** Render -> Manual Deploy -> *Deploy latest commit*, log in again; the records must still be there.

## What to submit
- Production URL | Stack: Node.js (built-in HTTP server) + vanilla JS frontend + PostgreSQL
- Frontend + backend: Render free Web Service | Database: Neon Postgres (free)
- Database screenshots: Neon dashboard -> **Tables** or **SQL Editor**: `select * from concerns;`

## Notes
- Free Render services sleep after ~15 min idle; the first request then takes ~30-60 s. Open the site a few minutes before a demo.
- Free Neon databases also pause when idle and wake automatically on the next request.
- To run locally with no database setup: `node server.js` (uses SQLite, no npm install needed).
