import { LumiChat } from "@/components/kid/chat/lumi-chat";

/**
 * R1-05 minimal web children's client (issue #17, Roadmap R1-05).
 *
 * The kid home is now the Lumi conversation surface (touch + keyboard,
 * streaming replies, stop, retry, clear, visible exit path) served by the
 * formal interaction API (POST /api/v1/interactions + SSE + cancel). The
 * frozen prototype math tool stays available, re-homed under /kid/playground.
 */
export default function KidPage() {
  return (
    <section className="space-y-4">
      <LumiChat />
    </section>
  );
}
