require('dotenv').config();
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const fs = require('fs');

// PDF parsing using pdfjs-dist
async function extractTextFromPDF(buffer) {
  const pdfjs = require('pdfjs-dist');
  const uint8Array = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({ data: uint8Array }).promise;

  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map(item => item.str);
    text += strings.join(' ') + '\n';
  }

  return text;
}

const SENDER = 'enquiries.bolton@homeinstead.co.uk';

function connectImap() {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: process.env.SMTP_USER,
      password: process.env.SMTP_PASS,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }
    });

    imap.once('ready', () => resolve(imap));
    imap.once('error', reject);
    imap.connect();
  });
}

function openBox(imap, boxName) {
  return new Promise((resolve, reject) => {
    imap.openBox(boxName, true, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

function search(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });
}

function fetchMessage(imap, uid) {
  return new Promise((resolve, reject) => {
    const fetch = imap.fetch(uid, { bodies: '' });
    let buffer = '';

    fetch.on('message', (msg) => {
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
        });
      });
    });

    fetch.once('error', reject);
    fetch.once('end', () => resolve(buffer));
  });
}

function parseScheduleFromPDF(text) {
  const schedule = {};

  const datePattern = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*-\s*(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/gi;
  const visitPattern = /(\d{2}:\d{2})\s+(\d{2}:\d{2})\s+(\d{2}:\d{2}h)\s+([A-Za-z]+,\s*[A-Za-z]+)/g;

  const dates = [];
  let match;

  datePattern.lastIndex = 0;
  while ((match = datePattern.exec(text)) !== null) {
    const [fullMatch, dayName, day, month, year] = match;
    const monthNum = new Date(`${month} 1, 2000`).getMonth();
    const date = new Date(parseInt(year), monthNum, parseInt(day));
    dates.push({
      date,
      dayName,
      dateKey: date.toISOString().split('T')[0],
      startPosition: match.index,
      endPosition: match.index + fullMatch.length
    });
  }

  for (let i = 0; i < dates.length; i++) {
    const { date, dayName, dateKey, endPosition } = dates[i];
    // Use start of next date header as boundary (not end position minus offset)
    const nextPosition = dates[i + 1]?.startPosition || text.length;

    const sectionText = text.substring(endPosition, nextPosition);
    const visits = [];

    visitPattern.lastIndex = 0;
    let visitMatch;
    while ((visitMatch = visitPattern.exec(sectionText)) !== null) {
      const [, start, end, duration, caregiver] = visitMatch;
      visits.push({ start, end, duration, caregiver: caregiver.trim() });
    }

    schedule[dateKey] = { date, dayName, visits };
  }

  return schedule;
}

function formatDateShort(date) {
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatDateLong(date) {
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function getCarerSummary(visits) {
  if (!visits || visits.length === 0) return 'No visits';
  // Use first name (after comma) instead of surname
  const carers = [...new Set(visits.map(v => {
    const parts = v.caregiver.split(',');
    return parts[1]?.trim() || parts[0];
  }))];
  return carers.join(', ');
}

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function checkCoverageGaps(visits) {
  // Check for gaps between configured hours (defaults: 9am-6pm, max gap 2 hours)
  const START_OF_DAY = parseInt(process.env.COVERAGE_START_HOUR || '9') * 60;
  const END_OF_DAY = parseInt(process.env.COVERAGE_END_HOUR || '18') * 60;
  const MAX_GAP = parseInt(process.env.COVERAGE_MAX_GAP_MINUTES || '120');

  if (!visits || visits.length === 0) {
    // No visits = full gap
    return { hasGap: true, gapMinutes: END_OF_DAY - START_OF_DAY };
  }

  // Sort visits by start time
  const sorted = [...visits].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));

  let gaps = [];

  // Check gap from 9am to first visit
  const firstStart = timeToMinutes(sorted[0].start);
  if (firstStart > START_OF_DAY) {
    const gap = firstStart - START_OF_DAY;
    if (gap > MAX_GAP) gaps.push(gap);
  }

  // Check gaps between visits
  for (let i = 0; i < sorted.length - 1; i++) {
    const endOfCurrent = timeToMinutes(sorted[i].end);
    const startOfNext = timeToMinutes(sorted[i + 1].start);
    if (startOfNext > endOfCurrent) {
      const gap = startOfNext - endOfCurrent;
      if (gap > MAX_GAP) gaps.push(gap);
    }
  }

  // Check gap from last visit to 6pm
  const lastEnd = timeToMinutes(sorted[sorted.length - 1].end);
  if (lastEnd < END_OF_DAY) {
    const gap = END_OF_DAY - lastEnd;
    if (gap > MAX_GAP) gaps.push(gap);
  }

  return {
    hasGap: gaps.length > 0,
    gapMinutes: gaps.length > 0 ? Math.max(...gaps) : 0
  };
}

function formatScheduleEmail(schedule, today) {
  const todayKey = today.toISOString().split('T')[0];
  const todaySchedule = schedule[todayKey];

  // Get next 7 days from today
  const next7Days = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    next7Days.push(date.toISOString().split('T')[0]);
  }

  // Filter schedule to only next 7 days that have data
  const sortedDates = next7Days.filter(dateKey => schedule[dateKey]);

  // Check for coverage gaps across all days
  let hasAnyGap = false;
  let gapDays = [];
  for (const dateKey of sortedDates) {
    const dayData = schedule[dateKey];
    const gapCheck = checkCoverageGaps(dayData.visits);
    if (gapCheck.hasGap) {
      hasAnyGap = true;
      gapDays.push(formatDateShort(dayData.date));
    }
  }

  // Build subject summary for today with times
  let subjectSummary;
  if (todaySchedule && todaySchedule.visits.length > 0) {
    const visitSummaries = todaySchedule.visits.map(v => {
      const firstName = v.caregiver.split(',')[1]?.trim() || v.caregiver.split(',')[0];
      return `${firstName} ${v.start}-${v.end}`;
    });
    subjectSummary = `Today: ${visitSummaries.join(', ')}`;
  } else {
    subjectSummary = 'No visits today';
  }

  // Add gap alert to subject if needed
  let gapAlert = '';
  if (hasAnyGap) {
    gapAlert = ' ⚠️ COVERAGE GAP';
  }

  // Plain text version
  let text = `Care Schedule\n${'='.repeat(50)}\n\n`;

  for (const dateKey of sortedDates) {
    const dayData = schedule[dateKey];
    const isToday = dateKey === todayKey;
    const label = isToday ? '>>> TODAY <<<' : formatDateShort(dayData.date);

    text += `${label} - ${formatDateLong(dayData.date)}\n`;
    if (dayData.visits.length > 0) {
      for (const v of dayData.visits) {
        text += `  ${v.start}-${v.end}  ${v.caregiver}\n`;
      }
    } else {
      text += '  No visits scheduled\n';
    }
    text += '\n';
  }

  // HTML version
  let html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5;">
  <table width="600" style="margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <tr>
      <td style="background: linear-gradient(135deg, #6b2c91 0%, #9b59b6 100%); padding: 30px; text-align: center;">
        <h1 style="margin: 0; color: white; font-size: 24px;">Care Schedule</h1>
        <p style="margin: 10px 0 0 0; color: #d5a6e6; font-size: 14px;">Week Overview</p>
      </td>
    </tr>
    <tr>
      <td style="padding: 20px;">`;

  for (const dateKey of sortedDates) {
    const dayData = schedule[dateKey];
    const isToday = dateKey === todayKey;
    const gapCheck = checkCoverageGaps(dayData.visits);
    const hasGap = gapCheck.hasGap;

    const bgColor = hasGap ? '#fff5f5' : (isToday ? '#f3e8ff' : '#fff');
    const borderColor = hasGap ? '#e53e3e' : (isToday ? '#9b59b6' : '#e2e8f0');
    const headerBg = hasGap ? '#fed7d7' : (isToday ? '#9b59b6' : '#f7f3f9');
    const headerColor = hasGap ? '#c53030' : (isToday ? 'white' : '#6b2c91');
    const gapWarning = hasGap ? ` ⚠️ Gap: ${Math.round(gapCheck.gapMinutes / 60)}h ${gapCheck.gapMinutes % 60}m` : '';

    html += `
        <table width="100%" style="margin-bottom: 15px; border: 2px solid ${borderColor}; border-radius: 8px; overflow: hidden; background: ${bgColor};">
          <tr>
            <td style="background: ${headerBg}; padding: 12px 15px;">
              <span style="font-weight: 600; color: ${headerColor}; font-size: 16px;">
                ${isToday ? '📅 TODAY - ' : ''}${formatDateLong(dayData.date)}${gapWarning}
              </span>
            </td>
          </tr>`;

    if (dayData.visits.length > 0) {
      for (const v of dayData.visits) {
        html += `
          <tr>
            <td style="padding: 10px 15px; border-top: 1px solid ${borderColor};">
              <span style="color: #6b2c91; font-weight: 500;">${v.start} - ${v.end}</span>
              <span style="color: #4a5568; margin-left: 15px;">${v.caregiver}</span>
            </td>
          </tr>`;
      }
    } else {
      html += `
          <tr>
            <td style="padding: 10px 15px; color: #a0aec0; font-style: italic;">No visits scheduled</td>
          </tr>`;
    }

    html += `</table>`;
  }

  html += `
      </td>
    </tr>
    <tr>
      <td style="background: #f7f3f9; padding: 15px; text-align: center;">
        <p style="margin: 0; color: #888; font-size: 12px;">Home Instead Care Schedule</p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { text, html, subjectSummary, gapAlert, gapDays };
}

