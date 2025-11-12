# Использование официального образа Node.js
FROM node:20-alpine

# Установка рабочей директории внутри контейнера
WORKDIR /app

# Копирование package.json и package-lock.json
COPY package*.json ./

# Установка зависимостей
RUN npm install --production

# Копирование кода сервера
COPY server.js ./

# Создание директории для базы данных SQLite
RUN mkdir -p /app/data

# Сервер Hocuspocus по умолчанию слушает на порту 8080
EXPOSE 8080

# Команда запуска сервера
CMD [ "npm", "start" ]