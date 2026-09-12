import React, { useState } from "react";
import {
  AuthProvider, ToastProvider, ModalProvider, useAuth,
  Sidebar, NotifBell, BrandMark, CursorGlow, CardSpotlight,
} from "./components.jsx";
import { LoginScreen, ForcedResetScreen, PAGES } from "./pages.jsx";

function AppShell() {
  const { user, mustReset, checking } = useAuth();
  const [view, setView] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (checking) {
    return <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}>Loading…</div>;
  }

  if (!user) {
    return <LoginScreen onLoggedIn={() => {}} />;
  }

  if (mustReset) {
    return <ForcedResetScreen onDone={() => { setView("dashboard"); }} />;
  }

  const Page = PAGES[view] || PAGES.dashboard;

  return (
    <div id="app-shell">
      <Sidebar view={view} setView={setView} sidebarOpen={sidebarOpen} closeSidebar={() => setSidebarOpen(false)} />
      {sidebarOpen ? <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} /> : null}
      <div className="main-col">
        <header className="topbar">
          <button className="hamburger-btn" onClick={() => setSidebarOpen((o) => !o)}>☰</button>
          <div className="topbar-brand"><BrandMark /></div>
          <NotifBell />
        </header>
        <main className="content">
          <div className="page-fade" key={view}>
            <Page navTo={setView} />
          </div>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <ModalProvider>
          <CursorGlow />
          <CardSpotlight />
          <AppShell />
        </ModalProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
