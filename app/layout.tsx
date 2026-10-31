import type { Metadata } from "next";
import { ChatProvider } from "@/components/ChatProvider";
import "./theme.css";

export const metadata: Metadata = { title: "Ask about this candidate" };

// The page title ("Ask about <name>") comes from the profile, so app/page.tsx
// renders it as a <title> once the corpus is read. Cache Components forbids
// reading the corpus in generateMetadata().
// ChatProvider keeps the conversation in memory above the pages, so it survives client navigation
// to /about or /how-it-works and back; a full reload starts a fresh chat.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <ChatProvider>{children}</ChatProvider>
      </body>
    </html>
  );
}
