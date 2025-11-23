# Использование официального образа Node.js (обновлено до актуальной LTS)
FROM node:22-alpine

# Установка рабочей директории внутри контейнера
WORKDIR /app

# Копирование package.json и package-lock.json
COPY package*.json ./

# Установка зависимостей
RUN npm install --production

# Копирование кода сервера
COPY server.js ./
COPY index.html ./
COPY inspector.html ./

# Создание директории для базы данных SQLite
RUN mkdir -p /app/data

# Сервер Hocuspocus по умолчанию слушает на порту 8080
EXPOSE 8080

# Команда запуска сервера
CMD [ "npm", "start" ]