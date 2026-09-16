import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./globals.css";
import App from "@/components/App";

// The control panel is its own chunk, fetched the first time it is opened.
const ControlPanel = lazy(() => import("./pages/dev/settings/page"));

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Suspense fallback={null}>
        <Routes>
          <Route
            path="/"
            element={
              <main>
                <App />
              </main>
            }
          />
          <Route
            path="/control"
            element={
              <main>
                <ControlPanel />
              </main>
            }
          />
          <Route path="/dev/settings" element={<Navigate to="/control" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>,
);