async function sendEmail(subject, content) {
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

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: recipients,
    subject,
    text: content.text,
    html: content.html
  });

  console.log(`Email sent to ${recipients.length} recipient(s)`);
}

async function main() {
  console.log('Connecting to Gmail IMAP...');
  const imap = await connectImap();

  try {
    await openBox(imap, '[Gmail]/All Mail');

    // Search for timesheet emails from last 30 days
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 30);
    const sinceDateStr = sinceDate.toISOString().split('T')[0].replace(/-/g, '-');

    console.log(`Searching for timesheet emails from ${SENDER} since ${sinceDateStr}...`);
    const uids = await search(imap, [['FROM', SENDER], ['SUBJECT', 'Timesheet'], ['SINCE', sinceDate]]);
    console.log(`Found ${uids.length} timesheet emails`);

    if (uids.length === 0) {
      console.log('No timesheet emails found');
      return;
    }

    const today = new Date();
    const todayKey = today.toISOString().split('T')[0];

    // Search through recent timesheets (most recent first) to find one covering today
    let bestSchedule = null;
    const recentUids = uids.slice(-5).reverse(); // Last 5, most recent first

    for (const uid of recentUids) {
      console.log(`Checking timesheet (UID: ${uid})...`);

      const rawEmail = await fetchMessage(imap, uid);
      const parsed = await simpleParser(rawEmail);

      const pdfAttachment = parsed.attachments?.find(
        att => att.contentType === 'application/pdf' || att.filename?.toLowerCase().endsWith('.pdf')
      );

      if (!pdfAttachment) continue;

      const pdfText = await extractTextFromPDF(pdfAttachment.content);
      const schedule = parseScheduleFromPDF(pdfText);

      const scheduleDates = Object.keys(schedule);
      console.log(`  Covers: ${scheduleDates[0]} to ${scheduleDates[scheduleDates.length - 1]}`);

      // Check if this schedule covers today
      if (schedule[todayKey]) {
        console.log(`  Found schedule covering today!`);
        bestSchedule = schedule;
        break;
      }

      // Keep the most recent schedule as fallback
      if (!bestSchedule) {
        bestSchedule = schedule;
      }
    }

    if (!bestSchedule || Object.keys(bestSchedule).length === 0) {
      console.log('No schedule data found');
      return;
    }

    // Format and send email
    const content = formatScheduleEmail(bestSchedule, today);
    const subject = `Home Instead Schedule - ${content.subjectSummary}${content.gapAlert}`;

    if (content.gapDays.length > 0) {
      console.log(`Coverage gaps detected on: ${content.gapDays.join(', ')}`);
    }

    console.log(`\nSending: ${subject}`);
    await sendEmail(subject, content);

  } finally {
    imap.end();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
