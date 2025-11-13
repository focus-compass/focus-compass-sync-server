import { Server } from "@hocuspocus/server";
import { SQLite } from "@hocuspocus/extension-sqlite";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT ?? 8080);

const __dirname = dirname(fileURLToPath(import.meta.url));
const demoFilePath = join(__dirname, "index.html");
const AUTH_TOKEN = process.env.HOCUSPOCUS_TOKEN ?? "focus-compass-demo-token";
const vendorDir = join(__dirname, "vendor");

const MIME_TYPES = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const serveStaticFile = async (response, filePath) => {
  try {
    await stat(filePath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext.toLowerCase()] ?? "application/octet-stream";

    response.writeHead(200, { "Content-Type": contentType });
    createReadStream(filePath).pipe(response);
    return true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error(`❌ Ошибка при отдаче файла ${filePath}`, error);
    }
    return false;
  }
};

// Настройка сервера Hocuspocus
const server = new Server({
  // Порт, на котором будет слушать сервер (используется также в Dockerfile/docker-compose)
  port,
  
  // Список расширений
  extensions: [
    new SQLite({
      // Путь к базе данных SQLite (персистентное хранилище)
      // В Docker монтируется в /app/data volume
      database: "./data/db.sqlite",
    }),
  ],
  
  // Дополнительно: хуки для аутентификации (например,
  // проверки токенов пользователя, если вы решите интегрировать PocketBase)
  // onAuthenticate: async (data) => {
  //   // Ваша логика аутентификации здесь
  //   // if (!isValidUser(data.token)) {
  //   //   throw new Error('Not authorized!')
  //   // }
  // },
  
  async onAuthenticate({ token, connection, documentName, request }) {
    console.log(`🔑 Попытка аутентификации для документа "${documentName}" от ${request.socket.remoteAddress} с токеном: ${token}`);

    if (token !== AUTH_TOKEN) {
      console.warn("🚫 Попытка подключения с неверным токеном");
      throw new Error("Not authorized");
    }

    console.log("🔐 Клиент успешно аутентифицирован");

    // Можно добавить дополнительные данные контекста для других хуков.
    return {
      user: {
        role: "demo",
      },
      connection,
    };
  },

  async onRequest({ request, response }) {
    if (request.method !== "GET") {
      return;
    }

    const host = request.headers.host ?? `localhost:${port}`;
    let pathname = "/";

    try {
      pathname = new URL(request.url ?? "/", `http://${host}`).pathname;
    } catch (error) {
      console.error("❌ Некорректный URL запроса", error);
    }

    if (pathname.startsWith("/vendor/")) {
      const requestedPath = pathname.replace(/^\/+/, "");
      const filePath = join(__dirname, requestedPath);
      if (filePath.startsWith(vendorDir)) {
        const served = await serveStaticFile(response, filePath);
        if (served) {
          throw null;
        }
      }
    }

    if (pathname !== "/" && pathname !== "/index.html") {
      return;
    }

    try {
      const html = await readFile(demoFilePath, "utf8");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
    } catch (error) {
      console.error("❌ Не удалось отдать index.html", error);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Internal Server Error");
    }

    // Бросаем falsy значение, чтобы предотвратить дефолтный ответ сервера.
    throw null;
  },

  // Хук при успешном подключении
  async onConnect() {
    console.log('✅ Клиент подключен');
  },
  
  // Хук при отключении
  async onDisconnect() {
    console.log('❌ Клиент отключен');
  }
});

// Запуск сервера
console.log(`🚀 Hocuspocus server стартует на порту ${port}...`);
console.log("📁 SQLite database: ./data/db.sqlite");

try {
  await server.listen();
  console.log("✅ Сервер запущен и принимает подключения.");
} catch (error) {
  console.error("❌ Не удалось запустить сервер", error);
  process.exit(1);
}