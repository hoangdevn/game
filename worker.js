import { DurableObject } from "cloudflare:workers";

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async fetch(request) {
    return new Response("Game Room Ready");
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const roomId = url.searchParams.get("room") || "default";

    // Kiểm tra xem binding GAME_ROOM đã được khai báo trong wrangler.toml chưa
    if (!env.GAME_ROOM) {
        return new Response("Lỗi: Chưa khai báo Durable Object GAME_ROOM trong wrangler.toml", { status: 500 });
    }

    const id = env.GAME_ROOM.idFromName(roomId);
    const stub = env.GAME_ROOM.get(id);

    return stub.fetch(request);
  },
};
