import { useState } from "react";
import { VerifyFlow } from "./components/VerifyFlow";

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [offline, setOffline] = useState(() => localStorage.getItem("offline") === "true");

  function setOfflineMode(v: boolean) {
    setOffline(v);
    localStorage.setItem("offline", String(v));
  }

  return (
    <>
      <header className="app-header">
        <h1>TTB Label Verification</h1>
        <button className="settings-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
        {offline && <span className="offline-pill" title="Running the local engine — no cloud calls">Offline</span>}
      </header>

      <div className="container">
        <VerifyFlow offline={offline} />
      </div>

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
