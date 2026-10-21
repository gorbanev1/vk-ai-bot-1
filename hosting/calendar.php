<?php
declare(strict_types=1);

$requestId = bin2hex(random_bytes(8));
$requestStartedAt = microtime(true);
$probeId = isset($_GET['probe']) && preg_match('/^[A-Za-z0-9_-]{1,48}$/', (string) $_GET['probe'])
    ? (string) $_GET['probe']
    : '';
$logRequest = static function (string $stage, array $details = []) use ($requestId, $requestStartedAt): void {
    $record = [
        'request_id' => $requestId,
        'stage' => $stage,
        'elapsed_ms' => (int) round((microtime(true) - $requestStartedAt) * 1000),
    ] + $details;
    error_log('[gigorave-calendar] ' . json_encode($record, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
};
header('X-Request-ID: ' . $requestId);
$logRequest('received', [
    'probe' => $probeId !== '' ? $probeId : null,
    'method' => $_SERVER['REQUEST_METHOD'] ?? 'unknown',
    'https' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https'),
    'has_payload' => isset($_GET['e']),
    'payload_length' => isset($_GET['e']) ? strlen((string) $_GET['e']) : 0,
    'has_signature' => isset($_GET['s']),
    'open' => isset($_GET['open']) ? substr((string) $_GET['open'], 0, 16) : '',
    'download' => isset($_GET['download']) || isset($_GET['file']),
    'user_agent' => substr(preg_replace('/[^\x20-\x7E]/', '?', (string) ($_SERVER['HTTP_USER_AGENT'] ?? '')), 0, 160),
]);
register_shutdown_function(static function () use ($logRequest): void {
    $error = error_get_last();
    $fatalTypes = [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR];
    $details = ['http_status' => http_response_code() ?: 200];
    if ($error !== null && in_array($error['type'], $fatalTypes, true)) {
        $details['fatal_type'] = $error['type'];
        $details['fatal_file'] = basename((string) $error['file']);
        $details['fatal_line'] = (int) $error['line'];
    }
    $logRequest('finished', $details);
});

if (isset($_GET['health']) && $_GET['health'] === '1') {
    http_response_code(200);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, max-age=0');
    echo json_encode(['ok' => true, 'request_id' => $requestId, 'probe' => $probeId !== '' ? $probeId : null, 'server_time' => gmdate('c')], JSON_UNESCAPED_SLASHES);
    exit;
}

$secret = getenv('EVENT_CALENDAR_HMAC_SECRET') ?: '';
$encoded = isset($_GET['e']) ? (string) $_GET['e'] : '';
$signature = isset($_GET['s']) ? (string) $_GET['s'] : '';
$formatVersion = isset($_GET['v']) ? (string) $_GET['v'] : '';
if ($secret === '' || $encoded === '' || !preg_match('/^[A-Za-z0-9_-]+$/', $encoded)) {
    $logRequest('rejected', ['reason' => 'invalid-request']);
    http_response_code(400);
    exit('Invalid calendar request');
}
if (!hash_equals(hash_hmac('sha256', $encoded, $secret), $signature)) {
    $logRequest('rejected', ['reason' => 'invalid-signature']);
    http_response_code(403);
    exit('Invalid calendar signature');
}

$binary = base64_decode(strtr($encoded, '-_', '+/') . str_repeat('=', (4 - strlen($encoded) % 4) % 4), true);
$json = $binary === false ? false : ($formatVersion === '2' ? @gzinflate($binary) : $binary);
$event = $json === false ? null : json_decode($json, true);
if (!is_array($event)) {
    $logRequest('rejected', ['reason' => 'invalid-event-data']);
    http_response_code(400);
    exit('Invalid event data');
}
$title = trim((string) ($event['t'] ?? ''));
$date = (string) ($event['d'] ?? '');
$time = (string) ($event['tm'] ?? '');
$zone = (string) ($event['z'] ?? 'Europe/Moscow');
$venue = trim((string) ($event['v'] ?? ''));
$source = trim((string) ($event['u'] ?? ''));
$announcement = trim((string) ($event['a'] ?? ''));
if ($title === '' || !preg_match('/^\d{8}$/', $date) || ($time !== '' && !preg_match('/^\d{4}$/', $time))) {
    $logRequest('rejected', ['reason' => 'invalid-event-fields']);
    http_response_code(400);
    exit('Invalid event fields');
}
try {
    $tz = new DateTimeZone($zone);
    $start = DateTimeImmutable::createFromFormat('!Ymd' . ($time === '' ? '' : 'Hi'), $date . $time, $tz);
    $errors = DateTimeImmutable::getLastErrors();
    if (!$start || ($errors !== false && ($errors['warning_count'] || $errors['error_count']))) throw new RuntimeException();
} catch (Throwable $error) {
    $logRequest('rejected', ['reason' => 'invalid-date-or-time-zone']);
    http_response_code(400);
    exit('Invalid date or time zone');
}

$escape = static function (string $value): string {
    $value = str_replace('\\', '\\\\', $value);
    $value = preg_replace('/\r\n|\r|\n/', '\\n', $value) ?? $value;
    return str_replace([';', ','], ['\\;', '\\,'], $value);
};
$html = static function (string $value): string {
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
};
$open = isset($_GET['open']) ? (string) $_GET['open'] : '';
$isIcsDownload = isset($_GET['file']) && $_GET['file'] === 'ics';
$legacyDownloadRequest = isset($_GET['download']) && $_GET['download'] === '1' && !$isIcsDownload;
if ($legacyDownloadRequest) $open = 'options';
if ($open === 'event') $open = 'options';
if ($open === 'options' || $open === 'webcal') {
    $logRequest('render-page', ['mode' => $open]);
    $query = '?e=' . rawurlencode($encoded) . '&amp;s=' . rawurlencode($signature) . '&amp;v=' . rawurlencode($formatVersion);
    $downloadUrl = $query . '&amp;file=ics';
    $subscriptionUrl = 'webcal://gigorave.tw1.ru/calendar.php?e=' . rawurlencode($encoded) . '&s=' . rawurlencode($signature) . '&v=' . rawurlencode($formatVersion);
    $eventEnd = $time !== '' ? $start->modify('+2 hours') : $start->modify('+1 day');
    $androidIntentUrl = 'intent://com.android.calendar/events#Intent;scheme=content;action=android.intent.action.INSERT;type=vnd.android.cursor.item/event'
        . ';l.beginTime=' . ((int) $start->format('U') * 1000)
        . ';l.endTime=' . ((int) $eventEnd->format('U') * 1000)
        . ';S.title=' . rawurlencode($title)
        . ';S.eventLocation=' . rawurlencode($venue)
        . ';S.description=' . rawurlencode(implode("\n\n", array_filter([$announcement, $source])))
        . ($time === '' ? ';B.allDay=true' : '')
        . ';end';
    $googleEnd = $eventEnd;
    $googleDates = $time !== ''
        ? $start->setTimezone(new DateTimeZone('UTC'))->format('Ymd\THis\Z') . '/' . $googleEnd->setTimezone(new DateTimeZone('UTC'))->format('Ymd\THis\Z')
        : $start->format('Ymd') . '/' . $googleEnd->format('Ymd');
    $googleDetails = implode("\n\n", array_filter([$announcement, $source]));
    $googleUrl = 'https://calendar.google.com/calendar/render?' . http_build_query([
        'action' => 'TEMPLATE',
        'text' => $title,
        'dates' => $googleDates,
        'ctz' => $zone,
        'location' => $venue,
        'details' => $googleDetails,
    ], '', '&', PHP_QUERY_RFC3986);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: private, no-store, max-age=0');
    header('Pragma: no-cache');
    header('Expires: 0');
    header('X-Content-Type-Options: nosniff');
    $sourceLink = $source !== '' && filter_var($source, FILTER_VALIDATE_URL)
        ? '<p><a href="' . $html($source) . '">Страница события</a></p>'
        : '';
    $htmlPage = <<<'HTML'
<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{TITLE}} — добавить в календарь</title>
<style>
body{margin:0;background:#f4f6f5;color:#172421;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:680px;margin:24px auto;padding:24px;background:#fff;border:1px solid #dce5e1;border-radius:8px}
h1{font-size:24px;line-height:1.25;margin:0 0 8px}h2{font-size:20px;margin:26px 0 10px}h3{font-size:17px;margin:22px 0 4px}p{margin:8px 0 12px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.button{display:inline-block;padding:10px 14px;border-radius:6px;background:#087e68;color:white;text-decoration:none;font-weight:650}
.button.secondary{background:#e9f3ef;color:#075c4d;border:1px solid #b8d3ca}.note{color:#4e625b;font-size:14px}
@media(max-width:720px){main{margin:0;border:0;border-radius:0;padding:20px 16px}.actions{display:grid}.button{text-align:center}}
</style>
<body><main>
<h1>{{TITLE}}</h1><p>{{DATE}}{{VENUE}}</p>
<h2>Добавить событие</h2>
<h3>iPhone и iPad</h3>
<p class="note">Сайт не может сам записать событие в Apple Calendar. Подписка создаёт отдельный календарь. Импорт одного события зависит от iOS: файл может открыться только в предпросмотре без кнопки добавления.</p>
<div class="actions"><a class="button" href="{{SUBSCRIPTION}}">🍎 Подписаться в Apple Calendar</a><a class="button secondary" href="{{DOWNLOAD}}">Импортировать одно событие (.ics)</a></div>
<h3>Android и Huawei</h3>
<p>Если браузер и установленный календарь поддерживают это действие, откроется форма события. Проверь данные и нажми «Сохранить»; иначе используй импорт файла.</p>
<div class="actions"><a class="button" href="{{ANDROID}}">📅 Добавить в календарь телефона</a><a class="button secondary" href="{{DOWNLOAD}}">Другой календарь: импорт файла</a></div>
<h3>Яндекс Календарь и компьютер</h3>
<p>Google Calendar откроет заполненную форму события. Для Яндекс Календаря, macOS и Windows нет общей системной ссылки, которая гарантированно добавляет событие в выбранный календарь: используй импорт файла в своём приложении.</p>
<div class="actions"><a class="button" href="{{GOOGLE}}">Открыть Google Calendar</a><a class="button secondary" href="https://calendar.yandex.ru/">Открыть Яндекс Календарь</a><a class="button secondary" href="{{DOWNLOAD}}">Скачать для импорта</a></div>
<p><a href="https://yandex.ru/support/yandex-360/customers/calendar/web/ru/data-exchange/import">Инструкция по импорту в Яндекс Календарь</a></p>
<h3>Mac</h3>
<p>Добавь подписной календарь в приложение «Календарь» или импортируй это событие отдельно.</p>
<div class="actions"><a class="button secondary" href="{{SUBSCRIPTION}}">Подписаться на Mac</a><a class="button secondary" href="{{DOWNLOAD}}">Импортировать событие на Mac (.ics)</a></div>
<h3>Windows</h3>
<p>Открой скачанный файл в календарном приложении и подтверди импорт. Действие зависит от установленного приложения.</p>
<div class="actions"><a class="button secondary" href="{{DOWNLOAD}}">Скачать событие для Windows (.ics)</a></div>
{{SOURCE}}
</main></body></html>
HTML;
    $htmlPage = strtr($htmlPage, [
        '{{TITLE}}' => $html($title),
        '{{DATE}}' => $html($start->format($time !== '' ? 'd.m.Y H:i' : 'd.m.Y')),
        '{{VENUE}}' => $venue !== '' ? ' · ' . $html($venue) : '',
        '{{SUBSCRIPTION}}' => $html($subscriptionUrl),
        '{{DOWNLOAD}}' => $downloadUrl,
        '{{ANDROID}}' => $html($androidIntentUrl),
        '{{GOOGLE}}' => $html($googleUrl),
        '{{SOURCE}}' => $sourceLink,
    ]);
    echo $htmlPage;
    exit;
}
$lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gigorave//Event Calendar//RU', 'X-WR-CALNAME:' . $escape($title), 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT', 'UID:gigorave-' . hash('sha256', $encoded) . '@gigorave', 'DTSTAMP:' . gmdate('Ymd\THis\Z'), 'SEQUENCE:0', 'STATUS:CONFIRMED', 'TRANSP:OPAQUE'];
if ($time !== '') {
    $lines[] = 'DTSTART:' . $start->setTimezone(new DateTimeZone('UTC'))->format('Ymd\THis\Z');
    $lines[] = 'DTEND:' . $start->modify('+2 hours')->setTimezone(new DateTimeZone('UTC'))->format('Ymd\THis\Z');
} else {
    $lines[] = 'DTSTART;VALUE=DATE:' . $date;
    $lines[] = 'DTEND;VALUE=DATE:' . $start->modify('+1 day')->format('Ymd');
}
$lines[] = 'SUMMARY:' . $escape($title);
if ($venue !== '') $lines[] = 'LOCATION:' . $escape($venue);
$description = implode("\n\n", array_filter([$announcement, $source]));
if ($description !== '') $lines[] = 'DESCRIPTION:' . $escape($description);
if ($source !== '' && filter_var($source, FILTER_VALIDATE_URL)) $lines[] = 'URL:' . $escape($source);
foreach ([['-P1D', 'за день', '1']] as [$trigger, $label, $index]) {
    $alarmUid = 'gigorave-alarm-' . hash('sha256', $encoded . '-' . $index) . '@gigorave';
    $lines[] = 'BEGIN:VALARM';
    $lines[] = 'UID:' . $alarmUid;
    $lines[] = 'X-WR-ALARMUID:' . $alarmUid;
    $lines[] = 'ACTION:DISPLAY';
    $lines[] = 'DESCRIPTION:' . $escape('Напоминание ' . $label . ': ' . $title);
    $lines[] = 'TRIGGER:' . $trigger;
    $lines[] = 'END:VALARM';
}
$lines[] = 'END:VEVENT';
$lines[] = 'END:VCALENDAR';
$fold = static function (string $line): string {
    $parts = [];
    $current = '';
    foreach (preg_split('//u', $line, -1, PREG_SPLIT_NO_EMPTY) ?: [] as $character) {
        if (strlen($current . $character) > 74 && $current !== '') {
            $parts[] = $current;
            $current = ' ' . $character;
        } else {
            $current .= $character;
        }
    }
    if ($current !== '') $parts[] = $current;
    return implode("\r\n", $parts);
};
$ics = implode("\r\n", array_map($fold, $lines)) . "\r\n";
$logRequest('render-ics', ['mode' => $isIcsDownload ? 'download' : 'feed', 'ics_bytes' => strlen($ics)]);
$filename = preg_replace('/[^\pL\pN_-]+/u', '-', $title) ?: 'event';
header('Content-Type: text/calendar; charset=utf-8');
$disposition = $isIcsDownload ? 'attachment' : 'inline';
header('Content-Disposition: ' . $disposition . '; filename="' . substr($filename, 0, 70) . '.ics"');
header('Content-Length: ' . strlen($ics));
header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');
header('X-Content-Type-Options: nosniff');
echo $ics;
