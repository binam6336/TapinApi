<?php
declare(strict_types=1);

require __DIR__ . '/tester.php';

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header("Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");

function respond(int $status, mixed $data): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
    exit;
}

try {
    $envFile = __DIR__ . '/.env';
    $env = is_readable($envFile) ? parse_ini_file($envFile, false, INI_SCANNER_RAW) : false;
    if ($env === false) throw new AppError(500, 'فایل تنظیمات .env را در روت پروژه بسازید.');

    $user = $env['DASHBOARD_USER'] ?? '';
    $password = $env['DASHBOARD_PASSWORD'] ?? '';
    if ($user === '' || str_contains($user, ':') || strlen($password) < 12) {
        throw new AppError(500, 'نام کاربری و رمز حداقل ۱۲ کاراکتری داشبورد را در .env تنظیم کنید.');
    }
    $authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    $credentials = isset($_SERVER['PHP_AUTH_USER'])
        ? $_SERVER['PHP_AUTH_USER'] . ':' . ($_SERVER['PHP_AUTH_PW'] ?? '')
        : (preg_match('/^Basic (\S+)$/iD', $authorization, $matches) ? base64_decode($matches[1], true) : false);
    if (!is_string($credentials) || !hash_equals($user . ':' . $password, $credentials)) {
        header('WWW-Authenticate: Basic realm="Tapin API", charset="UTF-8"');
        respond(401, ['error' => 'نام کاربری و رمز داشبورد را وارد کنید.']);
    }

    $base = parse_url($env['BASE_URL'] ?? '');
    if (empty($base['host']) || !in_array($base['scheme'] ?? '', ['http', 'https'], true) ||
        isset($base['user']) || isset($base['pass']) || isset($base['query']) || isset($base['fragment'])) {
        throw new AppError(500, 'آدرس کامل داشبورد را در BASE_URL تنظیم کنید.');
    }
    $prefix = rtrim($base['path'] ?? '', '/');
    if ($prefix !== '' && !preg_match('~^(?:/[\w.%\x7e-]+)+$~D', $prefix)) {
        throw new AppError(500, 'مسیر BASE_URL نامعتبر است.');
    }
    $requestPath = explode('?', $_SERVER['REQUEST_URI'] ?? '/', 2)[0];
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'GET' && $prefix !== '' && $requestPath === $prefix) {
        header('Location: ' . $prefix . '/', true, 308);
        exit;
    }
    if (!str_starts_with($requestPath, $prefix . '/')) {
        throw new AppError(404, 'مسیر را با BASE_URL در .env تطبیق دهید.');
    }
    $path = substr($requestPath, strlen($prefix));

    $assets = [
        '/' => ['index.html', 'text/html'],
        '/app.js' => ['app.js', 'text/javascript'],
        '/style.css' => ['style.css', 'text/css'],
        '/catalog.json' => ['catalog.json', 'application/json'],
    ];
    if ($method === 'GET' && isset($assets[$path])) {
        [$file, $mime] = $assets[$path];
        header('Content-Type: ' . $mime . '; charset=utf-8');
        readfile(__DIR__ . '/public/' . $file);
        exit;
    }
    if (preg_match('~^/api/(post|tipax|rail|woo)/(profiles|remove|run|details)$~D', $path, $parts)) {
        respond(200, api($env, $method, $parts[1], $parts[2]));
    }
    throw new AppError(404, 'صفحه پیدا نشد.');
} catch (AppError $error) {
    respond($error->getCode(), ['error' => $error->getMessage()]);
} catch (Throwable $error) {
    error_log('Tapin API: ' . get_class($error) . ' (' . $error->getCode() . ')');
    respond(500, ['error' => 'خطای داخلی برنامه. گزارش خطای PHP را بررسی کنید.']);
}
