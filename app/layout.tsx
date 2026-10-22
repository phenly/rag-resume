import type { Metadata } from "next";
import "./theme.css";

export const metadata: Metadata = { title: "Ask about this candidate" };

// The page title ("Ask about <name>") comes from the profile, so app/page.tsx
// renders it as a <title> once the corpus is read. Cache Components forbids
// reading the corpus in generateMetadata().
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
