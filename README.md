# MY DRYBEA — Free Mobile Web App

This package is prepared for free public hosting with GitHub Pages.

Files:
- index.html — app
- logo.jpg — DRYBEA logo
- manifest.json — installable mobile/PWA configuration
- sw.js — basic offline cache/service worker

Important:
- The app currently stores state, history, orders and customers in the browser's localStorage.
- That means each phone/browser has its own data; this is NOT a shared cloud database.
- The app also uses external CDN/API resources, so some online features still require internet.
