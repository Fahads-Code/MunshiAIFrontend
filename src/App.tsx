import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Login from "./pages/Login";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import SmartBusinessAssistant from "./pages/SmartBusinessAssistant";

const App = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/home" element={<Home />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/assistant" element={<SmartBusinessAssistant />} />
        
        {/* Main path / ko /home par redirect karein */}
        <Route path="/" element={<Navigate to="/home" replace />} />
        
        {/* Koi bhi unknown path ho toh /login par redirect karein */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
};

export default App;