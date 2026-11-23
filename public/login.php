<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#10121b">
  <title>ورود | داشبورد تاپین</title>
  <link rel="stylesheet" href="./style.css">
</head>
<body class="login-page">
  <main class="login-card panel">
    <div class="brand"><span class="mark" aria-hidden="true">‹/›</span><span>تاپین<small dir="ltr">TAPIN API</small></span></div>
    <h1>ورود به داشبورد</h1>
    <?php if ($loginError !== ''): ?>
      <p class="status error" role="alert"><?= htmlspecialchars($loginError, ENT_QUOTES, 'UTF-8') ?></p>
    <?php endif; ?>
    <form action="./" method="post">
      <input type="hidden" name="csrf" value="<?= htmlspecialchars($csrf, ENT_QUOTES, 'UTF-8') ?>">
      <label>نام کاربری<input type="text" name="username" dir="ltr" autocomplete="username" required></label>
      <label>رمز عبور<input type="password" name="password" dir="ltr" autocomplete="current-password" required></label>
      <button type="submit" class="primary">ورود</button>
    </form>
  </main>
</body>
</html>
