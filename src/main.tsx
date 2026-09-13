import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import CaptureOverlay from "./windows/CaptureOverlay";
import MainApp from "./MainApp";
import "./styles.css";

const label = getCurrentWindow().label;
if (label === "capture") {
  const html = document.documentElement;
  const body = document.body;
  html.classList.add("capture-window");
  body.classList.add("capture-window");
  html.removeAttribute("data-theme");
  // Dark color-scheme makes WKWebView paint an opaque black rectangle
  // around the HUD even when CSS backgrounds are transparent.
  html.style.colorScheme = "only light";
  html.style.background = "transparent";
  html.style.backgroundColor = "transparent";
  body.style.colorScheme = "only light";
  body.style.background = "transparent";
  body.style.backgroundColor = "transparent";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{label === "capture" ? <CaptureOverlay /> : <MainApp />}</React.StrictMode>
);
