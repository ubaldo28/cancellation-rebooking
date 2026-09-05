/*
 * Slotfill service worker.
 *
 * It exists for one reason: a push message cannot be delivered to a page, only
 * to a worker, so without this file the openings alerts have nowhere to land.
 * It caches nothing and intercepts no requests — there is no offline story
 * here, and a caching worker that gets it wrong serves a stale price.
 *
 * Served from the origin root so its scope is the whole site: a notification
 * clicked from anywhere can find and focus any tab.
 */

// Take over straight away rather than waiting for every tab to close. A worker
// stuck in "waiting" cannot receive a push, and someone who just pressed
// "turn on notifications" would get nothing until they closed the browser.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/**
 * An opening appeared.
 *
 * The Worker sends {title, body, url, tag} as JSON. Every field is treated as
 * missing-until-proven-present: a malformed payload must still show something,
 * because the browser will show its own "This site has been updated in the
 * background" notice if we do not, and that is worse than a plain one.
 */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {};
  }

  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Slotfill';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const url = typeof payload.url === 'string' && payload.url ? payload.url : '/';
  // The tag collapses repeats: a second push about the same opening replaces
  // the first rather than stacking another line on the lock screen.
  const tag = typeof payload.tag === 'string' && payload.tag ? payload.tag : 'slotfill';

  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    data: { url },
  }));
});

/**
 * Opening what the notification was about.
 *
 * If a tab is already on that page, focus it — opening a second copy of a page
 * somebody already has is how you end up with four of them.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const raw = (event.notification.data && event.notification.data.url) || '/';
  const target = new URL(raw, self.location.origin);

  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const tab of tabs) {
      if (new URL(tab.url).pathname === target.pathname) {
        await tab.focus();
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
