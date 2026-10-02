import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./globals.css";
import App from "@/components/App";

// The control panel is its own chunk, fetched the first time it is opened;
// so are the first-run setup and the help page.
const ControlPanel = lazy(() => import("./pages/dev/settings/page"));
const SetupPage = lazy(() => import("./pages/setup/page"));
const HelpPage = lazy(() => import("./pages/help/page"));

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
          <Route
            path="/setup"
            element={
              <main>
                <SetupPage />
              </main>
            }
          />
          <Route
            path="/help"
            element={
              <main>
                <HelpPage />
              </main>
            }
          />
          <Route path="/dev/settings" element={<Navigate to="/control" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>,
);
