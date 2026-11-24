<?php
declare(strict_types=1);

final class AppError extends RuntimeException {
    public function __construct(int $status, string $message) {
        parent::__construct($message, $status);
    }
}

const FIELDS = [
    'post' => ['auth', 'shop_id', 'order_id', 'order_uuid', 'task_id'],
    'tipax' => ['auth', 'shop_id', 'order_uuid', 'hash'],
    'rail' => ['auth', 'shop_id', 'order_uuid', 'hash'],
    'woo' => ['site', 'key', 'secret'],
];

function database(array $env): PDO {
    $host = $env['DB_HOST'] ?? 'localhost';
    $port = $env['DB_PORT'] ?? '3306';
    $name = $env['DB_NAME'] ?? '';
    if ($name === '' || preg_match('/[;\x00-\x1f]/', $host . $name) || !preg_match('/^[0-9]+$/D', $port)) {
        throw new AppError(500, 'تنظیمات MySQL را در .env بررسی کنید.');
    }
    $db = new PDO(
        "mysql:host=$host;port=$port;dbname=$name;charset=utf8mb4",
        $env['DB_USER'] ?? '',
        $env['DB_PASS'] ?? '',
        [PDO::ATTR_EMULATE_PREPARES => false, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
    );
    if ($db->query("SHOW TABLES LIKE 'profiles'")->fetchColumn() === false) {
        $db->exec('CREATE TABLE IF NOT EXISTS profiles (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            service VARCHAR(16) NOT NULL,
            name VARCHAR(80) NOT NULL,
            data MEDIUMTEXT NOT NULL,
            UNIQUE (service, name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin');
    }
    query($db, 'SET time_zone = ?', [$env['DB_TIMEZONE'] ?? '+03:30']);
    return $db;
}

function query(PDO $db, string $sql, array $params): PDOStatement {
    $statement = $db->prepare($sql);
    $statement->execute($params);
    return $statement;
}

function seal(array $values, string $key): string {
    $nonce = random_bytes(12);
    $ciphertext = openssl_encrypt(json_encode((object) $values, JSON_THROW_ON_ERROR),
        'aes-256-gcm', $key, OPENSSL_RAW_DATA, $nonce, $tag);
    if ($ciphertext === false) throw new RuntimeException('Encryption failed.');
    return base64_encode($nonce . $tag . $ciphertext);
}

function unseal(string $data, string $key): array {
    $bytes = base64_decode($data, true);
    if ($bytes === false || strlen($bytes) < 29) throw new RuntimeException('Invalid encrypted data.');
    $plaintext = openssl_decrypt(substr($bytes, 28), 'aes-256-gcm', $key, OPENSSL_RAW_DATA,
        substr($bytes, 0, 12), substr($bytes, 12, 16));
    if ($plaintext === false) throw new AppError(500, 'کلید DATABASE_KEY با کلید اتصال ذخیره‌شده مطابقت ندارد.');
    return json_decode($plaintext, true, 512, JSON_THROW_ON_ERROR);
}

function readInput(): object {
    if (explode(';', $_SERVER['CONTENT_TYPE'] ?? '', 2)[0] !== 'application/json' ||
        ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site') {
        throw new AppError(415, 'درخواست JSON معتبر لازم است.');
    }
    $raw = file_get_contents('php://input', false, null, 0, 262145);
    if ($raw === false) throw new AppError(400, 'درخواست خوانده نشد.');
    if (strlen($raw) > 262144) throw new AppError(413, 'درخواست بیش از حد بزرگ است.');
    $input = json_decode($raw);
    if (!is_object($input)) throw new AppError(400, 'درخواست JSON نامعتبر است.');
    return $input;
}

function requestDrafts(array $env, string $method, string $service, string $key): mixed {
    if ($service === 'woo') throw new AppError(404, 'مسیر پیدا نشد.');
    if (!in_array($method, ['GET', 'POST'], true)) throw new AppError(405, 'روش درخواست نامعتبر است.');
    $input = $method === 'GET' ? (object) ['operation' => 'load'] : readInput();
    $profileId = $input->profileId ?? null;
    $operation = $input->operation ?? 'save';
    $db = database($env);
    if ($profileId !== null) {
        if (!is_int($profileId) || $profileId <= 0) throw new AppError(400, 'شناسه اتصال نامعتبر است.');
        $owner = query($db, 'SELECT id FROM profiles WHERE id = ? AND service = ?', [$profileId, $service])->fetchColumn();
        if ($owner === false) throw new AppError(404, 'اتصال ذخیره‌شده پیدا نشد.');
        if ($db->query("SHOW TABLES LIKE 'connection\_request\_drafts'")->fetchColumn() === false) {
            $db->exec('CREATE TABLE IF NOT EXISTS connection_request_drafts (
                profile_id INT UNSIGNED NOT NULL,
                endpoint VARCHAR(64) NOT NULL,
                data MEDIUMTEXT NOT NULL,
                PRIMARY KEY (profile_id, endpoint),
                FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin');
        }
        $table = 'connection_request_drafts';
        $scope = 'profile_id';
        $scopeId = $profileId;
    } else {
        // Keep legacy drafts available under the unsaved connection.
        if ($db->query("SHOW TABLES LIKE 'request\_drafts'")->fetchColumn() === false) {
            $db->exec('CREATE TABLE IF NOT EXISTS request_drafts (
                service VARCHAR(16) NOT NULL,
                endpoint VARCHAR(64) NOT NULL,
                data MEDIUMTEXT NOT NULL,
                PRIMARY KEY (service, endpoint)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin');
        }
        $table = 'request_drafts';
        $scope = 'service';
        $scopeId = $service;
    }
    if ($operation === 'load') {
        $drafts = [];
        foreach (query($db, "SELECT endpoint, data FROM $table WHERE $scope = ?", [$scopeId]) as $row) {
            $drafts[$row['endpoint']] = unseal($row['data'], $key)['body'];
        }
        return (object) $drafts;
    }
    if ($operation === 'reset-all') {
        query($db, "DELETE FROM $table WHERE $scope = ?", [$scopeId]);
        return ['ok' => true];
    }
    if ($operation !== 'save') throw new AppError(400, 'عملیات پیش‌نویس نامعتبر است.');
    $id = $input->endpoint ?? null;
    $endpoint = is_string($id) ? (shippingEndpoints($service)[$id] ?? null) : null;
    if (($endpoint['method'] ?? null) !== 'POST') throw new AppError(404, 'مسیر قابل ویرایش پیدا نشد.');
    if (!property_exists($input, 'body') || ($input->body !== null && !is_string($input->body))) {
        throw new AppError(400, 'بدنه پیش‌نویس نامعتبر است.');
    }
    if ($input->body === null) {
        query($db, "DELETE FROM $table WHERE $scope = ? AND endpoint = ?", [$scopeId, $id]);
    } else {
        $data = seal(['body' => $input->body], $key);
        query($db, "INSERT INTO $table ($scope, endpoint, data) VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE data = ?", [$scopeId, $id, $data, $data]);
    }
    return ['ok' => true];
}

function profileOrderTable(PDO $db): void {
    if ($db->query("SHOW TABLES LIKE 'profile\_order'")->fetchColumn() !== false) return;
    $db->exec('CREATE TABLE IF NOT EXISTS profile_order (
        service VARCHAR(16) NOT NULL PRIMARY KEY,
        profile_ids LONGTEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin');
}

function orderedProfiles(PDO $db, string $service): array {
    profileOrderTable($db);
    $rows = query($db, 'SELECT id, name FROM profiles WHERE service = ? ORDER BY id', [$service])->fetchAll();
    $saved = query($db, 'SELECT profile_ids FROM profile_order WHERE service = ?', [$service])->fetchColumn();
    if ($saved === false) return $rows;

    $remaining = array_column($rows, null, 'id');
    $ordered = [];
    foreach (json_decode($saved, true, 512, JSON_THROW_ON_ERROR) as $id) {
        if (!isset($remaining[$id])) continue;
        $ordered[] = $remaining[$id];
        unset($remaining[$id]);
    }
    return array_merge($ordered, array_values($remaining));
}

function saveProfileOrder(PDO $db, string $service, mixed $ids): array {
    if (!is_array($ids) || !array_is_list($ids) ||
        array_filter($ids, static fn($id) => !is_int($id) || $id <= 0) ||
        count(array_unique($ids, SORT_NUMERIC)) !== count($ids)) {
        throw new AppError(400, 'ترتیب اتصال‌ها نامعتبر است.');
    }
    $rows = orderedProfiles($db, $service);
    $byId = array_column($rows, null, 'id');
    if (count($ids) !== count($rows) || array_diff($ids, array_keys($byId))) {
        throw new AppError(409, 'فهرست اتصال‌ها تغییر کرده است. صفحه را تازه کنید و دوباره تلاش کنید.');
    }
    $encoded = json_encode($ids, JSON_THROW_ON_ERROR);
    query($db, 'INSERT INTO profile_order (service, profile_ids) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE profile_ids = ?', [$service, $encoded, $encoded]);
    return array_map(static fn(int $id) => $byId[$id], $ids);
}

function api(array $env, string $method, string $service, string $action): mixed {
    $hexKey = $env['DATABASE_KEY'] ?? '';
    if (!preg_match('/^[0-9a-f]{64}$/iD', $hexKey)) {
        throw new AppError(500, 'کلید ۶۴ کاراکتری DATABASE_KEY را در .env تنظیم کنید.');
    }
    $key = hex2bin($hexKey);
    if ($action === 'drafts') return requestDrafts($env, $method, $service, $key);
    if ($action === 'profiles' && $method === 'GET') {
        return orderedProfiles(database($env), $service);
    }
    if ($method !== 'POST') throw new AppError(405, 'روش درخواست نامعتبر است.');
    $wooOnly = ['details', 'order-options', 'create-orders', 'create-status'];
    if (in_array($action, $wooOnly, true) && $service !== 'woo') throw new AppError(404, 'مسیر پیدا نشد.');
    $input = readInput();
    if ($action === 'profile-order') return saveProfileOrder(database($env), $service, $input->ids ?? null);
    $id = $input->profileId ?? null;
    if (($id !== null || $action === 'remove') && (!is_int($id) || $id <= 0)) {
        throw new AppError(400, 'شناسه اتصال نامعتبر است.');
    }
    $db = $id !== null || $action === 'profiles' ? database($env) : null;
    if ($action === 'remove') {
        if (!query($db, 'DELETE FROM profiles WHERE service = ? AND id = ?', [$service, $id])->rowCount()) {
            throw new AppError(404, 'اتصال ذخیره‌شده پیدا نشد.');
        }
        return ['ok' => true];
    }
    $values = [];
    $previous = null;
    if ($id !== null) {
        $previous = query($db, 'SELECT data FROM profiles WHERE service = ? AND id = ?', [$service, $id])->fetchColumn();
        if ($previous === false) throw new AppError(404, 'اتصال ذخیره‌شده پیدا نشد.');
        $values = unseal($previous, $key);
    }
    foreach (FIELDS[$service] as $field) {
        $value = $input->values->$field ?? null;
        if ($value === null) continue;
        if (!is_string($value) || strlen($value) > 4096 || strpbrk($value, "\r\n\0") !== false) {
            throw new AppError(400, 'مقدار یکی از فیلدهای اتصال نامعتبر است.');
        }
        $values[$field] = trim($value);
    }
    if ($action === 'profiles') {
        $name = is_string($input->name ?? null) ? trim($input->name) : '';
        if ($name === '' || !preg_match('/^.{1,80}$/usD', $name)) {
            throw new AppError(400, 'نام اتصال باید بین ۱ تا ۸۰ کاراکتر باشد.');
        }
        if ($service === 'woo') $values['site'] = wooCredentials($values);
        $data = seal($values, $key);
        try {
            if ($id !== null) {
                $result = query($db, 'UPDATE profiles SET name = ?, data = ? WHERE service = ? AND id = ? AND data = ?',
                    [$name, $data, $service, $id, $previous]);
                if (!$result->rowCount()) throw new AppError(409, 'اتصال تغییر کرده یا حذف شده است. دوباره آن را انتخاب کنید.');
            } else {
                query($db, 'INSERT INTO profiles (service, name, data) VALUES (?, ?, ?)', [$service, $name, $data]);
                $id = (int) $db->lastInsertId();
            }
        } catch (PDOException $error) {
            if (($error->errorInfo[1] ?? null) === 1062) throw new AppError(409, 'این نام قبلاً استفاده شده است.');
            throw $error;
        }
        return ['id' => $id, 'name' => $name];
    }
    $timeout = $input->timeout ?? 18;
    if (!is_int($timeout) || $timeout < 1 || $timeout > 60) {
        throw new AppError(400, 'زمان انتظار باید یک عدد صحیح بین ۱ و ۶۰ ثانیه باشد.');
    }
    if (in_array($action, ['order-options', 'create-orders', 'create-status'], true)) {
        if ($action !== 'order-options' && $id !== null && ($env['DASHBOARD_PASSWORD'] ?? '') === '' &&
            (empty($input->values->key) || empty($input->values->secret))) {
            throw new AppError(403, 'برای ثبت در اتصال ذخیره‌شده، کلید و رمز ووکامرس را وارد کنید یا ورود داشبورد را فعال کنید.');
        }
        return wooOrderAction($values, $input, $action, $timeout);
    }
    return $service === 'woo'
        ? woo($values, $input, $action === 'details', $timeout)
        : shipping($service, $values, $input, $timeout);
}

function wooCredentials(array $values): string {
    $site = $values['site'] ?? '';
    $url = parse_url($site);
    // Accept the default HTTPS port, with no user info, query or fragment.
    if (!filter_var($site, FILTER_VALIDATE_URL) || strtolower($url['scheme'] ?? '') !== 'https' ||
        isset($url['user']) || isset($url['pass']) || isset($url['query']) || isset($url['fragment']) ||
        ($url['port'] ?? 443) !== 443 || str_contains($site, '\\')) {
        throw new AppError(400, 'آدرس HTTPS فروشگاه را بدون پورت غیرپیش‌فرض، رمز یا پارامتر وارد کنید.');
    }
    if (empty($values['key']) || empty($values['secret']) || str_contains($values['key'], ':')) {
        throw new AppError(400, 'کلید و رمز ووکامرس را وارد کنید.');
    }
    return rtrim($site, '/');
}

function upstream(string $url, int $deadline, string $method = 'GET', ?string $auth = null, ?string $body = null): array {
    if (hrtime(true) >= $deadline) throw new AppError(504, 'زمان پاسخ سرویس تمام شد.');
    $host = trim((string) parse_url($url, PHP_URL_HOST), '[]');
    $isIp = filter_var($host, FILTER_VALIDATE_IP) !== false;
    $records = $isIp ? [] : dns_get_record($host, DNS_A | DNS_AAAA);
    $addresses = $isIp ? [$host] : array_values(array_filter(array_map(
        static fn(array $record) => $record['ip'] ?? $record['ipv6'] ?? null, $records ?: []
    )));
    if (!$addresses) throw new AppError(502, 'آدرس سرویس پیدا نشد.');
    foreach ($addresses as $address) {
        $packed = inet_pton($address);
        if (!filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_GLOBAL_RANGE) ||
            (strlen($packed) === 16 && str_starts_with($packed, str_repeat("\0", 10) . "\xff\xff"))) {
            throw new AppError(400, 'آدرس سرویس باید به یک مقصد عمومی اشاره کند.');
        }
    }
    $remaining = (int) ceil(($deadline - hrtime(true)) / 1e6);
    if ($remaining <= 0) throw new AppError(504, 'زمان پاسخ سرویس تمام شد.');
    $address = $addresses[0];
    $headers = ['Accept: application/json, text/html', 'Accept-Encoding: identity'];
    if ($auth !== null && $auth !== '') $headers[] = 'Authorization: ' . $auth;
    if ($body !== null) $headers[] = 'Content-Type: application/json';
    $output = '';
    $oversize = false;
    $curl = curl_init($url);
    $options = [
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_FOLLOWLOCATION => false, CURLOPT_PROXY => '',
        CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $headers,
        CURLOPT_CONNECTTIMEOUT_MS => $remaining, CURLOPT_TIMEOUT_MS => $remaining,
        CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$output, &$oversize): int {
            if (strlen($output) + strlen($chunk) > 8 * 1024 * 1024) {
                $oversize = true;
                return 0;
            }
            $output .= $chunk;
            return strlen($chunk);
        },
    ];
    if (!$isIp) $options[CURLOPT_RESOLVE] = [$host . ':443:' . (str_contains($address, ':') ? "[$address]" : $address)];
    if ($body !== null) $options[CURLOPT_POSTFIELDS] = $body;
    curl_setopt_array($curl, $options);
    $ok = curl_exec($curl);
    $error = curl_errno($curl);
    $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    curl_close($curl);
    if ($oversize) throw new AppError(502, 'پاسخ سرویس بیش از حد بزرگ است.');
    if ($error === CURLE_OPERATION_TIMEDOUT) throw new AppError(504, 'زمان پاسخ سرویس تمام شد.');
    if ($ok === false) throw new AppError(502, 'ارتباط HTTPS با سرویس برقرار نشد.');
    return ['status' => $status, 'body' => $output];
}

function replaceBody(mixed $value, array $values, bool $numeric): mixed {
    if (is_array($value) || is_object($value)) {
        foreach ($value as $name => $item) {
            $replacement = replaceBody($item, $values, $numeric);
            if (is_array($value)) $value[$name] = $replacement;
            else $value->$name = $replacement;
        }
        return $value;
    }
    if (!is_string($value)) return $value;
    $substitute = static fn(array $match): string => $match[1] === 'auth' ? '' : ($values[$match[1]] ?? '');
    if ($numeric && preg_match('/^\{\{(\w+)\}\}$/D', $value, $match)) {
        $replacement = $substitute($match);
        if (preg_match('/^-?(0|[1-9]\d*)$/D', $replacement) && abs((float) $replacement) <= 9007199254740991) {
            return (int) $replacement;
        }
    }
    return preg_replace_callback('/\{\{(\w+)\}\}/', $substitute, $value);
}

function shippingEndpoints(string $service): array {
    $catalog = json_decode(file_get_contents(__DIR__ . '/public/catalog.json'), true, 512, JSON_THROW_ON_ERROR);
    return array_column($catalog[$service], null, 'id');
}

function shipping(string $service, array $values, object $input, int $timeout): array {
    $id = $input->endpoint ?? null;
    $endpoint = is_string($id) ? (shippingEndpoints($service)[$id] ?? null) : null;
    if (!$endpoint) throw new AppError(404, 'مسیر تست پیدا نشد.');
    $url = preg_replace_callback('/\{\{(\w+)\}\}/', static function (array $match) use ($values): string {
        $value = $values[$match[1]] ?? '';
        if (!preg_match('/^[\w=-]+$/D', $value)) throw new AppError(400, 'مقدار ' . $match[1] . ' را بررسی کنید.');
        return $value;
    }, $endpoint['url']);
    $body = null;
    if ($endpoint['method'] === 'POST') {
        try {
            if (!is_string($input->body ?? null)) throw new JsonException();
            $parsed = json_decode($input->body, false, 512, JSON_THROW_ON_ERROR);
            $body = json_encode(replaceBody($parsed, $values, $service === 'post'), JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new AppError(400, 'بدنه درخواست باید JSON معتبر باشد.');
        }
    }
    $start = hrtime(true);
    $result = upstream($url, $start + $timeout * 1_000_000_000, $endpoint['method'], $values['auth'] ?? null, $body);
    $data = $result['status'] >= 200 && $result['status'] < 300 ? json_decode($result['body'], true) : null;
    $entries = $data['entries'] ?? [];
    $first = $entries['list'][0] ?? [];
    $captured = [];
    $fill = static function (string $name, mixed $value, bool $overwrite = false) use (&$captured, $values): void {
        if (($overwrite || ($values[$name] ?? '') === '') && (is_numeric($value) || is_string($value)) && $value !== '') {
            $captured[$name] = (string) $value;
        }
    };
    if ($id === 'shop_list') $fill('shop_id', $first['id'] ?? null);
    if ($service === 'post') {
        if ($id === 'register') {
            $fill('order_id', $entries['order_id'] ?? null, true);
            $fill('order_uuid', $entries['id'] ?? null, true);
        }
        if ($id === 'order_list') {
            $fill('order_id', $first['order_id'] ?? null);
            $fill('order_uuid', $first['id'] ?? null);
        }
        if ($id === 'task_list') $fill('task_id', $first['id'] ?? $first['task_id'] ?? null);
    } else {
        if ($id === 'register') $fill('order_uuid', $entries['uuid'] ?? null, true);
        if ($id === 'full_detail') $fill('hash', ($entries['order'] ?? $data['order'] ?? [])['hash'] ?? null, true);
        if ($id === 'filter') {
            $fill('order_uuid', $first['uuid'] ?? null);
            $fill('hash', ($service === 'tipax' ? ($first['hash_raw'] ?? null) : null) ?: ($first['hash'] ?? null));
        }
    }
    return $result + ['ms' => (int) round((hrtime(true) - $start) / 1e6), 'url' => $url, 'captured' => (object) $captured];
}

function wooStatusLabels(string $url, string $auth, int $deadline): array {
    try {
        $response = upstream($url, $deadline, auth: $auth);
        $rows = json_decode($response['body'], true);
        if ($response['status'] !== 200 || !is_array($rows)) return [];
        $labels = [];
        foreach ($rows as $row) {
            if (is_string($row['slug'] ?? null) && is_string($row['name'] ?? null)) {
                $labels[$row['slug']] = $row['name'];
            }
        }
        return $labels;
    } catch (AppError) {
        return [];
    }
}

function wooOrderStatuses(string $root, string $auth, int $deadline, bool $includeLabels = true): array {
    $labels = [];
    if ($includeLabels) {
        $labels = wooStatusLabels($root . '/tapin/order-statuses', $auth, $deadline);
    }
    if (!$labels) {
        $response = upstream($root . '/orders', $deadline, 'OPTIONS', $auth);
        $data = json_decode($response['body'], true);
        $slugs = $data['schema']['properties']['status']['enum'] ?? [];
        if (!$slugs && !$includeLabels) {
            $labels = wooStatusLabels($root . '/tapin/order-statuses', $auth, $deadline);
        }
        if (!$labels && ($includeLabels || !$slugs)) {
            $labels = wooStatusLabels($root . '/reports/orders/totals?_fields=slug,name', $auth, $deadline);
        }
    }
    $result = [];
    foreach (($slugs ?? []) ?: array_keys($labels) as $slug) {
        if (is_string($slug) && $slug !== 'any') $result[] = ['slug' => $slug, 'name' => $labels[$slug] ?? $slug];
    }
    if (!$result) throw new AppError(502, 'وضعیت‌های سفارش از ووکامرس دریافت نشد. دسترسی خواندن کلید و مسیر REST را بررسی کنید.');
    return $result;
}

function wooOrderInteger(mixed $value, string $label, int $max = 2147483647): int {
    if (!is_int($value) || $value < 1 || $value > $max) {
        throw new AppError(400, $label . ' نامعتبر است.');
    }
    return $value;
}

function wooOrderAction(array $values, object $input, string $action, int $timeout): array {
    $site = wooCredentials($values);
    $root = $site . '/wp-json/wc/v3';
    $auth = 'Basic ' . base64_encode($values['key'] . ':' . $values['secret']);
    $deadline = hrtime(true) + $timeout * 1_000_000_000;
    $host = parse_url($site, PHP_URL_HOST);
    if ($action === 'order-options') return ['host' => $host, 'statuses' => wooOrderStatuses($root, $auth, $deadline)];

    if ($action === 'create-status') {
        $slug = is_string($input->slug ?? null) ? trim($input->slug) : '';
        $name = is_string($input->name ?? null) ? trim($input->name) : '';
        if (!preg_match('/^[a-z][a-z0-9-]{0,16}$/D', $slug) || str_starts_with($slug, 'wc-') ||
            !preg_match('/^.{1,80}$/uD', $name)) {
            throw new AppError(400, 'عنوان وضعیت و شناسه لاتین حداکثر ۱۷ کاراکتری را بررسی کنید.');
        }
        $response = upstream($root . '/tapin/order-statuses', $deadline, 'POST', $auth,
            json_encode(['slug' => $slug, 'name' => $name], JSON_THROW_ON_ERROR));
        $data = json_decode($response['body'], true);
        if ($response['status'] === 404) {
            throw new AppError(422, 'برای ساخت وضعیت، افزونه Tapin Order Statuses را روی همین وردپرس نصب و فعال کنید.');
        }
        if ($response['status'] === 409) throw new AppError(409, 'این وضعیت از قبل وجود دارد. فهرست را دوباره دریافت کنید.');
        if ($response['status'] === 401 || $response['status'] === 403) {
            throw new AppError(403, 'ساخت وضعیت به کلید نوشتن و دسترسی مدیریت ووکامرس نیاز دارد.');
        }
        if ($response['status'] !== 201 || !is_string($data['slug'] ?? null)) {
            throw new AppError(502, 'ساخت وضعیت تأیید نشد. فهرست وضعیت‌ها را دوباره دریافت کنید.');
        }
        return ['slug' => $data['slug'], 'name' => $data['name'] ?? $name, 'host' => $host];
    }

    $count = wooOrderInteger($input->count ?? null, 'تعداد سفارش (۱ تا ۲۰)', 20);
    $product = wooOrderInteger($input->productId ?? null, 'شناسه محصول');
    $quantity = wooOrderInteger($input->quantity ?? null, 'تعداد محصول در هر سفارش');
    $line = ['product_id' => $product, 'quantity' => $quantity];
    if (isset($input->variationId)) $line['variation_id'] = wooOrderInteger($input->variationId, 'شناسه تنوع');
    $status = $input->status ?? null;
    if (!is_string($status) || $status === '') throw new AppError(400, 'وضعیت سفارش را انتخاب کنید.');
    $billing = [];
    foreach (['first_name', 'last_name', 'email', 'phone', 'address_1', 'city', 'postcode', 'country'] as $field) {
        $value = $input->billing->$field ?? '';
        if (!is_string($value) || !preg_match('/^.{0,200}$/uD', $value)) {
            throw new AppError(400, 'یکی از فیلدهای مشتری نامعتبر است.');
        }
        if (trim($value) !== '') $billing[$field] = trim($value);
    }
    if (!empty($billing['email']) && !filter_var($billing['email'], FILTER_VALIDATE_EMAIL)) {
        throw new AppError(400, 'ایمیل مشتری نامعتبر است.');
    }
    if (!empty($billing['country'])) {
        $billing['country'] = strtoupper($billing['country']);
        if (!preg_match('/^[A-Z]{2}$/D', $billing['country'])) throw new AppError(400, 'کد کشور باید دو حرف لاتین باشد.');
    }
    $statuses = wooOrderStatuses($root, $auth, $deadline, false);
    if (!in_array($status, array_column($statuses, 'slug'), true)) {
        throw new AppError(400, 'این وضعیت در فروشگاه موجود نیست. فهرست را دوباره دریافت کنید.');
    }
    $order = ['status' => $status, 'line_items' => [$line]];
    if ($billing) $order['billing'] = $billing;
    try {
        $response = upstream($root . '/orders/batch', $deadline, 'POST', $auth,
            json_encode(['create' => array_fill(0, $count, $order)], JSON_THROW_ON_ERROR));
    } catch (AppError $error) {
        throw new AppError($error->getCode(), $error->getMessage() . ' قبل از ارسال دوباره، سفارش‌های فروشگاه را بررسی کنید.');
    }
    $data = json_decode($response['body'], true);
    if ($response['status'] === 401 || $response['status'] === 403) {
        throw new AppError(403, 'این اتصال مجوز ثبت سفارش ندارد. دسترسی نوشتن کلید را بررسی کنید.');
    }
    if ($response['status'] < 200 || $response['status'] >= 300 || !is_array($data['create'] ?? null)) {
        throw new AppError(502, 'نتیجه ثبت از فروشگاه قابل تأیید نیست. قبل از ارسال دوباره، سفارش‌های فروشگاه را بررسی کنید.');
    }
    $orders = [];
    for ($index = 0; $index < $count; $index++) {
        $entry = $data['create'][$index] ?? [];
        $orders[] = [
            'id' => $entry['id'] ?? null,
            'status' => $entry['status'] ?? null,
            'error' => $entry['error']['message'] ?? (isset($entry['id']) ? null : 'نتیجه این سفارش تأیید نشد.'),
        ];
    }
    return ['host' => $host, 'orders' => $orders];
}

function woo(array $values, object $input, bool $details, int $timeout): array {
    $deadline = hrtime(true) + $timeout * 1_000_000_000;
    $site = wooCredentials($values);
    $auth = 'Basic ' . base64_encode($values['key'] . ':' . $values['secret']);
    $root = $site . '/wp-json/wc/v3';
    if ($details) {
        $query = http_build_query(['_fields' => 'environment.version,environment.wp_version,environment.php_version,environment.wp_memory_limit,security.secure_connection']);
        $response = upstream($root . '/system_status?' . $query, $deadline, auth: $auth);
        $data = json_decode($response['body'], true);
        $env = $data['environment'] ?? null;
        if ($response['status'] !== 200 || !is_array($env)) {
            throw new AppError(502, 'جزئیات سیستم در دسترس نیست. دسترسی کاربر به وضعیت ووکامرس را بررسی کنید. HTTP ' . $response['status']);
        }
        return array_intersect_key($env, array_flip(['version', 'wp_version', 'php_version', 'wp_memory_limit'])) +
            ['https' => $data['security']['secure_connection'] ?? null];
    }
    $limit = filter_var($input->limit ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 100]]);
    if ($limit === false) throw new AppError(400, 'تعداد سفارش باید بین ۱ تا ۱۰۰ باشد.');
    $endpoint = $root . '/orders';
    $response = upstream($endpoint . '?per_page=' . $limit, $deadline, auth: $auth);
    $status = $response['status'];
    if ($status !== 200) {
        throw new AppError(502, match ($status) {
            401 => 'کلید یا رمز را بررسی کنید. کلید باید دسترسی خواندن داشته باشد.',
            403 => 'فروشگاه اجازه مشاهده سفارش‌ها را نداد.',
            404 => 'مسیر سفارش‌ها پیدا نشد. آدرس نصب ووکامرس را بررسی کنید.',
            default => 'خطای فروشگاه. HTTP ' . $status,
        });
    }
    $orders = json_decode($response['body']);
    if (!is_array($orders)) throw new AppError(502, 'پاسخ فروشگاه شامل فهرست سفارش‌ها نیست.');
    $orders = array_map(static function ($order): array {
        if (!isset($order->id)) throw new AppError(502, 'پاسخ فروشگاه شامل فهرست سفارش‌ها نیست.');
        $billing = $order->billing ?? null;
        return [
            'number' => $order->number ?? $order->id, 'status' => $order->status ?? null,
            'total' => $order->total ?? null, 'currency' => $order->currency ?? null,
            'date' => $order->date_created ?? null, 'payment' => $order->payment_method_title ?? null,
            'name' => trim(($billing->first_name ?? '') . ' ' . ($billing->last_name ?? '')),
            'email' => $billing->email ?? null, 'phone' => $billing->phone ?? null,
        ];
    }, $orders);
    $scope = 'unknown';
    try {
        $probe = upstream($endpoint . '/batch', $deadline, 'POST', $auth, '{"create":[],"update":[],"delete":[]}');
        $data = json_decode($probe['body']);
        if ($probe['status'] === 200 && $data === []) $scope = 'write';
        $message = strtr((string) ($data->message ?? ''), ['ي' => 'ی', 'ك' => 'ک']);
        if ($probe['status'] === 401 && ($data->code ?? '') === 'woocommerce_rest_authentication_error' &&
            (preg_match('/does not have write permissions/i', $message) ||
                (preg_match('/نوشتن|نوشتاری|نگارش/u', $message) && preg_match('/ندارد|نیست|ندارید/u', $message)))) {
            $scope = 'read';
        }
    } catch (AppError) {
        // Preserve the orders when the optional permission probe fails.
    }
    return ['scope' => $scope, 'host' => parse_url($site, PHP_URL_HOST), 'orders' => $orders];
}
