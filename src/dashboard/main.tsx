import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DashboardApp } from "./app.js";
const root = document.getElementById("root");
if (!root) throw new Error("dashboard root missing");
createRoot(root).render(
  <StrictMode>
    <DashboardApp />
  </StrictMode>,
);
