/**
 * Escalation scheduler — checks every 15 min whether the night check-in
 * is overdue, ratchets up the level/tone, and fires push notifications.
 */

const cron = require('node-cron');
const webpush = require('web-push');
const db = require('./db');

// Escalation messages — indexed by level 0-4
// Level 0 = first nudge, 4 = nuclear
const MESSAGES = [
  {
    title: "Hey — night check-in",
    body: "Quick one. Log tomorrow's plan before you crash."
  },
  {
    title: "Still waiting on you",
    body: "Night check-in isn't done. Takes 2 minutes. Do it."
  },
  {
    title: "You're ignoring this",
    body: "That's exactly what past-you said he wouldn't do. Check in."
  },
  {
    title: "Bro. Check in.",
    body: "No plan = no accountability. You know this. Open the app."
  },
  {
    title: "This is embarrassing",
    body: "You built an accountability app and you're dodging it. Open it right now."
  }
];

// Interval between notifications at each level (minutes)
const INTERVALS = [60, 45, 30, 20, 15];

function todayString() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function getDeadlineMs() {
  // Default 11 PM — user can override via settings
  const deadlineStr = db.get('night_checkin_deadline', '23:00');
  const [h, m] = deadlineStr.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

async function sendPush(title, body) {
  const subs = db.getAllSubscriptions();
  if (!subs.length) return;

  const payload = JSON.stringify({ title, body, url: '/' });

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        payload
      );
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired — clean up
        db.removeSubscription(sub.endpoint);
      } else {
        console.error('Push error:', err.message);
      }
    }
  }
}

function initScheduler() {
  // Configure web-push with VAPID keys
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    console.warn('VAPID keys not set — push notifications disabled. Run generateVapidKeys() and set env vars.');
    return;
  }

  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'tannerbrock.web@gmail.com'}`,
    publicKey,
    privateKey
  );

  // Morning AI digest push at 7 AM
  cron.schedule('0 7 * * *', async () => {
    const today = todayString();
    try {
      // Try cache first; if not there, skip (will be generated when user opens app)
      const cached = db.getDigest(today);
      if (cached && cached.overview) {
        const snippet = cached.overview.length > 140
          ? cached.overview.slice(0, 137) + '...'
          : cached.overview;
        await sendPush('🤖 Daily AI Digest', snippet);
        console.log('[scheduler] Morning digest push sent');
      }
    } catch (err) {
      console.error('[scheduler] Morning digest push error:', err.message);
    }
  });

  // Check every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    const today = todayString();
    const now = Date.now();
    const deadline = getDeadlineMs();

    // If we're before the deadline, do nothing
    if (now < deadline) return;

    // If night check-in already done today, reset escalation and bail
    const done = db.getCheckin('night', today);
    if (done) {
      db.setEscalationState(today, 0, 0);
      return;
    }

    // Load or init escalation state
    let state = db.getEscalationState(today);
    if (!state || state.date !== today) {
      db.setEscalationState(today, 0, now);
      state = { date: today, level: 0, last_notif: now };
      const msg = MESSAGES[0];
      await sendPush(msg.title, msg.body);
      console.log(`[escalation] level 0 notification sent`);
      return;
    }

    const intervalMs = INTERVALS[Math.min(state.level, INTERVALS.length - 1)] * 60 * 1000;
    if (now - state.last_notif < intervalMs) return; // Not time yet

    const nextLevel = Math.min(state.level + 1, MESSAGES.length - 1);
    db.setEscalationState(today, nextLevel, now);

    const msg = MESSAGES[nextLevel];
    await sendPush(msg.title, msg.body);
    console.log(`[escalation] level ${nextLevel} notification sent`);
  });

  console.log('[scheduler] Escalation scheduler running (check every 15 min)');
}

function generateVapidKeys() {
  const keys = webpush.generateVAPIDKeys();
  console.log('VAPID Public Key:', keys.publicKey);
  console.log('VAPID Private Key:', keys.privateKey);
  return keys;
}

module.exports = { initScheduler, generateVapidKeys };
