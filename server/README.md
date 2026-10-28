# Хранилище настроек Claude Editor (своё)

Небольшой сервер, где Claude Editor хранит настройки онлайн: проекты, группы, домены, деплой, тесты, раскладку.
Это тот же протокол, что у Insider (parts.mrkt.ru), поэтому в редакторе достаточно выбрать «Свой сервер» и указать адрес.

- Node 20+, **без зависимостей** — один файл `server.mjs`.
- Вход через **любой OpenID Connect**: Microsoft Entra ID (365), Google, Keycloak, Authentik…
- Последние **10 версий** на пользователя (`KEEP_VERSIONS`), одинаковое содержимое не создаёт новую версию.
- Данные — JSON-файлы в `DATA_DIR` (бэкапьте эту папку).

## Как это работает

Для редактора сервер — OAuth 2.1 authorization server: регистрация клиента (RFC 7591), PKCE, редирект на loopback
`http://127.0.0.1:<порт>/callback`. Вход пользователя сервер перенаправляет вашему OIDC-провайдеру, берёт email из
id_token и выдаёт редактору свой токен. API настроек:

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/api/editor/config/me` | кто вошёл |
| GET | `/api/editor/config/` | последняя версия (404 — ещё пусто) |
| PUT | `/api/editor/config/` | `{config, device, app_version}` → новая версия |
| GET | `/api/editor/config/versions` | список версий |
| GET / DELETE | `/api/editor/config/versions/:id` | версия целиком / удалить |

## Настройка провайдера входа

Redirect URI у провайдера: `https://<ваш-домен>/oauth/callback`.

**Microsoft 365 (Entra ID)** — portal.azure.com → App registrations → New registration, платформа *Web*,
redirect URI как выше; Certificates & secrets → New client secret.
`OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`

**Google** — console.cloud.google.com → APIs & Services → Credentials → OAuth client ID, тип *Web application*.
`OIDC_ISSUER=https://accounts.google.com`

## Переменные окружения

| Переменная | Обязательна | Пример |
|---|---|---|
| `PUBLIC_URL` | да | `https://config.example.com` — адрес, который вводят в редакторе |
| `OIDC_ISSUER` | да | см. выше |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | да | из регистрации у провайдера |
| `ALLOWED_DOMAINS` | нет | `example.com,corp.example.com` — кого пускать (пусто — всех, кто вошёл у провайдера) |
| `ALLOWED_EMAILS` | нет | `me@gmail.com` — отдельные адреса |
| `PORT` | нет | `8787` |
| `DATA_DIR` | нет | `./data` (в Docker — `/data`) |
| `KEEP_VERSIONS` | нет | `10` |

Для Google без своего домена обязательно задайте `ALLOWED_EMAILS`, иначе войти сможет любой аккаунт Google.

## Запуск

```bash
PUBLIC_URL=https://config.example.com OIDC_ISSUER=https://accounts.google.com \
OIDC_CLIENT_ID=... OIDC_CLIENT_SECRET=... ALLOWED_EMAILS=me@gmail.com node server.mjs
```

Docker (Coolify, Portainer, docker compose):

```bash
docker build -t claude-editor-config .
docker run -d -p 8787:8787 -v editor-config:/data \
  -e PUBLIC_URL=https://config.example.com -e OIDC_ISSUER=... -e OIDC_CLIENT_ID=... -e OIDC_CLIENT_SECRET=... \
  -e ALLOWED_DOMAINS=example.com claude-editor-config
```

Нужен HTTPS (обратный прокси: Caddy, Traefik, nginx) — токены ходят в заголовках.

## Проверка

`node selftest.mjs` — полный прогон без настоящего провайдера (поддельный OIDC): регистрация, вход с PKCE,
загрузка, лимит версий, удаление, обновление токена.

## В редакторе

Меню аккаунта → «☁ Облако настроек» (или кнопка «☁ Облако» в блоке «Настройка») → «Свой сервер» → адрес → «Войти через браузер».
