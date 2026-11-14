import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import './styles/global.css';

// Split per route so phones only download the small controller bundle.
const Host = lazy(() => import('./pages/Host.jsx'));
const Play = lazy(() => import('./pages/Play.jsx'));
const Admin = lazy(() => import('./pages/Admin.jsx'));

function Home() {
  return (
    <main className="home fx-scanlines">
      <h1 className="glitch" data-text="SENTIENT">SENTIENT</h1>
      <p className="muted">an interactive short film · one leader decides</p>
      <nav className="home__links">
        <Link to="/host">/host — main screen</Link>
        <Link to="/admin">/admin — story editor</Link>
        <Link to="/host?debug=1">/host?debug=1 — host with force-start</Link>
      </nav>
      <p className="muted small">The leader joins by scanning the QR code on the host screen.</p>
    </main>
  );
}

// GitHub Pages build (VITE_PAGES=1): static hosting, no game server, so only the editor exists.
const PAGES = import.meta.env.VITE_PAGES === '1';
const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

createRoot(document.getElementById('root')).render(
  <BrowserRouter basename={basename}>
    <Suspense fallback={<div className="boot-fallback">LOADING…</div>}>
      {PAGES ? (
        <Routes>
          <Route path="*" element={<Admin />} />
        </Routes>
      ) : (
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/host" element={<Host />} />
        <Route path="/play" element={<Play />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="*" element={<Home />} />
      </Routes>
      )}
    </Suspense>
  </BrowserRouter>,
);
