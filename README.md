# Craftnode

Read-only граф программы Post for Me v0 на React Flow. Стартовый проект основан на [официальном React Flow Vite starter](https://github.com/xyflow/vite-react-flow-template).

## Запуск локально

```sh
npm ci
npm run dev
```

Описание графа хранится в `public/graph.json`. Текущее исполнение находится отдельно в `public/runtime-state.json`; Craftnode опрашивает его каждые две секунды и показывает статус, исполнителя, время старта, результат, коммит и проверку. Экран остаётся только для чтения.

## Runtime-state contract v1

В `runtime-state.json` есть монотонный `revision`, `updatedAt` и по одной записи на каждый ID узла. Поля `id`, `status`, `worker`, `startedAt`, `result`, `commit` и `proof` обязательны; значение `null` означает, что сведения пока неприменимы. Machine IDs и статусы не переводятся.

Разрешённые переходы:

- `READY → RUNNING`
- `RUNNING → DONE | FAILED`
- `BLOCKED → READY`, когда все зависимости в `graph.json` имеют статус `DONE`

Обновление сериализуется lock-файлом и записывается через временный файл с атомарным `rename`. По умолчанию команда создаёт отдельный коммит только для runtime-state и отправляет его в `origin`; push запускает обновление live страницы. `--no-push` оставляет изменение локальным.

Начать работу:

```sh
npm run state:update -- --node PFM-2 --status RUNNING --worker "programme-owner" --proof "Сеанс и ссылка на текущую работу"
```

Завершить успешно или с ошибкой:

```sh
npm run state:update -- --node PFM-2 --status DONE --result "Точная привязка сохранена" --commit abc1234 --proof "Ссылка на коммит и проверку"
npm run state:update -- --node PFM-2 --status FAILED --result "Причина сбоя" --proof "Ссылка на журнал или воспроизведение"
```

Для `DONE` и `FAILED` нужны `result` и `proof`; `commit` можно опустить, если узел не создаёт коммит. `worker` и `startedAt` сохраняются от начала работы. Узлы с незавершёнными зависимостями нельзя переводить в `READY` или `RUNNING`.

Команда обновления собирает сайт, синхронизирует его в `docs`, коммитит runtime-state и готовые файлы и отправляет их в `main`. GitHub Pages публикует содержимое `docs`; открытая страница подхватит новую ревизию состояния автоматически после публикации.

## Сборка

```sh
npm ci
npm run build
npm run build:pages
```
