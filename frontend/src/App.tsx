import { Routes, Route } from "react-router-dom";
import { PastCallsPage } from "./pages/PastCallsPage";
import { CallReviewPage } from "./pages/CallReviewPage";
import { Placeholder } from "./pages/Placeholder";

function App() {
  return (
    <Routes>
      <Route path="/" element={<PastCallsPage />} />
      <Route path="/new" element={<Placeholder title="New call" />} />
      <Route path="/call/:id" element={<CallReviewPage />} />
      <Route path="*" element={<Placeholder title="Not found" />} />
    </Routes>
  );
}

export default App;
