import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Widget Integration Preview",
  robots: {
    index: false,
    follow: false,
  },
};

export default function EmbedPreviewPage() {
  return (
    <main className="min-h-screen bg-white px-6 py-16 font-sans text-[#173f39] sm:px-10">
      <section className="mx-auto max-w-5xl">
        <p className="text-sm font-semibold text-[#007f73]">Integration preview</p>
        <h1 className="mt-4 max-w-2xl text-3xl font-semibold leading-tight sm:text-4xl">
          A neutral host page for testing the embedded assistant.
        </h1>
        <p className="mt-5 max-w-xl text-base leading-7 text-[#53746d]">
          The page represents WordPress. The chat interface is loaded independently through the public widget script.
        </p>
      </section>

      <script src="/widget.js?v=1" data-site="the-well" async />
    </main>
  );
}
