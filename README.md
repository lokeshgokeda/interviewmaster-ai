# InterviewMaster AI — Vercel + PostgreSQL

Vercel-ready deployment of InterviewMaster AI with:

- Mobile-friendly frontend
- Real email/password registration and login
- bcrypt password hashing
- JWT authentication
- HttpOnly session cookie
- Neon PostgreSQL
- Cloud-saved learning progress
- Attempts/history persistence
- LocalStorage offline cache
- Guest mode
- `/api/health` database health check

## 1. Create PostgreSQL

Use Vercel's Neon integration or an existing Neon project. Vercel documents Neon as a native serverless Postgres integration and provides `DATABASE_URL` to the project. See the official Vercel Neon integration: https://vercel.com/marketplace/neon

## 2. Environment variables

Set these in Vercel Project Settings → Environment Variables:

- `DATABASE_URL`
- `JWT_SECRET`

Generate a secret with:

```bash
openssl rand -base64 32
```

## 3. Deploy

Push this folder to GitHub and import the repository into Vercel, or run:

```bash
npm install
npx vercel login
npx vercel
npx vercel --prod
```

Vercel serves the frontend and `/api/*` as serverless functions. The database tables are created automatically on the first API request.

## 4. Mobile

Open the generated Vercel HTTPS URL directly on Android/iPhone. No localhost configuration is required. API calls use the same origin (`/api`), so the phone talks to the deployed backend automatically.

## 5. Local development

Create `.env` from `.env.example`, put a Neon `DATABASE_URL` and `JWT_SECRET` in it, then:

```bash
npm install
npm run dev
```

Open the URL printed by Vercel CLI.
