# Home Instead Email Notifications

Email notifications for Home Instead activity logs from the UniqueIQ portal.

## Problem

The UniqueIQ client/family portal lets you view care notes and activity logs, but you have to manually log in to check for updates. There's no built-in email notification when carers complete their visits and log activities.

## Solution

This scraper:
- Logs into the UniqueIQ portal automatically
- Fetches the activity log for the current day
- Sends a nicely formatted HTML email when there are updates
- Tracks what's been sent to avoid duplicate emails
- Runs via cron every 10 minutes to catch updates throughout the day

## Setup

1. Clone the repo and install dependencies:
```bash
npm install
npx playwright install chromium
```

2. Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

3. Configure your `.env`:
```
SITE_URL=https://portal.uniqueiq.co.uk/Account/Login?ReturnUrl=%2f
USERNAME=your-portal-email
PASSWORD=your-portal-password

EMAIL_TO=recipient@example.com
EMAIL_FROM=sender@example.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=your-app-password
```

For Gmail, you'll need an [App Password](https://myaccount.google.com/apppasswords) (requires 2FA enabled).

## Usage

### Check today's activity log
```bash
node scraper.js
```

### Check a specific date
```bash
node scraper.js -f 15/01/2026
```

### Check a date range (sends one email per day)
```bash
node scraper.js -f 01/01/2026 -t 15/01/2026
```

### Force resend (ignore tracking)
```bash
node scraper.js --force
```

## Cron Setup

Add to crontab to run every 10 minutes:
```bash
crontab -e
```

Add this line:
```
*/10 * * * * /path/to/run-scraper.sh
```

The wrapper script (`run-scraper.sh`) handles killing any hung previous instance before starting a new one.

## Files

- `scraper.js` - Main scraper script
- `run-scraper.sh` - Cron wrapper with kill logic
- `sent-emails.json` - Tracks sent emails (auto-created)
- `scraper.log` - Execution log (auto-created)

## License

MIT
