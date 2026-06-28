import { Routes, Route } from "react-router-dom";
import { PastCallsPage } from "./pages/PastCallsPage";
import { Placeholder } from "./pages/Placeholder";

function App() {
  return (
    <Routes>
      <Route path="/" element={<PastCallsPage />} />
      <Route path="/new" element={<Placeholder title="New call" />} />
      <Route path="/calls/:id" element={<Placeholder title="Call review" />} />
      <Route path="*" element={<Placeholder title="Not found" />} />
    </Routes>
  );
}

export default App;
