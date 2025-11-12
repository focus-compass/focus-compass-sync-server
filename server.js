import os from "os";
import { Server } from "@hocuspocus/server";
import { SQLite } from "@hocuspocus/extension-sqlite";

const port = Number(process.env.PORT ?? 8080);

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
  
  // Хук при успешном подключении
  async onConnect() {
    console.log('✅ Клиент подключен');
  },
  
  // Хук при отключении
  async onDisconnect() {
    console.log('❌ Клиент отключен');
  }
});

const printAccessibleUrls = () => {
  const networkInterfaces = os.networkInterfaces();
  const urls = new Set([`http://localhost:${port}`]);

  for (const nets of Object.values(networkInterfaces)) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        urls.add(`http://${net.address}:${port}`);
      }
    }
  }

  console.log("🌐 Подключайтесь по следующим адресам:");
  for (const url of urls) {
    console.log(`   → ${url}`);
  }
  console.log("⚠️  Убедитесь, что посещение извне разрешено настройками фаервола/маршрутизатора.");
};

// Запуск сервера
console.log(`🚀 Hocuspocus server стартует на порту ${port}...`);
console.log("📁 SQLite database: ./data/db.sqlite");

try {
  await server.listen();
  console.log("✅ Сервер запущен и принимает подключения.");
  printAccessibleUrls();
} catch (error) {
  console.error("❌ Не удалось запустить сервер", error);
  process.exit(1);
}