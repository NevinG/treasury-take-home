import { useState } from "react";
import { VerifyFlow } from "./components/VerifyFlow";

const DEMO_EMBED = "https://www.youtube.com/embed/vwD5Muu5__o";

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(() => !localStorage.getItem("welcomeSeen"));
  const [offline, setOffline] = useState(() => localStorage.getItem("offline") === "true");

  function setOfflineMode(v: boolean) {
    setOffline(v);
    localStorage.setItem("offline", String(v));
  }

  function closeWelcome() {
    localStorage.setItem("welcomeSeen", "1");
    setWelcomeOpen(false);
  }

  return (
    <>
      <header className="app-header">
        <button className="demo-btn" onClick={() => setWelcomeOpen(true)}>▶ Demo</button>
        <h1>TTB Label Verification</h1>
        <button className="settings-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
        {offline && <span className="offline-pill" title="Running the local engine — no cloud calls">Offline</span>}
      </header>

      <div className="container">
        <VerifyFlow offline={offline} />
      </div>

      {welcomeOpen && (
        <div className="modal-backdrop" onClick={closeWelcome}>
          <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
            <h3>Welcome — how to use this app</h3>
            <p className="hint">
              A quick walkthrough of verifying a label. Use the video's full-screen button for a closer
              look, or close this to get started.
            </p>
            <div className="video-wrap">
              <iframe
                src={DEMO_EMBED}
                title="Demo — how to use the TTB Label Verification app"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
              />
            </div>
            <div className="actions">
              <button className="btn" onClick={closeWelcome}>Got it</button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Settings</h3>
            <label className="toggle-row">
              <input type="checkbox" checked={offline} onChange={(e) => setOfflineMode(e.target.checked)} />
              <span>
                <strong>Offline mode</strong>
                <span className="hint" style={{ display: "block" }}>
                  Use the on-device engine (local OCR + parser). No cloud API calls or outbound network
                  traffic — lower accuracy, useful where cloud endpoints are blocked.
                </span>
              </span>
            </label>
            <div className="actions">
              <button className="btn" onClick={() => setSettingsOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
