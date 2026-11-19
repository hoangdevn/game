import { DurableObject } from "cloudflare:workers";

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async fetch(request) {
    // 1. Kiểm tra header Upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    // 2. Tạo cặp WebSocket
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // 3. Chấp nhận kết nối (Bắt buộc phải có)
    server.accept();

    // 4. Xử lý tin nhắn (Echo lại để test)
    server.addEventListener('message', event => {
      server.send(`Server nhận được: ${event.data}`);
    });

    // 5. Trả về Response 101 để hoàn tất handshake
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const roomId = url.searchParams.get("room") || "default";
    const id = env.GAME_ROOM.idFromName(roomId);
    const stub = env.GAME_ROOM.get(id);
    return stub.fetch(request);
  },
};
