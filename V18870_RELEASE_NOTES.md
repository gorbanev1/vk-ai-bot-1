# V188.70

Fixes posterless event cards created after a successful parser run. Clean local poster binding is now performed during VK/Telegram event replacement and again after parser-all processing before snapshot rebuild. A new compatibility migration repairs rows created after the previous one-shot migration. Ambiguous multi-photo VK chat messages remain vision-gated.

Also fixes the finite VK-chat parser crash `startedAt is not defined`.
