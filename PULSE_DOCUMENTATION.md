# Pulse Status App — Complete Documentation

**Version:** 1.0.0  
**Live URL:** https://pulse-gray-eight.vercel.app  
**GitHub:** https://github.com/Kalabduke/Pulse  
**Date:** May 2026

---

## Table of Contents

1. [What is Pulse?](#1-what-is-pulse)
2. [Features](#2-features)
3. [Technology Stack](#3-technology-stack)
4. [Project Structure](#4-project-structure)
5. [How It Works](#5-how-it-works)
6. [Database Schema](#6-database-schema)
7. [Authentication](#7-authentication)
8. [Real-Time Sync](#8-real-time-sync)
9. [PWA & Notifications](#9-pwa--notifications)
10. [Finding Your Keys](#10-finding-your-keys)
11. [Deployment Guide](#11-deployment-guide)
12. [Google OAuth Setup](#12-google-oauth-setup)
13. [Supabase Setup](#13-supabase-setup)
14. [Environment Variables](#14-environment-variables)
15. [Making Updates](#15-making-updates)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. What is Pulse?

Pulse is a real-time emotional and health status sharing app for close friends (up to 5 connections). It lets users set an emoji + text status that their connected friends can see instantly — on their phone, in notifications, and on their lockscreen.

Think of it as a private, intimate version of "what are you up to right now" — not a social feed, but a live presence indicator for the people closest to you.

---

## 2. Features

### Core Features
- **Email/Password Authentication** — sign up and log in with email and password
- **Google OAuth** — one-tap sign in with Google account
- **Real-time Status Updates** — when you update your status, connected friends see it instantly without refreshing
- **Emoji Status Picker** — 6 categories (Mood, Health, Activity, Nature, Food, Travel) with 50+ emojis each, plus a custom emoji input field to type or paste any emoji
- **Status Text** — custom message alongside the emoji (e.g., "Coding deep", "Feeling tired")
- **Friend Connections** — connect with up to 5 friends using their Pulse ID or display name
- **Nicknames** — give your connected friends custom nicknames only you can see
- **Status History** — view your last 15 status updates with timestamps
- **Refresh Button** — manually sync when coming back online after being offline

### Notifications
- **Pop-up heads-up notification** — appears at the top of the screen like Telegram/Snapchat when a friend updates their status
- **Persistent lockscreen notification** — stays in the notification tray as a live widget, updates silently each time
- **Notification permission banner** — non-intrusive in-app prompt to enable notifications

### PWA (Progressive Web App)
- **Install to home screen** — works on Android and iOS like a native app
- **App icon** — custom Pulse waveform icon (192×192 and 512×512 PNG)
- **Offline support** — app shell cached by service worker, works without internet
- **Background sync** — syncs when connection is restored

---

## 3. Technology Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend Framework | Vite + Vanilla JS | Fast build tool, no framework overhead |
| Styling | Vanilla CSS | Dark-mode glassmorphism design system |
| Database | Supabase (PostgreSQL) | Stores profiles, connections, status history |
| Real-time | Supabase Realtime | WebSocket subscriptions for live updates |
| Authentication | Supabase Auth | Email/password + Google OAuth |
| Hosting | Vercel | Auto-deploys from GitHub on every push |
| Version Control | GitHub | Source code repository |
| PWA | Web App Manifest + Service Worker | Install as app, offline support, notifications |
| Email (SMTP) | Resend.com | Transactional emails via Supabase |

### Key Libraries
- `@supabase/supabase-js` v2.43.4 — official Supabase JavaScript client

---

## 4. Project Structure

```
pulse/
├── index.html                  # Main HTML — all views/screens
├── vite.config.js              # Vite build configuration
├── vercel.json                 # Vercel deployment + headers config
├── netlify.toml                # Netlify config (alternative host)
├── package.json                # Dependencies and scripts
├── .gitignore                  # Files excluded from Git
├── supabase_setup.sql          # Full database setup script
├── PULSE_DOCUMENTATION.md      # This document
├── src/
│   ├── main.js                 # App logic, routing, event handlers
│   ├── style.css               # All styles and design tokens
│   └── supabase.js             # Supabase client + all API functions
└── public/
    ├── manifest.json           # PWA manifest
    ├── sw.js                   # Service Worker (caching + notifications)
    ├── logo.svg                # SVG logo
    ├── icon-192.png            # PWA home screen icon (192×192)
    ├── icon-512.png            # PWA splash screen icon (512×512)
    └── notification-icon.png   # Notification badge icon
```

---

## 5. How It Works

### User Flow

```
User visits pulse-gray-eight.vercel.app
        ↓
App checks localStorage for Supabase credentials
        ↓
Credentials found (env vars) → Auth screen
        ↓
User signs in (email/password or Google)
        ↓
Dashboard loads:
  - Own status card
  - Friends feed (real-time)
  - Connect with friends panel
  - Status history
        ↓
User updates status → saved to Supabase profiles table
                    → logged to status_history table
                    → Supabase Realtime broadcasts to all connected friends
                    → Friends receive pop-up + persistent notification
```

### Real-Time Flow

```
User A updates status
        ↓
Supabase UPDATE event on profiles table
        ↓
Supabase Realtime WebSocket broadcasts to all subscribers
        ↓
User B's app receives the event (subscribeToPulseSync)
        ↓
App checks if User A is a connected friend
        ↓
If yes:
  - Updates the friend card in the UI instantly
  - Shows toast notification in-app
  - Sends FRIEND_STATUS_UPDATE message to Service Worker
        ↓
Service Worker shows:
  1. Pop-up heads-up notification (buzzes, appears at top)
  2. Persistent lockscreen notification (silent, stays in tray)
```

---

## 6. Database Schema

### Table: `profiles`
Extends Supabase's built-in `auth.users` table.

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | References auth.users.id |
| `name` | text | Display name |
| `status_emoji` | text | Current emoji (e.g., "😊") |
| `status_text` | text | Current status message |
| `updated_at` | timestamptz | When status was last changed |

### Table: `connections`
Stores friend relationships between users.

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | Auto-generated |
| `user_id` | uuid (FK) | Who sent the invite |
| `friend_id` | uuid (FK) | Who received the invite |
| `status` | text | `'pending'` or `'connected'` |
| `nickname` | text | Optional nickname (only visible to the setter) |
| `created_at` | timestamptz | When connection was created |

### Table: `status_history`
Stores the last 15 status updates per user.

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | Auto-generated |
| `user_id` | uuid (FK) | References profiles.id |
| `status_emoji` | text | Emoji at time of update |
| `status_text` | text | Status text at time of update |
| `created_at` | timestamptz | When this status was set |

### Row Level Security (RLS)
All tables have RLS enabled. Key policies:
- Users can only update their own profile
- Users can only view connections they are part of
- Users can only view status history of connected friends
- Auto-trim trigger keeps status_history at max 15 rows per user

---

## 7. Authentication

### Email/Password
- Sign up: creates account + auto-creates profile row via database trigger
- Sign in: standard email/password
- Forgot password: sends reset email via Resend SMTP

### Google OAuth
- One-tap sign in with Google account
- Redirects through Supabase OAuth callback
- Profile auto-created on first sign-in

### Session Management
- Sessions persist in localStorage via Supabase client
- Auto-refresh tokens enabled
- Sign out clears session and disconnects realtime channel

---

## 8. Real-Time Sync

Pulse uses Supabase Realtime (PostgreSQL logical replication over WebSockets).

### Subscriptions
The app subscribes to two tables:

```javascript
// In supabase.js — subscribeToPulseSync()
channel
  .on('postgres_changes', { event: 'UPDATE', table: 'profiles' }, callback)
  .on('postgres_changes', { event: '*', table: 'connections' }, callback)
```

### What triggers updates
- Any profile UPDATE (status change) → refreshes friend cards
- Any connection INSERT/UPDATE/DELETE → refreshes pending invites and friend list

### Channel naming
Each user gets their own channel: `pulse-sync-{userId}` to avoid conflicts.

---

## 9. PWA & Notifications

### Installing as an App

**Android (Chrome):**
1. Open the app in Chrome
2. Tap the 3-dot menu (⋮)
3. Tap "Add to Home Screen"
4. Tap "Install"

**iPhone (Safari):**
1. Open the app in Safari
2. Tap the Share button (□↑)
3. Scroll down and tap "Add to Home Screen"
4. Tap "Add"

**Desktop (Chrome/Edge):**
1. Look for the install icon (⊕) in the address bar
2. Click it and confirm

### Notification Types

**Pop-up heads-up notification:**
- Appears at the top of the screen
- Vibrates the device
- Shows friend's emoji, name, and status
- Has "View" and "✕" action buttons
- Auto-dismisses after a few seconds
- Unique tag per friend so multiple updates stack

**Persistent lockscreen notification:**
- Stays in the notification tray
- Updates silently (no buzz) each time
- Fixed tag `pulse-live-widget` so it replaces itself
- Tapping opens the Pulse app

### Service Worker
Located at `/public/sw.js`. Handles:
- Pre-caching app shell on install
- Network-first fetch with cache fallback
- Push notification display
- Message handling from the app
- Background sync

---

## 10. Finding Your Keys

### Supabase Project URL and Anon Key

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard)
2. Click your **Pulse-app** project
3. Click **Project Settings** (gear icon in left sidebar)
4. Click **API**
5. You will see:
   - **Project URL** → `https://xxxxxxxxxx.supabase.co`
   - **Project API keys → anon public** → `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`

> ⚠️ Never use the `service_role` key in the browser. Only use the `anon` key.

### Google OAuth Client ID and Secret

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Select your project (arcane-grin-431207-p8)
3. Go to **APIs & Services → Credentials**
4. Click your **Pulse** OAuth 2.0 Client
5. You will see:
   - **Client ID** → `207107341456-xxx.apps.googleusercontent.com`
   - **Client Secret** → click the copy icon next to the masked value

### Resend API Key (SMTP)

1. Go to [resend.com](https://resend.com)
2. Click **API Keys** in the left sidebar
3. Your key starts with `re_...`
4. If you need a new one: click **Create API Key**

---

## 11. Deployment Guide

### Prerequisites
- Node.js 18+ installed
- Git installed
- GitHub account
- Supabase account (free)
- Vercel account (free)

### Initial Setup

```bash
# Clone the repository
git clone https://github.com/Kalabduke/Pulse.git
cd Pulse

# Install dependencies
npm install

# Run locally
npm run dev
# Opens at http://localhost:3000
```

### Build for Production

```bash
npm run build
# Output goes to /dist folder
```

### Deploy to Vercel

Vercel auto-deploys on every `git push` to the `main` branch.

**Manual deploy:**
1. Go to [vercel.com](https://vercel.com)
2. Your Pulse project → **Deployments**
3. Click **Redeploy** on the latest deployment

**First-time setup:**
1. Vercel → **Add New Project** → **Import from Git** → select **Pulse**
2. Framework: **Vite**
3. Build command: `npm run build`
4. Output directory: `dist`
5. Add environment variables (see Section 14)
6. Click **Deploy**

---

## 12. Google OAuth Setup

### Step 1 — Google Cloud Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create or select a project
3. Go to **APIs & Services → OAuth consent screen**
   - User type: **External**
   - App name: `Pulse`
   - Add your email as developer contact
   - Save
4. Go to **APIs & Services → Credentials**
5. Click **+ Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Name: `Pulse`
   - **Authorized JavaScript origins:**
     ```
     http://localhost:3000
     https://pulse-gray-eight.vercel.app
     ```
   - **Authorized redirect URIs:**
     ```
     https://hrbophzmwuhmzylbjuge.supabase.co/auth/v1/callback
     ```
6. Click **Create** — copy the Client ID and Client Secret

### Step 2 — Add Test Users (while in Testing mode)

1. Go to **APIs & Services → OAuth consent screen**
2. Click **Audience** in the left sidebar
3. Under **Test users** click **+ Add Users**
4. Add your Gmail address
5. Save

### Step 3 — Supabase Google Provider

1. Go to **Supabase → Authentication → Sign In / Providers**
2. Find **Google** and toggle it ON
3. Paste your **Client ID** and **Client Secret**
4. Save

---

## 13. Supabase Setup

### Running the SQL Script

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard)
2. Select your Pulse-app project
3. Click **SQL Editor** in the left sidebar
4. Click **New query**
5. Open `supabase_setup.sql` from the project folder
6. Copy all contents and paste into the editor
7. Click **Run**

### What the SQL creates

- `profiles` table with RLS policies
- `connections` table with RLS policies
- `status_history` table with RLS policies and auto-trim trigger
- `handle_new_user()` function — auto-creates profile on signup
- `trim_status_history()` function — keeps history at max 15 rows
- Realtime publication for both tables

### Additional queries to run separately

```sql
-- Add nickname column (if not already added)
alter table public.connections
add column if not exists nickname text default null;

-- Add insert policy for profiles (for OAuth users)
create policy "Allow users to insert their own profile"
on public.profiles for insert to authenticated
with check (auth.uid() = id);
```

### Supabase URL Configuration

1. Go to **Authentication → URL Configuration**
2. Set **Site URL** to: `https://pulse-gray-eight.vercel.app`
3. Add to **Redirect URLs**:
   - `http://localhost:3000`
   - `https://pulse-gray-eight.vercel.app`
4. Save

### SMTP Configuration (Resend)

1. Go to **Project Settings → Authentication → SMTP Settings**
2. Fill in:
   - Sender email: `onboarding@resend.dev`
   - Sender name: `Pulse`
   - Host: `smtp.resend.com`
   - Port: `465`
   - Minimum interval: `0`
   - Username: `resend`
   - Password: your `re_...` API key from Resend
3. Save

---

## 14. Environment Variables

These must be set in Vercel before deploying.

| Variable | Value | Where to find |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://hrbophzmwuhmzylbjuge.supabase.co` | Supabase → Project Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` | Supabase → Project Settings → API → anon public key |

### Setting in Vercel

1. Go to [vercel.com](https://vercel.com) → your Pulse project
2. Click **Settings** → **Environment Variables**
3. Add each variable with its value
4. Set environment to **Production and Preview**
5. Save
6. Redeploy for changes to take effect

### Setting for local development

Create a `.env.local` file in the project root (this file is gitignored):

```
VITE_SUPABASE_URL=https://hrbophzmwuhmzylbjuge.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key_here
```

---

## 15. Making Updates

### Workflow

```bash
# 1. Make your changes in the code
# 2. Test locally
npm run dev

# 3. Build to check for errors
npm run build

# 4. Commit and push
git add .
git commit -m "Description of what you changed"
git push

# Vercel automatically redeploys within 30-60 seconds
```

### Common Updates

**Change the emoji categories:**
Edit the `EMOJI_CATEGORIES` object in `src/main.js`

**Change the max connections limit:**
In `src/supabase.js`, find `if (activeCount >= 5)` and change `5`

**Change the history limit:**
In `supabase_setup.sql`, find `limit 15` in the trim function and change it.
Also update `.limit(15)` in `fetchStatusHistory()` in `src/supabase.js`

**Change app colors:**
Edit the CSS variables at the top of `src/style.css` under `:root`

**Change the app name:**
Update `public/manifest.json` → `name` and `short_name`
Update `index.html` → `<title>` tag

---

## 16. Troubleshooting

### "Configure Pulse" screen shows on live site
**Cause:** Environment variables not set in Vercel
**Fix:** Go to Vercel → Settings → Environment Variables → add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` → Redeploy

### White screen after login
**Cause:** Supabase URL is wrong or project is paused
**Fix:** Check Supabase dashboard — if project shows "Paused", click Resume. Verify the URL in Vercel env vars matches exactly.

### Google sign-in "Access blocked: redirect_uri mismatch"
**Cause:** The redirect URI in Google Cloud doesn't match Supabase's callback URL
**Fix:** Go to Google Cloud → Credentials → your OAuth client → add `https://hrbophzmwuhmzylbjuge.supabase.co/auth/v1/callback` to Authorized redirect URIs

### "Could not find table public.profiles"
**Cause:** SQL setup script hasn't been run
**Fix:** Run `supabase_setup.sql` in Supabase SQL Editor

### "Cannot coerce result to single JSON object"
**Cause:** Profile row doesn't exist for the current user (common for OAuth signups before SQL was run)
**Fix:** Run this in Supabase SQL Editor:
```sql
insert into public.profiles (id, name, status_emoji, status_text)
values ('YOUR_USER_ID', 'Your Name', '👋', 'Just joined Pulse!')
on conflict (id) do nothing;
```
Replace `YOUR_USER_ID` with your UUID from Supabase → Authentication → Users

### Email rate limit exceeded
**Cause:** Supabase free tier limits OTP emails to 3/hour
**Fix:** Configure custom SMTP using Resend (see Section 13 — SMTP Configuration)

### Notifications not showing
**Cause:** Permission not granted, or app not installed as PWA
**Fix:**
1. Make sure you clicked the notification permission banner in the app
2. On iPhone, notifications only work when installed as a PWA (Add to Home Screen)
3. Check browser notification settings — make sure Pulse is not blocked

### Supabase project paused
**Cause:** Free tier projects pause after 1 week of inactivity
**Fix:** Go to Supabase dashboard → click your project → click "Resume project"
**Prevention:** Log in to Supabase at least once a week, or upgrade to Pro plan

---

## Quick Reference

| Task | Where |
|---|---|
| View live app | https://pulse-gray-eight.vercel.app |
| View source code | https://github.com/Kalabduke/Pulse |
| Supabase dashboard | https://supabase.com/dashboard/project/hrbophzmwuhmzylbjuge |
| Vercel dashboard | https://vercel.com/kalabduke-8825s-projects |
| Google Cloud console | https://console.cloud.google.com (project: arcane-grin-431207-p8) |
| Resend dashboard | https://resend.com |

---

*Documentation generated May 2026 — Pulse v1.0.0*
