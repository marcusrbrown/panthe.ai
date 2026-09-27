import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Scene } from "./Scene";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found");
}

createRoot(container).render(
  <StrictMode>
    <Scene />
  </StrictMode>,
);
