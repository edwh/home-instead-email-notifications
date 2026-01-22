require('dotenv').config();
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Check Playwright is available
let chromium;
try {
  chromium = require('playwright').chromium;
} catch (err) {
  console.error('Error: Playwright not installed properly.');
  console.error('Run: npm install && npx playwright install chromium');
  process.exit(1);
}

const SENT_LOG_FILE = path.join(__dirname, 'sent-emails.json');

// Tracking functions for sent emails
function loadSentLog() {
  try {
    if (fs.existsSync(SENT_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(SENT_LOG_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading sent log:', e.message);
  }
  return {};
}

function saveSentLog(log) {
  fs.writeFileSync(SENT_LOG_FILE, JSON.stringify(log, null, 2));
}

function hashActivityLog(data) {
  // Create a hash of the activity content to detect changes
  const content = JSON.stringify(data.activities.map(a => ({
    task: a.TaskDescription,
    note: a.Note
  })));
  return crypto.createHash('md5').update(content).digest('hex');
}

function hasBeenSent(dateStr, hash, sentLog) {
  return sentLog[dateStr] === hash;
}

function markAsSent(dateStr, hash, sentLog) {
  sentLog[dateStr] = hash;
  saveSentLog(sentLog);
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const result = { fromDate: null, toDate: null, force: false };

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--from' || args[i] === '-f') && args[i + 1]) {
      result.fromDate = parseDate(args[i + 1]);
      i++;
    } else if ((args[i] === '--to' || args[i] === '-t') && args[i + 1]) {
      result.toDate = parseDate(args[i + 1]);
      i++;
    } else if (args[i] === '--force') {
      result.force = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node scraper.js [options]

Options:
  -f, --from DATE    Start date (DD/MM/YYYY or YYYY-MM-DD)
  -t, --to DATE      End date (DD/MM/YYYY or YYYY-MM-DD)
  --force            Send emails even if already sent (ignore tracking)
  -h, --help         Show this help

Examples:
  node scraper.js                              # Today only
  node scraper.js -f 01/01/2026                # Single date
  node scraper.js -f 01/01/2026 -t 07/01/2026  # Date range
  node scraper.js --force                      # Resend today's email
`);
      process.exit(0);
    }
  }

  // Default to today if no dates specified
  if (!result.fromDate) {
    result.fromDate = new Date();
  }
  if (!result.toDate) {
    result.toDate = result.fromDate;
  }

  return result;
}

function parseDate(str) {
  // Try DD/MM/YYYY format
  const ddmmyyyy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyy) {
    return new Date(parseInt(ddmmyyyy[3]), parseInt(ddmmyyyy[2]) - 1, parseInt(ddmmyyyy[1]));
  }

  // Try YYYY-MM-DD format
  const yyyymmdd = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (yyyymmdd) {
    return new Date(parseInt(yyyymmdd[1]), parseInt(yyyymmdd[2]) - 1, parseInt(yyyymmdd[3]));
  }

  console.error(`Invalid date format: ${str}. Use DD/MM/YYYY or YYYY-MM-DD`);
  process.exit(1);
}

function formatDateForUrl(date) {
  // Format as ISO string for the URL parameter
  const d = new Date(date);
  d.setHours(12, 0, 0, 0); // Set to noon to avoid timezone issues
  return d.toISOString();
}

function formatDateDisplay(date) {
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

function getDateRange(from, to) {
  const dates = [];
  const current = new Date(from);
  const end = new Date(to);

  while (current <= end) {
    dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, description, page) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt}/${MAX_RETRIES} failed for ${description}: ${error.message}`);

      if (attempt < MAX_RETRIES) {
        console.log(`Retrying in ${RETRY_DELAY / 1000} seconds...`);
        await sleep(RETRY_DELAY);
      }
    }
  }

  // All retries exhausted - send failure alert
  await sendFailureAlert(description, lastError);
  throw lastError;
}

async function sendFailureAlert(operation, error) {
  if (!process.env.SMTP_HOST) {
    console.error('Cannot send failure alert - SMTP not configured');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const recipients = process.env.EMAIL_TO.split(',').map(e => e.trim()).filter(e => e);
  const now = new Date().toLocaleString('en-GB');

  const subject = `⚠️ Activity Log Scraper FAILED - ${now}`;
  const text = `The activity log scraper failed after ${MAX_RETRIES} attempts.

Operation: ${operation}
Error: ${error.message}
Time: ${now}

Please check the scraper configuration and try again.`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5;">
  <table width="600" style="margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <tr>
      <td style="background: linear-gradient(135deg, #c53030 0%, #e53e3e 100%); padding: 30px; text-align: center;">
        <h1 style="margin: 0; color: white; font-size: 24px;">⚠️ Scraper Failed</h1>
      </td>
    </tr>
    <tr>
      <td style="padding: 30px;">
        <p style="color: #4a5568; margin: 0 0 15px 0;">The activity log scraper failed after <strong>${MAX_RETRIES}</strong> attempts.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr>
            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; color: #718096; width: 100px;">Operation:</td>
            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; color: #2d3748;">${escapeHtml(operation)}</td>
          </tr>
          <tr>
            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; color: #718096;">Error:</td>
            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; color: #c53030; font-family: monospace;">${escapeHtml(error.message)}</td>
          </tr>
          <tr>
            <td style="padding: 10px; color: #718096;">Time:</td>
            <td style="padding: 10px; color: #2d3748;">${now}</td>
          </tr>
        </table>
        <p style="color: #718096; margin: 20px 0 0 0; font-size: 14px;">Please check the scraper configuration and try again.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: recipients,
      subject,
      text,
      html
    });
    console.log('Failure alert email sent');
  } catch (e) {
    console.error('Failed to send failure alert:', e.message);
  }
}

