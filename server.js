import { Server } from "@hocuspocus/server";
import { SQLite } from "@hocuspocus/extension-sqlite";

// Настройка сервера Hocuspocus
const server = new Server({
  // Порт, на котором будет слушать сервер (совпадает с EXPOSE в Dockerfile)
  port: 8080,
  
  // Список расширений
  extensions: [
    new SQLite({
      // Путь к базе данных SQLite (персистентное хранилище)
      // В Docker монтируется в /app/data volume
      database: './data/db.sqlite',
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

// Запуск сервера
console.log("🚀 Hocuspocus server listening on port 8080...");
console.log("📁 SQLite database: ./data/db.sqlite");
server.listen();