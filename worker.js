import { DurableObject } from "cloudflare:workers";

// Lớp Durable Object: chịu trách nhiệm quản lý trạng thái của một phòng
export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async fetch(request) {
    // Xử lý yêu cầu WebSocket, đồng bộ nước đi của người chơi
    // Logic cụ thể cần bạn triển khai theo cách chơi của game
    return new Response("Game Room Ready");
  }
}

// Lớp Worker chính: nhận yêu cầu từ trình duyệt và chuyển đến phòng tương ứng
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Ví dụ lấy ID phòng từ tham số URL, mặc định là "default"
    const roomId = url.searchParams.get("room") || "default";

    // Lấy thể hiện Durable Object
    const id = env.GAME_ROOM.idFromName(roomId);
    const stub = env.GAME_ROOM.get(id);

    // Chuyển yêu cầu đến Durable Object
    return stub.fetch(request);
  },
};
