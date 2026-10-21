<?php
declare(strict_types=1);

$secret = 'calendar-endpoint-test-secret';
putenv('EVENT_CALENDAR_HMAC_SECRET=' . $secret);
$payload = json_encode([
    't' => 'Calendar alert test',
    'd' => '20261114',
    'tm' => '2000',
    'z' => 'Europe/Moscow',
    'v' => 'Test venue',
    'u' => 'https://example.com/event',
], JSON_THROW_ON_ERROR);
$encoded = rtrim(strtr(base64_encode($payload), '+/', '-_'), '=');
$_GET = ['e' => $encoded, 's' => hash_hmac('sha256', $encoded, $secret)];

ob_start();
require dirname(__DIR__, 2) . '/hosting/calendar.php';
$ics = (string) ob_get_clean();
$assert = static function (bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
};
$assert(substr_count($ics, "BEGIN:VALARM\r\n") === 1, 'Expected one default VALARM block.');
$assert(str_contains($ics, "X-WR-CALNAME:Calendar alert test\r\n"), 'Expected a recognizable subscribed calendar name.');
$assert(str_contains($ics, "REFRESH-INTERVAL;VALUE=DURATION:PT15M\r\n"), 'Expected subscribed calendars to request a 15-minute refresh interval.');
$assert(str_contains($ics, "X-PUBLISHED-TTL:PT15M\r\n"), 'Expected the compatibility calendar refresh interval.');
$assert(!str_contains($ics, "METHOD:PUBLISH\r\n"), 'A subscribed calendar snapshot must not advertise an iTIP scheduling method.');
$assert(str_contains($ics, "SEQUENCE:0\r\nSTATUS:CONFIRMED\r\nTRANSP:OPAQUE\r\n"), 'Expected a confirmed visible event.');
$assert(preg_match_all('/\r\nUID:gigorave-alarm-/u', $ics) === 1, 'Expected the alarm UID.');
$assert(preg_match_all('/\r\nX-WR-ALARMUID:gigorave-alarm-/u', $ics) === 1, 'Expected the Apple alarm UID.');
$assert(str_contains($ics, "TRIGGER:-P1D\r\n"), 'Expected a one-day alarm.');
$assert(!str_contains($ics, "TRIGGER:-PT1H\r\n"), 'Did not expect an extra one-hour alarm.');

fwrite(STDOUT, "Calendar endpoint emitted one default one-day alarm.\n");
