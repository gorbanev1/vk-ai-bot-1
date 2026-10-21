# Prepared replies

Edit `prepared-user-replies.json` and add one object per configured participant.
The list starts empty. A profile matches by any configured ID, username, or display name; platform can be `vk`, `telegram`, or `*`. Prefer IDs because usernames and display names can change or collide.

Example structure (replace the sample values):

```json
{
  "version": 1,
  "users": [
    {
      "platform": "vk",
      "ids": ["123456"],
      "usernames": ["example_name"],
      "names": ["Example User"],
      "interval": { "min": 0, "max": 5 },
      "phrases": ["Hello, {mention}", "Hi, {name}"]
    }
  ]
}
```

The first ordinary request addressed to the profile is counted as request 1. A random gap in the inclusive `[min, max]` range is chosen before the first prepared reply and again after each prepared reply. A gap of `0` replies immediately; `1` waits for one more addressed request. The count and selected next request survive restarts.

Use `{name}`, `{username}`, or `{mention}` in phrases. In Telegram, `{mention}` is rendered as `@username` when available; otherwise it uses the display name.

After editing the file, send the bot owner command `подгрузить фразы для юзернеймов` in a Telegram private chat. The bot validates and swaps the config without restarting. Invalid JSON leaves the previous config loaded.

For VK chat 27, `config/vk-chat-2000000027-user-replies.json` also supports proactive mentions. Set the file-level `proactiveEnabled` flag to `true`, then enable a participant and add phrases under `proactive`:

```json
"proactive": {
  "enabled": true,
  "phrases": ["{mention}, как дела?"],
  "schedule": {
    "mode": "weekly",
    "dayOfWeek": 5,
    "time": "12:00",
    "timeZone": "Europe/Moscow"
  },
  "lastSentAt": null
}
```

Use `"once"` with an ISO timestamp in `"at"`, `"weekly"` with `dayOfWeek` from 1 (Monday) to 7 (Sunday), or `"monthly"` with `dayOfMonth` from 1 to 31. The scheduler uses the configured time zone and skips the quiet interval 23:00–09:00 Moscow time.
