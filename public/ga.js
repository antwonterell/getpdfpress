// Google Analytics 4 loader for getPDFpress.
// To enable: replace the empty GA_MEASUREMENT_ID below with your GA4 ID (looks like "G-XXXXXXXXXX").
// Until then this file does nothing, so it is safe to ship.
(function () {
  var GA_MEASUREMENT_ID = "";
  if (!GA_MEASUREMENT_ID) return;
  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_MEASUREMENT_ID;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA_MEASUREMENT_ID, { anonymize_ip: true });
})();
