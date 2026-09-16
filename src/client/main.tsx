import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./globals.css";
import App from "@/components/App";
import Profile from "./pages/Profile";

// The operator console is its own chunks, fetched only when someone opens
// /dev/*: every visitor used to download it inside the main bundle.
const DevSettings = lazy(() => import("./pages/dev/settings/page"));
const DevChat = lazy(() => import("./pages/dev/Chat"));

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
          <Route path="/u/:ign" element={<Profile />} />
          <Route path="/dev/settings" element={<DevSettings />} />
          <Route path="/dev/chat" element={<DevChat />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>,
);
