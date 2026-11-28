<?php
declare(strict_types=1);

ini_set('display_errors', '0');
require __DIR__ . '/tester.php';

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header("Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");

function respond(int $status, mixed $data): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
    exit;
}

function authenticate(string $path, string $method, string $root, bool $secure, string $user, string $password): string {
    session_name('TapinDashboard' . substr(hash('sha256', __DIR__), 0, 12));
    if (!session_start([
        'use_strict_mode' => 1,
        'use_only_cookies' => 1,
        'cookie_path' => $root,
        'cookie_secure' => $secure,
        'cookie_httponly' => true,
        'cookie_samesite' => 'Lax',
        'cache_limiter' => '',
    ])) {
        throw new AppError(500, 'نشست ورود روی هاست ایجاد نشد.');
    }
    $signature = hash_hmac('sha256', $user, $password);
    $signedIn = hash_equals($signature, $_SESSION['dashboard_login'] ?? '');
    $csrf = $_SESSION['dashboard_csrf'] ??= bin2hex(random_bytes(32));
    $loginError = '';
    if ($method === 'POST' && ($path === '/' || $path === '/logout')) {
        $submittedToken = $_POST['csrf'] ?? null;
        if (!is_string($submittedToken) || !hash_equals($csrf, $submittedToken)) {
            session_write_close();
            throw new AppError(403, 'نشست فرم معتبر نیست. صفحه را دوباره باز کنید.');
        }
        if ($path === '/logout') {
            $_SESSION = [];
            session_destroy();
            setcookie(session_name(), '', [
                'expires' => 1, 'path' => $root, 'secure' => $secure, 'httponly' => true, 'samesite' => 'Lax',
            ]);
            header('Location: ' . $root, true, 303);
            exit;
        }
        if (!$signedIn) {
            $submittedUser = $_POST['username'] ?? null;
            $submittedPassword = $_POST['password'] ?? null;
            if (is_string($submittedUser) && is_string($submittedPassword) &&
                hash_equals($user, $submittedUser) && hash_equals($password, $submittedPassword)) {
                if (!session_regenerate_id(true)) throw new AppError(500, 'نشست ورود روی هاست ایجاد نشد.');
                $_SESSION['dashboard_login'] = $signature;
                $_SESSION['dashboard_csrf'] = bin2hex(random_bytes(32));
                session_write_close();
                header('Location: ' . $root, true, 303);
                exit;
            }
            $loginError = 'نام کاربری یا رمز عبور اشتباه است.';
        }
    }
    session_write_close();

    if (!$signedIn) {
        if ($path === '/' && in_array($method, ['GET', 'POST'], true)) {
            http_response_code($loginError === '' ? 200 : 401);
            header('Content-Type: text/html; charset=utf-8');
            require __DIR__ . '/public/login.php';
            exit;
        }
        throw new AppError(401, 'برای ادامه از صفحه اصلی وارد داشبورد شوید.');
    }

    if ($path !== '/') return '';
    return '<form class="logout" action="./logout" method="post"><input type="hidden" name="csrf" value="' .
        $csrf . '"><button type="submit">خروج از داشبورد</button></form>';
}

try {
    $envFile = __DIR__ . '/.env';
    $env = is_readable($envFile) ? parse_ini_file($envFile, false, INI_SCANNER_RAW) : false;
    if ($env === false) throw new AppError(500, 'فایل تنظیمات .env را در روت پروژه بسازید.');

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

    $user = $env['DASHBOARD_USER'] ?? 'admin';
    $password = $env['DASHBOARD_PASSWORD'] ?? '';
    $logout = '';
    if ($password !== '' && !in_array($path, ['/style.css', '/favicon.svg'], true)) {
        if ($user === '' || strlen($password) < 12) {
            throw new AppError(500, 'برای فعال کردن ورود، نام کاربری و رمز حداقل ۱۲ کاراکتری تنظیم کنید.');
        }
        $logout = authenticate($path, $method, $prefix . '/', $base['scheme'] === 'https', $user, $password);
    }

    $assets = [
        '/' => ['index.html', 'text/html'],
        '/app.js' => ['app.js', 'text/javascript'],
        '/post.svg' => ['post.svg', 'image/svg+xml'],
        '/tipax.svg' => ['tipax.svg', 'image/svg+xml'],
        '/rail.svg' => ['rail.svg', 'image/svg+xml'],
        '/favicon.svg' => ['favicon.svg', 'image/svg+xml'],
        '/style.css' => ['style.css', 'text/css'],
        '/catalog.json' => ['catalog.json', 'application/json'],
    ];
    if ($method === 'GET' && isset($assets[$path])) {
        [$file, $mime] = $assets[$path];
        header('Content-Type: ' . $mime . '; charset=utf-8');
        if ($path === '/') {
            echo str_replace('<!-- dashboard-logout -->', $logout, file_get_contents(__DIR__ . '/public/' . $file));
        } else {
            readfile(__DIR__ . '/public/' . $file);
        }
        exit;
    }
    if (preg_match('~^/api/(post|tipax|rail|woo)/(profiles|profile-details|profile-order|remove|run|details|drafts|order-options|order-products|order-variations|create-orders|create-status)$~D', $path, $parts)) {
        respond(200, api($env, $method, $parts[1], $parts[2]));
    }
    throw new AppError(404, 'صفحه پیدا نشد.');
} catch (AppError $error) {
    respond($error->getCode(), ['error' => $error->getMessage()]);
} catch (Throwable $error) {
    error_log('Tapin API: ' . get_class($error) . ' (' . $error->getCode() . ')');
    respond(500, ['error' => 'خطای داخلی برنامه. گزارش خطای PHP را بررسی کنید.']);
}
