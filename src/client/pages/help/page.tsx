import SiteHeader from "@/components/SiteHeader";
import HelpPanel from "@/client/shared/HelpPanel";

// /help: the help page (Help in the top bar)
// (the desktop app's tray and the docs link here).
export default function HelpPage() {
  return (
    <>
      <SiteHeader />
      <h1 style={{ fontSize: 22, margin: "0 0 14px" }}>Help</h1>
      <HelpPanel />
    </>
  );
}
