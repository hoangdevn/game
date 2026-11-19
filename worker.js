import { DurableObject } from "cloudflare:workers";

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.clients = new Map(); // ws -> { ws, userId, roomCode }
    this.rooms = new Map();   // code -> room object
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const url = new URL(request.url);
    const uidParam = url.searchParams.get("uid") || `tdck-${Date.now()}`;

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();

    const clientInfo = {
      ws: server,
      userId: uidParam,
      roomCode: null,
    };
    this.clients.set(server, clientInfo);

    server.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(clientInfo, msg);
      } catch (err) {
        // Bỏ qua gói tin không phải JSON
      }
    });

    server.addEventListener("close", () => {
      this.handleDisconnect(clientInfo);
    });

    server.addEventListener("error", () => {
      this.handleDisconnect(clientInfo);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  send(ws, payload) {
    if (!ws) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      // Socket đã đóng
    }
  }

  getWaitingQueueCount() {
    let count = 0;
    for (const room of this.rooms.values()) {
      if (room.isRandomQueue && room.status === "waiting") {
        count++;
      }
    }
    return count;
  }

  broadcastQueueCount() {
    const count = this.getWaitingQueueCount();
    for (const info of this.clients.values()) {
      this.send(info.ws, { type: "QUEUE_COUNT", count });
    }
  }

  generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    do {
      code = "";
      for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  serializeRoom(room) {
    return {
      code: room.code,
      hostId: room.hostId,
      hostChar: room.hostChar,
      guestId: room.guestId,
      guestChar: room.guestChar,
      stage: room.stage,
      status: room.status,
      matchState: {
        rematchSeq: room.rematchSeq || 0,
      },
    };
  }

  handleMessage(clientInfo, msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "HELLO": {
        if (msg.userId) clientInfo.userId = msg.userId;
        this.send(clientInfo.ws, {
          type: "WELCOME",
          userId: clientInfo.userId,
          waitingCount: this.getWaitingQueueCount(),
        });
        break;
      }

      case "PING": {
        this.send(clientInfo.ws, { type: "PONG", ts: msg.ts });
        break;
      }

      case "GET_QUEUE_COUNT": {
        this.send(clientInfo.ws, {
          type: "QUEUE_COUNT",
          count: this.getWaitingQueueCount(),
        });
        break;
      }

      case "CREATE_ROOM": {
        this.leaveCurrentRoom(clientInfo, true);
        const code = (msg.code || this.generateRoomCode()).toUpperCase();
        if (this.rooms.has(code)) {
          this.send(clientInfo.ws, {
            type: "ERROR",
            message: `Mã phòng "${code}" đang được sử dụng, vui lòng tạo lại.`,
          });
          return;
        }

        const room = {
          code,
          hostWs: clientInfo.ws,
          hostId: msg.userId || clientInfo.userId,
          hostChar: msg.hostChar || "chu_teu",
          guestWs: null,
          guestId: null,
          guestChar: null,
          stage: msg.stage || "lang_co",
          isRandomQueue: Boolean(msg.isRandomQueue),
          status: "waiting",
          rematchSeq: 0,
        };

        this.rooms.set(code, room);
        clientInfo.roomCode = code;

        this.send(clientInfo.ws, {
          type: "ROOM_CREATED",
          code,
          isRandomQueue: room.isRandomQueue,
        });
        this.broadcastQueueCount();
        break;
      }

      case "RANDOM_MATCH": {
        this.leaveCurrentRoom(clientInfo, true);
        const myId = msg.userId || clientInfo.userId;

        // Tìm phòng chờ ngẫu nhiên đang mở của người khác
        let matchedRoom = null;
        for (const room of this.rooms.values()) {
          if (
            room.isRandomQueue &&
            room.status === "waiting" &&
            room.hostWs !== clientInfo.ws
          ) {
            matchedRoom = room;
            break;
          }
        }

        if (matchedRoom) {
          matchedRoom.guestWs = clientInfo.ws;
          matchedRoom.guestId = myId;
          matchedRoom.guestChar = msg.char || "than_long";
          matchedRoom.status = "playing";
          clientInfo.roomCode = matchedRoom.code;

          const roomData = this.serializeRoom(matchedRoom);
          this.send(matchedRoom.hostWs, {
            type: "MATCH_START",
            role: "host",
            room: roomData,
          });
          this.send(matchedRoom.guestWs, {
            type: "MATCH_START",
            role: "guest",
            room: roomData,
          });
          this.broadcastQueueCount();
        } else {
          // Chưa có ai chờ -> Tự tạo phòng chờ ngẫu nhiên mới
          const code = this.generateRoomCode();
          const room = {
            code,
            hostWs: clientInfo.ws,
            hostId: myId,
            hostChar: msg.char || "chu_teu",
            guestWs: null,
            guestId: null,
            guestChar: null,
            stage: msg.stage || "lang_co",
            isRandomQueue: true,
            status: "waiting",
            rematchSeq: 0,
          };

          this.rooms.set(code, room);
          clientInfo.roomCode = code;

          this.send(clientInfo.ws, {
            type: "ROOM_CREATED",
            code,
            isRandomQueue: true,
          });
          this.broadcastQueueCount();
        }
        break;
      }

      case "JOIN_ROOM": {
        this.leaveCurrentRoom(clientInfo, true);
        const code = (msg.code || "").trim().toUpperCase();
        const room = this.rooms.get(code);

        if (!room) {
          this.send(clientInfo.ws, {
            type: "ERROR",
            message: `Không tìm thấy phòng có mã "${code}".`,
          });
          return;
        }
        if (room.status !== "waiting" || room.guestWs) {
          this.send(clientInfo.ws, {
            type: "ERROR",
            message: `Phòng "${code}" đã đủ người hoặc đang thi đấu.`,
          });
          return;
        }
        if (room.hostWs === clientInfo.ws) {
          this.send(clientInfo.ws, {
            type: "ERROR",
            message: "Bạn không thể tự vào phòng của chính mình.",
          });
          return;
        }

        room.guestWs = clientInfo.ws;
        room.guestId = msg.userId || clientInfo.userId;
        room.guestChar = msg.guestChar || "than_long";
        room.status = "playing";
        clientInfo.roomCode = code;

        const roomData = this.serializeRoom(room);
        this.send(room.hostWs, {
          type: "MATCH_START",
          role: "host",
          room: roomData,
        });
        this.send(room.guestWs, {
          type: "MATCH_START",
          role: "guest",
          room: roomData,
        });
        this.broadcastQueueCount();
        break;
      }

      case "SYNC_STATE":
      case "ACTION":
      case "HAZARD":
      case "MATCH_END": {
        const room = this.rooms.get(clientInfo.roomCode || msg.code);
        if (!room) return;
        const targetWs =
          room.hostWs === clientInfo.ws ? room.guestWs : room.hostWs;
        this.send(targetWs, msg);
        break;
      }

      case "REMATCH": {
        const room = this.rooms.get(clientInfo.roomCode || msg.code);
        if (!room) return;
        room.rematchSeq = Math.max((room.rematchSeq || 0) + 1, msg.rematchSeq || 1);
        const payload = {
          type: "REMATCH",
          rematchSeq: room.rematchSeq,
          room: this.serializeRoom(room),
        };
        this.send(room.hostWs, payload);
        this.send(room.guestWs, payload);
        break;
      }

      case "LEAVE_ROOM": {
        this.leaveCurrentRoom(clientInfo, true);
        break;
      }
    }
  }

  leaveCurrentRoom(clientInfo, notifyOther) {
    const code = clientInfo.roomCode;
    if (!code) return;
    clientInfo.roomCode = null;

    const room = this.rooms.get(code);
    if (!room) return;

    const otherWs = room.hostWs === clientInfo.ws ? room.guestWs : room.hostWs;
    this.rooms.delete(code);

    if (otherWs) {
      const otherInfo = this.clients.get(otherWs);
      if (otherInfo) otherInfo.roomCode = null;
      if (notifyOther) {
        this.send(otherWs, {
          type: "OPPONENT_LEFT",
          message: "🚪 Đối thủ đã rời khỏi phòng đấu.",
        });
      }
    }

    this.broadcastQueueCount();
  }

  handleDisconnect(clientInfo) {
    this.leaveCurrentRoom(clientInfo, true);
    this.clients.delete(clientInfo.ws);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get("Upgrade");

    if (
      url.pathname === "/ws" ||
      (upgradeHeader && upgradeHeader.toLowerCase() === "websocket")
    ) {
      // Đưa toàn bộ người chơi vào chung 1 sảnh điều phối để ghép phòng & ghép ngẫu nhiên
      const id = env.GAME_ROOM.idFromName("global-lobby");
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};
