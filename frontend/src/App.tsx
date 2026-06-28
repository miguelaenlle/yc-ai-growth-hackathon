import { Routes, Route } from "react-router-dom";
import { PastCallsPage } from "./pages/PastCallsPage";
import { CallReviewPage } from "./pages/CallReviewPage";
import { RecordingsPage } from "./pages/RecordingsPage";
import { SimulateCallPage } from "./pages/SimulateCallPage";
import { WatchAiPage } from "./pages/WatchAiPage";
import { LiveCallPage } from "./pages/LiveCallPage";
import { Placeholder } from "./pages/Placeholder";

function App() {
  return (
    <Routes>
      <Route path="/" element={<PastCallsPage />} />
      <Route path="/new" element={<LiveCallPage />} />
      <Route path="/call/:id" element={<CallReviewPage />} />
      <Route path="/call/:id/recordings" element={<RecordingsPage />} />
      <Route path="/call/:id/simulate" element={<SimulateCallPage />} />
      <Route path="/call/:id/watch" element={<WatchAiPage />} />
      <Route path="*" element={<Placeholder title="Not found" />} />
    </Routes>
  );
}

export default App;
