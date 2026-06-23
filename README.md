<div align="center">
<h1>⚡ Pulse</h1>
<p><strong>A real-time emotional and health status sharing app for close friends.</strong></p>
<p>
  <a href="https://pulse-gray-eight.vercel.app" target="_blank"><img src="https://img.shields.io/badge/Live%20Demo-3B82F6?style=for-the-badge&logo=vercel&logoColor=white" alt="Live Demo" /></a>
  <a href="https://github.com/Kalabduke/Pulse"><img src="https://img.shields.io/badge/GitHub-EF4444?style=for-the-badge&logo=github&logoColor=white" alt="GitHub" /></a>
  <img src="https://img.shields.io/badge/Vite-3B82F6?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/Supabase-EF4444?style=for-the-badge&logo=supabase&logoColor=white" alt="Supabase" />
  <img src="https://img.shields.io/badge/PWA-3B82F6?style=for-the-badge&logo=pwa&logoColor=white" alt="PWA" />
</p>
<p><em>Private, intimate "what are you up to right now" — not a social feed, but a live presence indicator for your closest people.</em></p>
</div>
📸 Preview
<div align="center">
  <img src="https://via.placeholder.com/800x400/0f172a/3b82f6?text=Pulse+App+Screenshot+-+Add+Your+Own" alt="Pulse Preview" width="80%" />
  <p><em>Replace with screenshots of your app</em></p>
</div>
✨ Features
🔐 Authentication
Email/Password — sign up and log in securely
Google OAuth — one-tap sign in with Google
Session persistence with auto-refresh tokens
💬 Real-Time Status Sharing
Emoji Status Picker — 6 categories (Mood, Health, Activity, Nature, Food, Travel) with 50+ emojis each
Custom Emoji Input — type or paste any emoji
Status Text — custom message (e.g., "Coding deep", "Feeling tired")
Instant Sync — friends see updates without refreshing
👥 Friend Connections
Connect with up to 5 friends using Pulse ID or display name
Nicknames — give friends custom names only you can see
Status History — view your last 15 status updates with timestamps
🔔 Notifications
Pop-up heads-up notification — appears at the top like Telegram/Snapchat
Persistent lockscreen notification — stays in tray as a live widget
Notification permission banner — non-intrusive in-app prompt
📱 PWA (Progressive Web App)
Install to home screen — works on Android, iOS, and desktop like a native app
Offline support — app shell cached by service worker
Background sync — syncs when connection is restored
Custom Pulse waveform icon (192×192 and 512×512)
🛠️ Tech Stack
Table
Layer	Technology	Purpose
Frontend	Vite + Vanilla JS	Fast build, no framework overhead
Styling	Vanilla CSS	Dark-mode glassmorphism design
Database	Supabase (PostgreSQL)	Profiles, connections, status history
Real-time	Supabase Realtime	WebSocket subscriptions for live updates
Auth	Supabase Auth	Email/password + Google OAuth
Hosting	Vercel	Auto-deploys from GitHub
PWA	Web App Manifest + Service Worker	Install as app, offline, notifications
Email	Resend.com	Transactional emails via Supabase SMTP
📁 Project Structure
plain
pulse/
├── index.html                  # Main HTML — all views/screens
├── vite.config.js              # Vite build configuration
├── vercel.json                 # Vercel deployment + headers
├── package.json                # Dependencies and scripts
├── .gitignore                  # Git exclusions
├── supabase_setup.sql          # Full database setup script
├── src/
│   ├── main.js                 # App logic, routing, events
│   ├── style.css               # All styles and design tokens
│   └── supabase.js             # Supabase client + API functions
└── public/
    ├── manifest.json           # PWA manifest
    ├── sw.js                   # Service Worker
    ├── logo.svg                # SVG logo
    ├── icon-192.png            # Home screen icon
    ├── icon-512.png            # Splash screen icon
    └── notification-icon.png   # Notification badge
🚀 Getting Started
Prerequisites
Node.js 18+
Git
Supabase account (free)
Vercel account (free)
1. Clone & Install
bash
git clone https://github.com/Kalabduke/Pulse.git
cd Pulse
npm install
2. Environment Variables
Create .env.local:
bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key_here
3. Run Locally
bash
npm run dev
# Opens at http://localhost:3000
4. Build for Production
bash
npm run build
# Output goes to /dist
🗄️ Database Schema
profiles Table
Table
Column	Type	Description
id	uuid (PK)	References auth.users.id
name	text	Display name
status_emoji	text	Current emoji
status_text	text	Current status message
updated_at	timestamptz	Last status change
connections Table
Table
Column	Type	Description
id	uuid (PK)	Auto-generated
user_id	uuid (FK)	Who sent the invite
friend_id	uuid (FK)	Who received it
status	text	pending or connected
nickname	text	Custom nickname (private)
created_at	timestamptz	Creation timestamp
status_history Table
Table
Column	Type	Description
id	uuid (PK)	Auto-generated
user_id	uuid (FK)	References profiles.id
status_emoji	text	Emoji at update time
status_text	text	Status text at update time
created_at	timestamptz	When this status was set
Auto-trim trigger keeps status_history at max 15 rows per user.
🔒 Row Level Security (RLS)
Users can only update their own profile
Users can only view connections they are part of
Users can only view status history of connected friends
🔄 Real-Time Sync Flow
plain
User A updates status
        ↓
Supabase UPDATE on profiles table
        ↓
Supabase Realtime WebSocket broadcasts
        ↓
User B's app receives event
        ↓
Checks if User A is a connected friend
        ↓
If yes:
  ✅ Updates friend card instantly
  ✅ Shows toast notification in-app
  ✅ Sends message to Service Worker
        ↓
Service Worker shows:
  1. Pop-up heads-up notification (buzzes)
  2. Persistent lockscreen notification (silent)
📱 Installing as PWA
Android (Chrome)
Open app in Chrome
Tap 3-dot menu (⋮) → "Add to Home Screen"
Tap "Install"
iPhone (Safari)
Open app in Safari
Tap Share button (□↑)
Tap "Add to Home Screen"
Desktop (Chrome/Edge)
Look for the install icon (⊕) in the address bar and click it.
🌐 Deployment
Vercel auto-deploys on every git push to main:
bash
git add .
git commit -m "Your changes"
git push
# Vercel redeploys within 30-60 seconds
Manual deploy: Go to vercel.com → your Pulse project → Redeploy.
📝 License
This project is open source and available under the MIT License.
<div align="center">
Built with ❤️ by <a href="https://github.com/Kalabduke">
<p>
  <a href="https://pulse-gray-eight.vercel.app">🌐 Live App</a> •
  <a href="https://github.com/Kalabduke/Pulse">💻 Source</a>
</p>
</div>
