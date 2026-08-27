import { useEffect, type ReactNode } from "react";
import { dismissSplashScreen } from "crucible";

export const metadata = {
  title: "Relay Local",
  backgroundColor: "#101216",
  themeColor: "#101216",
};

export default function Layout({ children }: { children: ReactNode }) {
  useEffect(() => {
    dismissSplashScreen();
  }, []);

  return children;
}
