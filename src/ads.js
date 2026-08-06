/* ==========================================
   ADS — Monetization slot (above Friends' Status History)
   ==========================================
   Two ad networks, one slot:

   • Web (Vercel/browser)  → Google AdSense (responsive in-flow banner)
   • Android APK            → Google AdMob   (adaptive banner, top-center)

   HOW TO GO LIVE (do this in order):
   1. Create an AdSense account (https://adsense.google.com) and get your
      Publisher ID:  ca-pub-XXXXXXXXXXXXXXXX
      Wait for site approval, then create an ad unit → get the data-ad-slot.
   2. Create an AdMob account (https://admob.google.com), add your Android
      app (package com.pulse.statusapp), get the App ID:
      ca-app-pub-XXXXXXXXXXXXXXXX~XXXXXXXXXX
      and create a Banner ad unit → get its ID.
   3. Paste the real IDs below AND in AndroidManifest.xml
      (com.google.android.gms.ads.APPLICATION_ID). Both must be updated
      together — the config gates initialization, the manifest supplies the
      ID AdMob validates, so enabling one without the other crashes the app.
   4. Set enableWebAds / enableNativeAds to true.

   IMPORTANT (APK crash): the AndroidManifest AdMob App ID must ALWAYS be a
   valid ca-app-pub-NNN~NNN format — the SDK's auto-init provider reads it at
   app process START and kills the app if it's a placeholder. The manifest
   currently holds Google's official TEST App ID (ca-app-pub-3940256099942544~3347511713)
   so the APK launches with ads still disabled. Swap BOTH the manifest value
   and ADS_CONFIG.admob.appId to your real App ID when going live.

   DEV PREVIEW: set devMode to true to load Google's official test ad unit IDs
   and see the slot render before you're approved. Never ship with devMode on.

   Until real IDs are configured, the slot stays hidden and nothing loads.
*/

export const ADS_CONFIG = {
  // Web — Google AdSense
  enableWebAds: false,
  adsense: {
    clientId: 'ca-pub-XXXXXXXXXXXXXXXX', // Publisher ID
    adSlot: 'XXXXXXXXXX'                 // Ad unit slot ID
  },

  // Android — Google AdMob
  enableNativeAds: false,
  admob: {
    // Mirrors the AndroidManifest value — must stay a VALID format or the
    // AdMob SDK crashes the APK at process start. Test ID = no crash + ads off.
    appId: 'ca-app-pub-3940256099942544~3347511713', // App ID (also in AndroidManifest)
    bannerAdUnitId: 'ca-app-pub-XXXXXXXXXXXXXXXX/XXXXXXXXXX' // Banner ad unit
  },

  // Dev preview: Google's official TEST ad IDs (always render a test banner).
  // Set to true to preview the slot; must be false in production.
  devMode: false
};

function isConfigured() {
  return ADS_CONFIG.adsense.clientId.startsWith('ca-pub-') &&
    !ADS_CONFIG.adsense.clientId.includes('XXXX') &&
    !ADS_CONFIG.adsense.adSlot.includes('XXX');
}

let _adsInited = false;

/* Attach the AdSense loader script once (web only). */
function loadAdSenseScript() {
  return new Promise((resolve) => {
    if (window.__adsenseScriptLoaded) return resolve();
    window.__adsenseScriptLoaded = true;
    const s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADS_CONFIG.adsense.clientId}`;
    s.onload = () => resolve();
    s.onerror = () => resolve();
    document.head.appendChild(s);
  });
}

/* Fill the in-flow slot with a responsive AdSense unit (web only). */
async function renderWebAd() {
  const slot = document.getElementById('ad-slot');
  if (!slot) return;

  // Blank until the owner configures + is approved by AdSense
  if (!ADS_CONFIG.enableWebAds || !isConfigured()) return;

  await loadAdSenseScript();
  slot.style.display = 'block';
  slot.innerHTML = `
    <div class="ad-label">Sponsored</div>
    <ins class="adsbygoogle"
         style="display:block"
         data-ad-client="${ADS_CONFIG.adsense.clientId}"
         data-ad-slot="${ADS_CONFIG.adsense.adSlot}"
         data-ad-format="auto"
         data-full-width-responsive="true"></ins>`;
  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  } catch (err) {
    console.warn('[Pulse] AdSense push failed:', err);
  }
}

/* Show a native AdMob banner (Android only).
   NOTE: AdMob banners are native screen overlays, NOT in-flow like the web
   slot — we anchor it at the bottom so it never covers the app header. */
async function renderNativeAd() {
  if (!window.Capacitor?.isNativePlatform()) return;
  const testMode = ADS_CONFIG.devMode;
  const appReady = ADS_CONFIG.enableNativeAds &&
      !ADS_CONFIG.admob.appId.includes('XXX') &&
      !ADS_CONFIG.admob.bannerAdUnitId.includes('XXX');
  if (!testMode && !appReady) return;

  try {
    const { AdMob, BannerAdPosition, BannerAdSize } = await import('@capacitor-community/admob');
    await AdMob.initialize();
    await AdMob.requestTrackingAuthorization().catch(() => {});
    await AdMob.showBanner({
      // Official Google test unit — renders a test banner in devMode
      adId: testMode ? 'ca-app-pub-3940256099942544/6300978111' : ADS_CONFIG.admob.bannerAdUnitId,
      position: BannerAdPosition.BOTTOM_CENTER,
      adSize: BannerAdSize.ADAPTIVE_BANNER,
      margin: 8,
      isTesting: testMode
    });
  } catch (err) {
    console.warn('[Pulse] AdMob init failed:', err);
  }
}

/* Entry point — call once the dashboard is visible. Idempotent. */
export async function initAds() {
  if (_adsInited) return;
  _adsInited = true;
  try {
    if (window.Capacitor?.isNativePlatform()) {
      await renderNativeAd();
    } else {
      await renderWebAd();
    }
  } catch (err) {
    console.warn('[Pulse] Ads init failed:', err);
  }
}
