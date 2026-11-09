import { useEffect, useRef, useState } from "react";

export type LiveStatus = "connecting" | "live" | "offline";

/**
 * Subscribes to /ws and calls `onEvent` for every server event. Reconnects
 * with capped exponential backoff, and fires a synthetic "resync" event
 * after each reconnect so the caller can refetch anything it missed.
 */
export function useLive(onEvent: (event: { type: string }) => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        if (attempt > 0) handler.current({ type: "resync" });
        attempt = 0;
        setStatus("live");
      };
      ws.onmessage = (m) => {
        try {
          handler.current(JSON.parse(String(m.data)));
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setStatus("offline");
        const delay = Math.min(10_000, 500 * 2 ** attempt++);
        timer = setTimeout(connect, delay);
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return status;
}
