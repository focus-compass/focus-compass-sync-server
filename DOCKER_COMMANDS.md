# Docker Commands - Шпаргалка

## Основные команды

### Запуск и остановка

```bash
# Запустить контейнер в фоновом режиме
docker-compose up -d

# Запустить с пересборкой образа
docker-compose up -d --build

# Остановить контейнер (данные сохраняются)
docker-compose down

# Остановить и удалить все данные
docker-compose down -v

# Перезапустить контейнер
docker-compose restart
```

### Логи и мониторинг

```bash
# Просмотр логов (в реальном времени)
docker-compose logs -f

# Последние 100 строк логов
docker-compose logs --tail=100

# Логи с временными метками
docker-compose logs -t

# Статистика использования ресурсов
docker stats hocuspocus_server

# Проверка статуса контейнера
docker ps
docker inspect hocuspocus_server
```

### Работа с контейнером

```bash
# Войти в контейнер (shell)
docker exec -it hocuspocus_server sh

# Выполнить команду в контейнере
docker exec hocuspocus_server ls -la /app/data

# Проверить healthcheck
docker inspect --format='{{json .State.Health}}' hocuspocus_server

# Перезапустить только один сервис
docker-compose restart hocuspocus-sync
```

### Работа с данными

```bash
# Список всех volumes
docker volume ls

# Информация о volume
docker volume inspect focus-compass-server_hocuspocus-data

# Backup базы данных
docker cp hocuspocus_server:/app/data/db.sqlite ./backup-$(date +%Y%m%d).sqlite

# Restore базы данных
docker cp ./backup-20231113.sqlite hocuspocus_server:/app/data/db.sqlite
docker-compose restart

# Удалить volume (ВНИМАНИЕ: все данные будут потеряны!)
docker volume rm focus-compass-server_hocuspocus-data
```

### Очистка

```bash
# Удалить неиспользуемые образы
docker image prune

# Удалить всё неиспользуемое (образы, контейнеры, сети, volumes)
docker system prune -a --volumes

# Удалить только этот проект
docker-compose down -v
docker rmi focus-compass-server_hocuspocus-sync
```

### Отладка

```bash
# Просмотр процессов внутри контейнера
docker-compose top

# Проверка переменных окружения
docker exec hocuspocus_server env

# Проверка портов
docker port hocuspocus_server

# Проверка сети
docker network ls
docker network inspect focus-compass-server_hocuspocus-network
```

## Production команды

### Обновление приложения

```bash
# 1. Остановить контейнер
docker-compose down

# 2. Обновить код (git pull, etc.)
git pull

# 3. Пересобрать образ и запустить
docker-compose up -d --build

# 4. Проверить логи
docker-compose logs -f
```

### Backup стратегия

```bash
# Создание backup скрипта
cat > backup.sh << 'EOF'
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="./backups"
mkdir -p $BACKUP_DIR

# Backup SQLite базы
docker cp hocuspocus_server:/app/data/db.sqlite $BACKUP_DIR/db-$DATE.sqlite

# Удаление старых backup'ов (старше 7 дней)
find $BACKUP_DIR -name "db-*.sqlite" -mtime +7 -delete

echo "Backup created: $BACKUP_DIR/db-$DATE.sqlite"
EOF

chmod +x backup.sh

# Запуск backup
./backup.sh

# Добавить в cron (каждый день в 3 утра)
# 0 3 * * * cd /path/to/project && ./backup.sh
```

## Полезные комбинации

```bash
# Полная пересборка и очистка кэша
docker-compose down && \
docker system prune -f && \
docker-compose up -d --build --force-recreate

# Быстрая проверка работоспособности
docker ps && docker logs hocuspocus_server --tail=20

# Мониторинг в реальном времени
watch -n 5 'docker ps && docker stats --no-stream hocuspocus_server'
```
