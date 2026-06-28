import { Routes, Route, Link } from "react-router-dom";
import { SellerPage } from "./pages/SellerPage";
import { BuyerPage } from "./pages/BuyerPage";
import { SessionPage } from "./pages/SessionPage";

function Home() {
  return (
    <div style={{ padding: 40, fontFamily: "sans-serif" }}>
      <h1>Live Call Test Harness</h1>

      <div style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, color: "#374151", marginBottom: 8 }}>Single tab (recommended)</h2>
        <p style={{ color: "#6b7280", marginBottom: 16, fontSize: 14 }}>
          One tab. Select seller and buyer mics. One WebSocket, full coaching overlay.
        </p>
        <Link to="/session/rec_live1">
          <button style={btnStyle("#2563eb")}>Open Session</button>
        </Link>
      </div>

      <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 24 }}>
        <h2 style={{ fontSize: 16, color: "#374151", marginBottom: 8 }}>Two-tab mode (legacy)</h2>
        <p style={{ color: "#6b7280", marginBottom: 16, fontSize: 14 }}>
          Open seller and buyer in separate tabs with the same <code>recordingId</code>.
        </p>
        <div style={{ display: "flex", gap: 12 }}>
          <Link to="/seller/rec_live1">
            <button style={btnStyle("#6b7280")}>Open as Seller</button>
          </Link>
          <Link to="/buyer/rec_live1">
            <button style={btnStyle("#6b7280")}>Open as Buyer</button>
          </Link>
        </div>
      </div>

      <p style={{ marginTop: 24, color: "#9ca3af", fontSize: 13 }}>
        Default recordingId: <code>rec_live1</code> — change the URL path to use a different one.
      </p>
    </div>
  );
}

const btnStyle = (bg: string): React.CSSProperties => ({
  padding: "12px 24px",
  background: bg,
  color: "white",
  border: "none",
  borderRadius: 8,
  fontSize: 16,
  cursor: "pointer",
});

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/session/:recordingId" element={<SessionPage />} />
      <Route path="/seller/:recordingId" element={<SellerPage />} />
      <Route path="/buyer/:recordingId" element={<BuyerPage />} />
    </Routes>
  );
}
