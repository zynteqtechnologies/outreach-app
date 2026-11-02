# Outreach App - setup (10 minutes)

1. Install Node.js 18+ from nodejs.org
2. In this folder run:  npm install
3. Copy `.env.example` to `.env` and fill it in:
   - LOGIN_EMAIL and LOGIN_PASSWORD: your one and only login for the app
   - SESSION_SECRET: any long random text
   - SMTP_*: your NEW Zoho app password (use smtp.zoho.in if your Zoho is .in)
   - ANTHROPIC_API_KEY: your Claude API key
   - GOOGLE_PLACES_API_KEY: for "Find clients" (Google Cloud > enable "Places API (New)")
4. Run:  npm start   then open http://localhost:3000 and sign in.
5. Settings tab: set business type, city, emails per day, send time, your name, company, service.
6. Drafts tab: "Find clients" > "Make drafts" > read/edit > "Send all".

Screens: Login, Drafts, Sent, Leads (search + Mark unsubscribed), Settings.
Every day at your send time (India time) the app finds clients and makes drafts while it is running.
Import CSV is optional (columns: name,email,website,category,city,notes).

Put it online (Render, Railway or a VPS) to use it from your phone 24/7: keep data.json on a
persistent disk, set the same .env values there, open the URL on your phone and choose
"Add to Home Screen". Use HTTPS only.

Start with 5-10 emails a day. Check SPF, DKIM and DMARC in Zoho first. Never share your .env file.
