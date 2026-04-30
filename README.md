<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/cc404f7d-10b9-4cce-bc27-97d82605d5d8

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies:
   `npm install`
2. Copy [.env.example](</Z:/GSCPLUS/.env.example>) to `.env.local` or `.env`
3. Set `GEMINI_API_KEY`
4. For persistent Google Search Console and GA4 access, also set:
   `GOOGLE_OAUTH_CLIENT_ID`
   `GOOGLE_OAUTH_CLIENT_SECRET`
   `APP_BASE_URL`
   `GOOGLE_OAUTH_REDIRECT_URI`
5. Add your local callback URI to the Google OAuth client:
   `http://localhost:3000/api/google/oauth/callback`
6. Run the app:
   `npm run dev`

## PostgreSQL

By default the app still falls back to `sqlite.db` so local development does not break.

To run on PostgreSQL, set `DATABASE_URL` in `.env.local`:

`DATABASE_URL="postgresql://postgres:postgres@localhost:5432/nextgen_seo"`

Then start the app normally:

`npm run dev`

To copy existing local SQLite data into PostgreSQL:

`npm run db:migrate:postgres`
