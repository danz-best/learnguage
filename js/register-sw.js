// Register the service worker so the app works fully offline once installed.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.log('Service worker registration failed:', err);
    });
  });
}
