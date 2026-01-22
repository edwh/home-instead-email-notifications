# Home Instead Email Notifications

Email notifications for Home Instead care services - activity logs and schedule summaries.

## Features

### 1. Activity Log Notifications (scraper.js)

The UniqueIQ client/family portal lets you view care notes and activity logs, but you have to manually log in to check for updates. This scraper:
- Logs into the UniqueIQ portal automatically
- Fetches the activity log for the current day
- Sends a nicely formatted HTML email when there are updates
- Tracks what's been sent to avoid duplicate emails
- Runs via cron every 10 minutes to catch updates throughout the day

### 2. Schedule Notifications (schedule-notify.js)

Parses timesheet PDF attachments from Home Instead emails and sends a daily summary:
- Shows carer schedule for the next 7 days
- Merges data from multiple timesheet emails for complete coverage
- Alerts if there's a coverage gap (>2 hours between 9am-6pm)
- Alerts if no timesheet data exists for upcoming days
- Subject line shows today's carers with times (e.g., "Laura 09:00-13:00, Sulayha 13:00-18:00")

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

### Send schedule summary
```bash
node schedule-notify.js
```

## Cron Setup

Add to crontab:
```bash
crontab -e
```

Add these lines:
```
# Activity log - every 10 minutes
*/10 * * * * /path/to/run-scraper.sh

# Schedule summary - daily at 7am
0 7 * * * /path/to/run-schedule-notify.sh
```

The wrapper scripts handle logging and (for the scraper) killing any hung previous instance.

## Configuration

Optional settings in `.env` for schedule notifications:

```bash
# Coverage gap detection
COVERAGE_START_HOUR=9          # Start of coverage period (default: 9)
COVERAGE_END_HOUR=18           # End of coverage period (default: 18)
COVERAGE_MAX_GAP_MINUTES=120   # Max gap before alert (default: 120 = 2 hours)

# Missing timesheet alert
MISSING_DATA_ALERT_DAYS=4      # Alert if no data within X days (default: 4)
```

## Files

- `scraper.js` - Activity log scraper
- `schedule-notify.js` - Schedule notification from timesheet emails
- `run-scraper.sh` - Cron wrapper for scraper (with kill logic)
- `run-schedule-notify.sh` - Cron wrapper for schedule notifications
- `sent-emails.json` - Tracks sent activity emails (auto-created)
- `scraper.log` - Scraper execution log (auto-created)
- `schedule-notify.log` - Schedule notification log (auto-created)

## License

MIT
