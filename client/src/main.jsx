import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.jsx";
import "./index.css";

let updateSWFn = null;
updateSWFn = registerSW({
  immediate: true,
  onNeedRefresh() {
    // If an old cached index.html points to missing hashed assets,
    // force-update SW and reload to recover from a "black screen".
    try {
      void updateSWFn?.(true);
    } catch (_) {}
  },
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
