import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Diagnostics } from "./Diagnostics.js";
import "../styles/diagnostics.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Diagnostics />
  </StrictMode>,
);
