# Focus Compass - Hocuspocus Server

WebSocket сервер для real-time коллаборации на базе [Hocuspocus](https://tiptap.dev/docs/hocuspocus/introduction) с SQLite персистентностью.

## Что такое Hocuspocus?

Hocuspocus — это WebSocket бэкенд на базе CRDT (Conflict-free Replicated Data Type) с использованием библиотеки Yjs. Он обеспечивает:

- ✅ **Real-time синхронизацию** данных между клиентами
- ✅ **Конфликт-свободную коллаборацию** (несколько пользователей могут одновременно редактировать данные)
- ✅ **Персистентность** данных в SQLite
- ✅ **Offline-first** подход
- ✅ **Автоматическое разрешение конфликтов**

## Архитектура

```
┌─────────────┐
│   Client 1  │──┐
└─────────────┘  │
                 │     ┌──────────────────┐      ┌──────────────┐
┌─────────────┐  ├────▶│  Hocuspocus WS   │─────▶│   SQLite DB  │
│   Client 2  │──┤     │     Server       │      │ (Persistent) │
└─────────────┘  │     └──────────────────┘      └──────────────┘
                 │            ▲
┌─────────────┐  │            │
│   Client N  │──┘            │
└─────────────┘               │
                        Port 8080
```

## Быстрый старт

### Запуск с Docker Compose (рекомендуется)

```bash
# 1. Скопируйте example файл с переменными окружения (опционально)
cp .env.example .env

# 2. Отредактируйте .env если нужен другой порт (опционально)
# nano .env

# 3. Запуск сервера
docker-compose up -d

# 4. Просмотр логов
docker-compose logs -f

# 5. Проверка статуса (healthcheck)
docker ps

# Остановка сервера
docker-compose down

# Полная очистка (включая данные)
docker-compose down -v
```

### Запуск локально

```bash
# Установка зависимостей
npm install

# Запуск сервера
npm start
```

Сервер будет доступен на `ws://localhost:8080`

## Конфигурация

### Основные файлы

- **`server.js`** - конфигурация Hocuspocus сервера
- **`Dockerfile`** - образ Docker для деплоя
- **`docker-compose.yml`** - оркестрация контейнера
- **`package.json`** - зависимости проекта

### Переменные окружения

Создайте файл `.env` в корне проекта (или скопируйте `.env.example`):

```bash
# Порт для Hocuspocus сервера (по умолчанию 8080)
HOCUSPOCUS_PORT=8080

# Окружение Node.js (production/development)
NODE_ENV=production
```

Docker Compose автоматически подхватит эти переменные.

### Порты

По умолчанию сервер слушает на порту **8080**. Для изменения порта:

1. В `server.js` измените `port: 8080`
2. В `Dockerfile` измените `EXPOSE 8080`
3. В `docker-compose.yml` измените маппинг портов

### Персистентность

База данных SQLite сохраняется в Docker volume `hocuspocus-data`, который монтируется в `/app/data` внутри контейнера.

Файл базы данных: `/app/data/db.sqlite`

**Важно**: При удалении volume командой `docker-compose down -v` все данные будут потеряны!

## Подключение клиента

### JavaScript/TypeScript (браузер)

```bash
npm install @hocuspocus/provider yjs
```

```javascript
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'

// Создание Yjs документа
const doc = new Y.Doc()

// Подключение к серверу
const provider = new HocuspocusProvider({
  url: 'ws://localhost:8080',
  name: 'my-document', // уникальное имя документа
  document: doc,
})

// Работа с данными
const yText = doc.getText('content')
yText.observe(() => {
  console.log('Контент изменен:', yText.toString())
})

// Обновление данных
yText.insert(0, 'Привет, мир!')
```

### React + Tiptap

```bash
npm install @tiptap/react @tiptap/starter-kit @tiptap/extension-collaboration
npm install @hocuspocus/provider yjs
```

```jsx
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'

const ydoc = new Y.Doc()

function Editor() {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        history: false, // важно! отключаем встроенную историю
      }),
      Collaboration.configure({
        document: ydoc,
      }),
    ],
    content: '<p>Начните печатать...</p>',
  })

  // Подключаемся к Hocuspocus
  const provider = new HocuspocusProvider({
    url: 'ws://localhost:8080',
    name: 'my-document',
    document: ydoc,
  })

  return <EditorContent editor={editor} />
}
```

## API Endpoints

Hocuspocus использует WebSocket протокол. После подключения к `ws://localhost:8080` клиент может:

- **Создавать документы** - автоматически при первом подключении с именем документа
- **Читать документы** - получать актуальное состояние из SQLite
- **Обновлять документы** - отправлять изменения в real-time
- **Синхронизироваться** - получать изменения от других клиентов

## Мониторинг

### Проверка работоспособности

```bash
# Проверка, что контейнер запущен и здоров (смотрите на колонку STATUS)
docker ps | grep hocuspocus
# STATUS должен быть "Up X minutes (healthy)"

# Логи сервера
docker-compose logs -f hocuspocus-sync

# Вход в контейнер
docker exec -it hocuspocus_server sh

# Проверка базы данных
docker exec -it hocuspocus_server ls -lh /app/data/

# Проверка статистики контейнера (CPU, память)
docker stats hocuspocus_server

# Проверка healthcheck вручную
docker inspect --format='{{json .State.Health}}' hocuspocus_server | jq
```

### Healthcheck

Docker Compose настроен с автоматическим healthcheck:
- **Интервал проверки**: каждые 30 секунд
- **Таймаут**: 10 секунд
- **Попытки**: 3 раза перед объявлением unhealthy
- **Начальный период**: 40 секунд (время на старт сервера)

Статусы:
- `starting` - контейнер только запустился
- `healthy` - сервер работает нормально
- `unhealthy` - сервер не отвечает (автоматически перезапустится)

### Логи

Сервер выводит следующие логи:
- `🚀 Hocuspocus server listening on port 8080...` - сервер запущен
- `✅ Клиент подключен` - новое подключение
- `❌ Клиент отключен` - клиент отключился

## Расширение функциональности

### Аутентификация

Раскомментируйте и настройте хук `onAuthenticate` в `server.js`:

```javascript
async onAuthenticate(data) {
  const { token } = data

  // Проверка токена (например, JWT)
  const user = await verifyToken(token)
  
  if (!user) {
    throw new Error('Not authorized!')
  }

  // Возвращаем данные пользователя в context
  return {
    user: user,
  }
}
```

### Дополнительные расширения

Hocuspocus поддерживает множество расширений:

- **Redis** - для масштабирования на несколько серверов
- **Webhooks** - для уведомлений о событиях
- **Logger** - для расширенного логирования
- **Throttle** - для ограничения rate-limit

```bash
npm install @hocuspocus/extension-redis
npm install @hocuspocus/extension-webhook
```

## Troubleshooting

### Порт уже используется

```bash
# Найти процесс на порту 8080
netstat -ano | findstr :8080  # Windows
lsof -i :8080                 # Linux/Mac

# Изменить порт в docker-compose.yml
ports:
  - "3001:8080"  # внешний:внутренний
```

### База данных не сохраняется

Проверьте, что volume правильно примонтирован:

```bash
docker volume ls
docker volume inspect focus-compass-server_hocuspocus-data
```

### Клиент не может подключиться

1. Проверьте, что сервер запущен: `docker ps`
2. Проверьте URL подключения (должен быть `ws://`, не `wss://` для локальной разработки)
3. Проверьте CORS настройки (добавьте в `server.js`)

## Production деплой

### Рекомендации

1. **Используйте HTTPS/WSS** - настройте SSL сертификаты
2. **Добавьте Redis** - для масштабирования на несколько инстансов
3. **Настройте аутентификацию** - защитите доступ к документам
4. **Настройте backup** - регулярно создавайте резервные копии SQLite
5. **Мониторинг** - используйте Prometheus/Grafana для метрик

### Пример с Nginx reverse proxy

```nginx
upstream hocuspocus {
    server localhost:8080;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://hocuspocus;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## Зависимости

- **Node.js** 20 (Alpine)
- **@hocuspocus/server** ^2.10.0
- **@hocuspocus/extension-sqlite** ^3.4.0
- **yjs** ^13.6.14

## Лицензия

ISC

## Полезные ссылки

- [Документация Hocuspocus](https://tiptap.dev/docs/hocuspocus/introduction)
- [Yjs Documentation](https://docs.yjs.dev/)
- [Tiptap Editor](https://tiptap.dev/)
- [GitHub Repository](https://github.com/ueberdosis/hocuspocus)

## Поддержка

Для вопросов и багрепортов создавайте issues в репозитории.
