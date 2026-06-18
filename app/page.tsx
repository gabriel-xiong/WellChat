import ChatWidget from "@/components/ChatWidget";

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f4faf7] px-6 py-12 font-sans text-[#173f39] sm:px-10">
      <section className="mx-auto flex min-h-[calc(100vh-6rem)] max-w-5xl flex-col justify-center gap-8">
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-full bg-[#00B5A3] text-sm font-semibold text-white">
            TW
          </div>
          <div>
            <p className="text-sm font-semibold text-[#007f73]">The Well Austin</p>
            <p className="text-xs text-[#66827c]">Assistant preview</p>
          </div>
        </div>

        <div className="max-w-2xl">
          <h1 className="text-4xl font-semibold leading-tight tracking-normal text-[#123f39] sm:text-5xl">
            Your questions about The Well, answered.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-[#53746d] sm:text-lg">
            Answers are grounded in website content and include links to relevant sources.
          </p>
        </div>

        <div className="grid gap-3 text-sm text-[#315d56] sm:grid-cols-3">
          <div className="rounded-2xl border border-[#d9ebe6] bg-white/70 p-4">
            Sundays and visits
          </div>
          <div className="rounded-2xl border border-[#d9ebe6] bg-white/70 p-4">
            Serving and giving
          </div>
          <div className="rounded-2xl border border-[#d9ebe6] bg-white/70 p-4">
            Events and ministries
          </div>
        </div>
      </section>
      <ChatWidget />
    </main>
  );
}
