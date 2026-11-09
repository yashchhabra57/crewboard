import type { SwapRequest } from "./domain/swaps.js";

export type LiveEvent =
  | { type: "hello"; clients: number }
  | { type: "schedule.updated"; reason: string }
  | { type: "swap.updated"; swap: SwapRequest };

export interface Broadcaster {
  broadcast(event: LiveEvent): void;
}

/** Minimal shape of a WebSocket we need, so tests can pass fakes. */
export interface LiveSocket {
  readyState: number;
  send(data: string): void;
  on(event: "close", listener: () => void): void;
}

const OPEN = 1;

/**
 * Fan-out hub for connected dashboards. Every state change on the server
 * is pushed as a small typed event; clients refetch what they need. This
 * keeps the protocol tiny and means a missed message is harmless: the
 * next event or a reconnect brings the client back in sync.
 */
export class LiveHub implements Broadcaster {
  private readonly sockets = new Set<LiveSocket>();

  get size(): number {
    return this.sockets.size;
  }

  add(socket: LiveSocket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    this.send(socket, { type: "hello", clients: this.sockets.size });
  }

  broadcast(event: LiveEvent): void {
    for (const s of this.sockets) this.send(s, event);
  }

  private send(socket: LiveSocket, event: LiveEvent): void {
    if (socket.readyState !== OPEN) return;
    try {
      socket.send(JSON.stringify(event));
    } catch {
      this.sockets.delete(socket);
    }
  }
}
