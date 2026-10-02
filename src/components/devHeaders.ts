// Headers for /api/dev/* calls from outside the control panel's own tabs
// (the main page's Communism and Trading bookmarks). The panel keeps the
// password the owner typed in sessionStorage (client/pages/dev/settings);
// with no DEV_PASSWORD set it is empty and the server does not ask.
export const DEV_PASSWORD_KEY = "control_password";

export function devPassword(): string {
  try {
    return sessionStorage.getItem(DEV_PASSWORD_KEY) ?? "";
  } catch {
    return "";
  }
}

export function devHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = { "x-dev-password": devPassword() };
  if (json) h["Content-Type"] = "application/json";
  return h;
}
