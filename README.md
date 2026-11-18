# nitrofree

Discord bot with a web UI. Upload stickers, gifs or mp4s and each one becomes a slash command that posts it in chat.

## Run

```
cp .env.example .env   # fill in DISCORD_TOKEN, CLIENT_ID, ADMIN_PASSWORD
docker compose up -d --build
```

Open http://localhost:3000 and log in with `ADMIN_PASSWORD`.

Invite the bot with scopes `bot` + `applications.commands`.
