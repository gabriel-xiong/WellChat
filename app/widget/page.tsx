import type { Metadata } from "next";
import ChatWidget from "@/components/ChatWidget";

export const metadata: Metadata = {
  title: "The Well Website Assistant",
  description: "The Well Austin website assistant widget.",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function WidgetPage({
  searchParams,
}: {
  searchParams: Promise<{ compact?: string }>;
}) {
  const { compact } = await searchParams;

  return (
    <main className="fixed inset-0 overflow-hidden bg-transparent" aria-label="The Well website assistant">
      <style>{`html, body { background: transparent !important; overflow: hidden; color-scheme: light; }`}</style>
      <ChatWidget embedded compactLauncher={compact === "1"} />
    </main>
  );
}
