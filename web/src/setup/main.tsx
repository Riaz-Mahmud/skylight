import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LocationWizard } from "../components/LocationWizard.js";
import "leaflet/dist/leaflet.css";
import "../styles/setup.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocationWizard />
  </StrictMode>,
);