async function login(page) {
  console.log('Logging in...');
  await page.goto(process.env.SITE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.fill('input[name="UserName"]', process.env.USERNAME);
  await page.fill('input[name="Password"]', process.env.PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  // Verify login success
  const url = page.url();
  if (url.includes('Login')) {
    throw new Error('Login failed - still on login page');
  }
  console.log('Login successful');
}

async function getActivityLog(page, date = null) {
  // Navigate directly to activity log for specific date
  let url = 'https://portal.uniqueiq.co.uk/MyTasks/ActivityLog';
  if (date) {
    url += `?ActivityStartDate=${formatDateForUrl(date)}`;
  }

  console.log(`Fetching activity log for ${date ? formatDateDisplay(date) : 'today'}...`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Get the date from the page title
  const dateHeader = await page.$eval('h3', el => el.textContent.trim());
  console.log('Page header:', dateHeader);

  // Extract the data from the Kendo grid's embedded JSON
  const pageContent = await page.content();

  // Find the JSON data in the script
  const dataMatch = pageContent.match(/"data":\{"Data":\[(.*?)\],"Total"/s);
  if (!dataMatch) {
    console.log('No activity data found in page');
    return { date: dateHeader, activities: [] };
  }

  try {
    const jsonStr = '[' + dataMatch[1] + ']';
    const activities = JSON.parse(jsonStr);
    console.log(`Found ${activities.length} activity entries`);
    return { date: dateHeader, activities };
  } catch (e) {
    console.log('Error parsing activity data:', e.message);

    // Fallback: parse from table rows
    const activities = await page.$$eval('#grdTaskResponse .k-grouping-row, #grdTaskResponse tr[data-uid]', rows => {
      const result = [];
      let currentTask = null;

      for (const row of rows) {
        if (row.classList.contains('k-grouping-row')) {
          // Task header row
          const taskText = row.querySelector('p')?.textContent?.trim() || '';
          currentTask = { TaskDescription: taskText, Note: '' };
        } else if (row.hasAttribute('data-uid')) {
          // Note row
          const note = row.querySelector('td[role="gridcell"]')?.textContent?.trim() || '';
          if (currentTask) {
            currentTask.Note = note;
            result.push({ ...currentTask });
          }
        }
      }
      return result;
    });

    console.log(`Fallback: Found ${activities.length} activity entries`);
    return { date: dateHeader, activities };
  }
}

function formatActivityLog(data) {
  if (data.activities.length === 0) {
    return null;
  }

  // Sort activities: "Activity Log" first, then others
  const sortedActivities = [...data.activities].sort((a, b) => {
    const aIsMain = a.TaskDescription.startsWith('Activity Log');
    const bIsMain = b.TaskDescription.startsWith('Activity Log');
    if (aIsMain && !bIsMain) return -1;
    if (!aIsMain && bIsMain) return 1;
    return 0;
  });

  // Plain text version
  let text = `${data.date}\n`;
  text += '='.repeat(50) + '\n\n';

  for (const activity of sortedActivities) {
    const taskName = activity.TaskDescription
      .replace(' Task is completed.', '')
      .replace(' Task is not completed.', '')
      .replace(' Task is ', ' - ')
      .trim();

    text += `* ${taskName}\n`;
    text += '-'.repeat(40) + '\n';
    const note = activity.Note || 'No notes';
    text += note + '\n\n';
  }

  // HTML version
  let html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 20px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #2c5282 0%, #4299e1 100%); padding: 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">Activity Log</h1>
              <p style="margin: 10px 0 0 0; color: #bee3f8; font-size: 16px;">${escapeHtml(data.date.replace('Activity Log for ', ''))}</p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 30px;">`;

  for (const activity of sortedActivities) {
    const taskName = activity.TaskDescription
      .replace(' Task is completed.', '')
      .replace(' Task is not completed.', '')
      .replace(' Task is ', ' - ')
      .trim();

    const isCompleted = activity.TaskDescription.includes('completed');
    const statusColor = isCompleted ? '#48bb78' : '#ed8936';
    const statusText = isCompleted ? 'Completed' : 'Pending';

    // Parse note to extract attribution (e.g., "by Laura on 22-01-2026 12:57")
    const note = activity.Note || 'No notes';
    const attrMatch = note.match(/\s+by\s+(\w+)\s+on\s+([\d-]+\s+[\d:]+)$/);
    let noteContent = note;
    let attribution = '';

    if (attrMatch) {
      noteContent = note.substring(0, note.length - attrMatch[0].length);
      attribution = `by ${attrMatch[1]} on ${attrMatch[2]}`;
    }

    html += `
              <!-- Task Card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                <tr>
                  <td style="background-color: #f7fafc; padding: 15px; border-bottom: 1px solid #e2e8f0;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td>
                          <span style="font-size: 16px; font-weight: 600; color: #2d3748;">${escapeHtml(taskName)}</span>
                        </td>
                        <td align="right">
                          <span style="display: inline-block; padding: 4px 12px; background-color: ${statusColor}; color: white; font-size: 12px; font-weight: 600; border-radius: 12px;">${statusText}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 15px;">
                    <p style="margin: 0; color: #4a5568; font-size: 14px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(noteContent.trim())}</p>
                    ${attribution ? `<p style="margin: 12px 0 0 0; color: #a0aec0; font-size: 12px; font-style: italic;">${escapeHtml(attribution)}</p>` : ''}
                  </td>
                </tr>
              </table>`;
  }

  html += `
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f7fafc; padding: 20px; text-align: center; border-top: 1px solid #e2e8f0;">
              <p style="margin: 0; color: #a0aec0; font-size: 12px;">This is an automated activity log notification</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { text, html };
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function sendEmail(subject, content) {
  if (!process.env.SMTP_HOST) {
    console.log('Email not configured - SMTP_HOST missing from .env');
    console.log('\nActivity Log Content:');
    console.log(content.text);

    // Save HTML preview
    fs.writeFileSync('email-preview.html', content.html);
    console.log('\nHTML preview saved to email-preview.html');
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  // Support comma-separated list of recipients
  const recipients = process.env.EMAIL_TO.split(',').map(e => e.trim()).filter(e => e);

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: recipients,
      subject: subject,
      text: content.text,
      html: content.html
    });
    console.log(`Email sent successfully to ${recipients.length} recipient(s)`);
    return true;
  } catch (error) {
    console.error('Failed to send email:', error.message);
    return false;
  }
}

async function processDate(page, date, sentLog, force = false) {
  const data = await getActivityLog(page, date);
  const dateStr = formatDateDisplay(date);

  if (data.activities.length === 0) {
    console.log(`No activity log entries for ${dateStr} - skipping`);
    return { sent: false, skipped: true };
  }

  // Check if already sent (unless force mode)
  const hash = hashActivityLog(data);
  if (!force && hasBeenSent(dateStr, hash, sentLog)) {
    console.log(`Activity log for ${dateStr} already sent (unchanged) - skipping`);
    return { sent: false, skipped: true, alreadySent: true };
  }

  const content = formatActivityLog(data);
  if (!content) {
    console.log('No content to send');
    return { sent: false, skipped: true };
  }

  // Build subject with date and current timestamp
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const subject = `Home Instead Activity Log Update - ${dateStr} (${timeStr})`;

  const emailSent = await sendEmail(subject, content);

  if (emailSent) {
    markAsSent(dateStr, hash, sentLog);
  }

  return { sent: emailSent, skipped: false };
}

async function runOnce(options) {
  const { fromDate, toDate, force } = options;
  const dates = getDateRange(fromDate, toDate);
  const sentLog = loadSentLog();

  console.log(`Processing ${dates.length} date(s): ${formatDateDisplay(fromDate)}${dates.length > 1 ? ` to ${formatDateDisplay(toDate)}` : ''}`);
  if (force) console.log('Force mode: will send even if already sent');
  console.log('');

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    if (err.message.includes('Executable doesn\'t exist') || err.message.includes('browserType.launch')) {
      console.error('Error: Playwright browser not installed.');
      console.error('Run: npx playwright install chromium');
      process.exit(1);
    }
    throw err;
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  let successCount = 0;
  let skipCount = 0;
  let alreadySentCount = 0;
  let errorCount = 0;

  try {
    // Login with retry
    await withRetry(
      () => login(page),
      'Login'
    );

    for (const date of dates) {
      try {
        // Process each date with retry
        const result = await withRetry(
          () => processDate(page, date, sentLog, force),
          `Fetch activity log for ${formatDateDisplay(date)}`
        );

        if (result.sent) {
          successCount++;
        } else if (result.alreadySent) {
          alreadySentCount++;
        } else {
          skipCount++;
        }

        // Small delay between requests to be polite
        if (dates.length > 1) {
          await page.waitForTimeout(1000);
        }
      } catch (error) {
        console.error(`Failed to process ${formatDateDisplay(date)} after ${MAX_RETRIES} attempts`);
        errorCount++;
      }
      console.log('');
    }

    console.log(`Done. Sent: ${successCount}, Already sent: ${alreadySentCount}, Skipped (empty): ${skipCount}, Errors: ${errorCount}`);

  } catch (error) {
    console.error('Fatal error:', error.message);
    throw error;
  } finally {
    await browser.close();
  }
}

async function main() {
  const options = parseArgs();
  await runOnce(options);
}

main();
