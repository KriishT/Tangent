import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import CaptureOverlay from "./windows/CaptureOverlay";
import MainApp from "./MainApp";
import "./styles.css";

const label = getCurrentWindow().label;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{label === "capture" ? <CaptureOverlay /> : <MainApp />}</React.StrictMode>
);
