// The Install button. Browsers that can install web apps from a page (Chrome,
// Edge and others built on Chromium, on computers and Android) offer it with a
// beforeinstallprompt event; the button keeps that offer and shows the
// browser's install dialog when clicked. Safari has no such event, so there
// the button says how to do it from Safari's own menus: Share, then Add to
// Home Screen on iPhone and iPad, or File > Add to Dock on a Mac. Elsewhere
// (Firefox), and once the app is installed or running as one, it stays hidden.
//
//   setupInstall(button, help)   help(message) shows the instructions

export function setupInstall(button, help) {
  const installed = () => matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)').matches
    || navigator.standalone === true;
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\//.test(ua);
  let offer = null;

  button.hidden = installed() || !(ios || safari);
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();                       // keep the offer for the button, rather than the browser's own banner
    offer = e;
    button.hidden = installed();
  });
  window.addEventListener('appinstalled', () => { offer = null; button.hidden = true; });

  button.addEventListener('click', async () => {
    if (offer) {
      const o = offer;
      offer = null;
      await o.prompt();
      const { outcome } = await o.userChoice;
      if (outcome === 'accepted') button.hidden = true;
      return;
    }
    if (ios) help('To install: tap the Share button, then Add to Home Screen.');
    else if (safari) help('To install: in Safari, choose File › Add to Dock.');
    else help('This browser can\'t install web apps. Try Chrome, Edge or Safari.');
  });
}
