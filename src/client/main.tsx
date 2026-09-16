import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./globals.css";
import App from "@/components/App";

// The operator console is its own chunks, fetched only when someone opens
// /dev/*: every visitor used to download it inside the main bundle.
const DevSettings = lazy(() => import("./pages/dev/settings/page"));

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
          <Route path="/dev/settings" element={<DevSettings />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>,
);
