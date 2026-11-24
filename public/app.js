const catalog = await fetch(new URL('./catalog.json', import.meta.url)).then(response => response.json());

const services = {
  woo: { title: 'ووکامرس', description: 'سطح دسترسی کلید فروشگاه را بررسی کنید و آخرین سفارش‌ها را ببینید.', icon: 'W', color: '#bda9ff', fields: ['site', 'key', 'secret'] },
  post: { title: 'پست', description: 'درخواست‌های فروشگاه، سفارش، رهگیری و چاپ را بررسی کنید.', graphic: 'post.svg', color: '#f2c879', fields: ['auth', 'shop_id', 'order_id', 'order_uuid', 'task_id'] },
  tipax: { title: 'تیپاکس', description: 'استعلام قیمت، سفارش‌ها و وضعیت مرسوله‌های تیپاکس را بررسی کنید.', graphic: 'tipax.svg', color: '#f5a99e', fields: ['auth', 'shop_id', 'order_uuid', 'hash'] },
  rail: { title: 'قطاربار', description: 'وب‌سرویس‌های سفارش و رهگیری قطاربار را بررسی کنید.', graphic: 'rail.svg', color: '#89ddcd', fields: ['auth', 'shop_id', 'order_uuid', 'hash'] }
};
const labels = { site: 'آدرس فروشگاه', key: 'کلید دسترسی', secret: 'رمز کلید', auth: 'توکن Authorization',
  shop_id: 'شناسه فروشگاه · shop_id', order_id: 'شناسه سفارش · order_id', order_uuid: 'شناسه سفارش · order_uuid',
  task_id: 'شناسه کار · task_id', hash: 'شناسه چاپ · hash' };
const placeholders = { site: 'https://shop.example.com', key: 'ck_…', secret: 'cs_…', auth: 'jwt …' };
const number = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 8 });
const byId = id => document.getElementById(id);

function node(tag, text = '', className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}
function serviceIcon(config, className = '') {
  const icon = node('span', config.icon ?? '', className);
  icon.setAttribute('aria-hidden', 'true');
  if (config.graphic) {
    const graphic = node('img', '', 'service-graphic');
    graphic.alt = '';
    graphic.src = new URL(config.graphic, import.meta.url).href;
    icon.append(graphic);
  }
  return icon;
}
function button(text, callback, className = '') {
  const element = node('button', text, className);
  element.type = 'button';
  element.addEventListener('click', callback);
  return element;
}
function field(text, control) {
  const label = node('label', text);
  label.append(control);
  return label;
}
function status(text = '') {
  const element = node('p', text, 'status muted');
  element.role = 'status';
  return element;
}
function report(element, text, state = 'muted') {
  element.textContent = text;
  element.className = 'status ' + state;
}
function facts(pairs) {
  const list = node('dl');
  for (const [name, value] of pairs) {
    const group = node('div');
    const description = node('dd');
    description.append(node('bdi', value ?? '—'));
    group.append(node('dt', name), description);
    list.append(group);
  }
  return list;
}
const timeoutKey = 'tapin-timeout:' + new URL('.', import.meta.url).pathname;
let requestTimeout = 18;
try {
  const saved = Number(localStorage.getItem(timeoutKey));
  if (Number.isInteger(saved) && saved >= 1 && saved <= 60) requestTimeout = saved;
} catch {
  // Settings can still be used until the page closes when storage is unavailable.
}

async function api(service, action, input, signal) {
  const response = await fetch(new URL('./api/' + service + '/' + action, import.meta.url), input == null ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal
  });
  let result;
  try {
    result = await response.json();
  } catch (error) {
    if (response.ok || error.name === 'TimeoutError' || error.name === 'AbortError') throw error;
  }
  if (!response.ok) {
    const error = new Error(result?.error ?? 'درخواست ناموفق بود. HTTP ' + response.status);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function sendTest(service, action, input, timeout) {
  // Allow the server time to return its timeout response and any partial results.
  const signal = AbortSignal.timeout((timeout + 2) * 1000);
  try {
    return await api(service, action, { ...input, timeout }, signal);
  } catch (error) {
    if (signal.aborted) {
      const timeoutError = new Error('زمان پاسخ سرویس تمام شد.');
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  }
}

function requestTelemetry() {
  const element = node('span', '', 'request-telemetry');
  const state = node('span', '', 'request-state');
  state.role = 'status';
  const timing = node('span', '', 'request-time');
  const track = node('span', '', 'request-track');
  track.setAttribute('aria-hidden', 'true');
  timing.title = 'زمان پاسخ درخواست HTTP';
  element.append(state, timing, track);
  element.hidden = true;
  let started;
  let timer;

  return {
    element,
    start(timeout) {
      clearInterval(timer);
      started = performance.now();
      element.hidden = false;
      element.dataset.state = 'pending';
      state.textContent = 'در حال ارسال';
      const seconds = new Intl.NumberFormat('fa-IR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      const tick = () => {
        timing.textContent = seconds.format((performance.now() - started) / 1000) + ' / ' + number.format(timeout) + ' ث';
      };
      tick();
      timer = setInterval(tick, 100);
    },
    finish(label, kind, ms = performance.now() - started) {
      clearInterval(timer);
      element.dataset.state = kind;
      state.textContent = label;
      timing.textContent = number.format(Math.round(ms)) + ' میلی‌ثانیه';
    },
    fail(error) {
      this.finish(error.status === 504 ? 'پایان زمان انتظار' : 'خطا', 'error');
    },
    clear() {
      clearInterval(timer);
      element.hidden = true;
    }
  };
}

function connectionPanel(service, onChange) {
  const config = services[service];
  const panel = node('section', '', 'panel');
  const form = node('form');
  form.autocomplete = 'off';
  const heading = node('h2', 'اطلاعات اتصال');
  const picker = node('fieldset', '', 'profile-picker');
  const choices = node('div', '', 'profile-choices');
  const profileCount = node('span', '', 'badge');
  const legend = node('legend', 'اتصال‌ها ');
  legend.append(profileCount);
  picker.append(legend, choices);
  let profiles = [];
  let selectedId = null;
  const name = node('input');
  name.maxLength = 80;
  name.placeholder = 'برای نمونه، فروشگاه اصلی';
  const fields = node('div', '', 'fields');
  const inputs = {};
  for (const key of config.fields) {
    const input = node('input');
    input.dir = 'ltr';
    input.type = ['key', 'secret', 'auth'].includes(key) ? 'password' : key === 'site' ? 'url' : 'text';
    input.maxLength = 4096;
    input.placeholder = placeholders[key] ?? '';
    inputs[key] = input;
    const label = field(labels[key], input);
    if (key === 'site') label.className = 'full';
    fields.append(label);
  }
  const help = node('p', '', 'status muted');
  const message = status();
  const actions = node('div', '', 'actions');
  fields.append(field('نام اتصال برای ذخیره', name));
  const profileId = () => selectedId;
  const payload = () => ({
    profileId: profileId(),
    values: Object.fromEntries(Object.entries(inputs).filter(([, input]) => input.value.trim()).map(([key, input]) => [key, input.value.trim()]))
  });
  function updateHelp() {
    remove.hidden = !profileId();
    save.textContent = profileId() ? 'به‌روزرسانی اتصال' : 'ذخیره اتصال';
    help.textContent = profileId()
      ? 'برای استفاده از مقدار ذخیره‌شده، فیلد مربوط را خالی بگذارید.'
      : 'برای تست فوری، فیلدهای اتصال را پر کنید. ذخیره اختیاری است.';
  }
  function renderProfiles() {
    profileCount.textContent = number.format(profiles.length);
    const options = [{ id: null, name: 'اتصال جدید' }, ...profiles];
    choices.replaceChildren(...options.map(profile => {
      const card = button('', () => select(profile.id), 'profile-choice');
      const icon = serviceIcon(profile.id == null ? { icon: '+' } : config, 'profile-choice-icon');
      card.append(icon, node('span', profile.name));
      card.setAttribute('aria-pressed', String(selectedId === profile.id));
      return card;
    }));
    updateHelp();
  }
  function select(id) {
    if (picker.disabled) return;
    const profile = profiles.find(item => item.id === id);
    if (id != null && !profile) return;
    if (id === selectedId) return;
    selectedId = id;
    for (const input of Object.values(inputs)) input.value = '';
    name.value = profile?.name ?? '';
    report(message, '');
    renderProfiles();
    choices.querySelector('[aria-pressed="true"]')?.focus();
    onChange();
  }
  async function refresh(selected = null) {
    profiles = await api(service, 'profiles');
    selectedId = selected;
    renderProfiles();
  }
  async function busy(operation) {
    const controls = [...form.querySelectorAll('button, input')].filter(control => !picker.contains(control));
    controls.push(picker);
    const enabled = controls.filter(control => !control.disabled);
    for (const control of enabled) control.disabled = true;
    try { await operation(); }
    catch (error) { report(message, error.message, 'error'); }
    finally { for (const control of enabled) control.disabled = false; }
  }
  const save = button('ذخیره اتصال', () => {
    if (inputs.site && !inputs.site.reportValidity()) return;
    void busy(async () => {
      const saved = await api(service, 'profiles', { ...payload(), name: name.value });
      await refresh(saved.id);
      name.value = saved.name;
      for (const input of Object.values(inputs)) input.value = '';
      onChange();
      report(message, 'اتصال ذخیره شد.', 'ok');
    });
  });
  const remove = button('حذف اتصال', () => {
    if (!window.confirm('این اتصال از دیتابیس حذف شود؟')) return;
    void busy(async () => {
      await api(service, 'remove', { profileId: profileId() });
      await refresh();
      name.value = '';
      for (const input of Object.values(inputs)) input.value = '';
      onChange();
      report(message, 'اتصال حذف شد.', 'ok');
    });
  }, 'danger');
  for (const input of Object.values(inputs)) input.addEventListener('input', onChange);
  form.addEventListener('submit', event => event.preventDefault());
  actions.append(save, remove);
  form.append(heading, picker, help, fields, actions, message);
  panel.append(form);
  renderProfiles();
  picker.disabled = true;
  const ready = refresh().catch(error => report(message, error.message, 'error')).finally(() => { picker.disabled = false; });
  return {
    panel, form, fields, inputs, actions, payload, busy,
    async openProfile(profile) {
      await ready;
      if (!profiles.some(item => item.id === profile.id)) await refresh(selectedId);
      if (picker.disabled || !profiles.some(item => item.id === profile.id)) {
        throw new Error('اتصال در دسترس نیست. دوباره تلاش کنید.');
      }
      select(profile.id);
      panel.scrollIntoView({ block: 'nearest' });
    }
  };
}

const orderStatuses = {
  processing: 'در حال انجام', completed: 'تکمیل‌شده', pending: 'در انتظار پرداخت', cancelled: 'لغوشده',
  'on-hold': 'در انتظار بررسی', refunded: 'مستردشده', failed: 'ناموفق'
};
function orderRow(order) {
  const entry = node('details');
  const summary = node('summary', 'سفارش ' + order.number + ' ');
  summary.append(node('span', orderStatuses[order.status] ?? order.status ?? '—', 'badge'));
  const date = new Date(order.date ?? '');
  entry.append(summary, facts([
    ['مشتری', order.name || '—'],
    ['مبلغ', order.total == null ? null : number.format(Number(order.total)) + ' ' + (order.currency ?? '')],
    ['تاریخ', Number.isNaN(+date) ? null : date.toLocaleString('fa-IR')],
    ['ایمیل', order.email], ['تلفن', order.phone], ['روش پرداخت', order.payment]
  ]));
  return entry;
}

function wooView(view) {
  const idle = 'پس از اتصال، سفارش‌ها اینجا نمایش داده می‌شوند.';
  const scopePanel = node('section', '', 'panel');
  const scope = node('strong', 'بررسی نشده', 'scope');
  const note = status('نتیجه بررسی دسترسی اینجا نمایش داده می‌شود.');
  const orderPanel = node('section', '', 'panel full');
  const orderHead = node('div', '', 'topline');
  const count = node('span', '—', 'badge');
  const orderStatus = status(idle);
  const orders = node('div', '', 'orders');
  const ordersResponse = responseViewer('پاسخ ووکامرس (JSON)');
  ordersResponse.panel.hidden = true;
  orderHead.append(node('h2', 'آخرین سفارش‌ها'), count);
  orderPanel.append(orderHead, orderStatus, orders, ordersResponse.panel);
  const dialog = node('dialog');
  dialog.setAttribute('aria-label', 'جزئیات فروشگاه');
  const detailsStatus = status();
  const detailsTiming = requestTelemetry();
  const detailFacts = node('div');
  const detailsResponse = responseViewer('پاسخ جزئیات فروشگاه (JSON)');
  detailsResponse.panel.hidden = true;
  const close = button('بستن', () => dialog.close());
  const dialogHead = node('div', '', 'topline');
  dialogHead.append(node('h2', 'جزئیات فروشگاه'), close);
  dialog.append(dialogHead, detailsTiming.element, detailsStatus, detailFacts, detailsResponse.panel);
  let successfulInput;
  const details = button('جزئیات بیشتر', async () => {
    if (!successfulInput) return;
    details.disabled = true;
    detailFacts.replaceChildren();
    detailsResponse.update('');
    detailsResponse.panel.hidden = true;
    report(detailsStatus, 'در حال دریافت…');
    dialog.showModal();
    const timeout = requestTimeout;
    detailsTiming.start(timeout);
    try {
      const values = await sendTest('woo', 'details', successfulInput, timeout);
      detailsTiming.finish('پاسخ دریافت شد', 'ok');
      detailsResponse.update(JSON.stringify(values, null, 2));
      detailsResponse.panel.hidden = false;
      report(detailsStatus, '');
      detailFacts.append(facts([
        ['نسخه ووکامرس', values.version], ['نسخه وردپرس', values.wp_version],
        ['نسخه PHP', values.php_version],
        ['حافظه وردپرس', typeof values.wp_memory_limit === 'number'
          ? number.format(values.wp_memory_limit / 1048576) + ' مگابایت'
          : values.wp_memory_limit],
        ['HTTPS فروشگاه', values.https == null ? null : values.https ? 'فعال' : 'غیرفعال']
      ]));
    } catch (error) {
      detailsTiming.fail(error);
      report(detailsStatus, error.message, 'error');
    } finally { details.disabled = false; }
  });
  details.hidden = true;
  const ordersTiming = requestTelemetry();
  scopePanel.append(node('h2', 'نوع کلید'), scope, note, ordersTiming.element, node('div', '', 'actions'));
  scopePanel.lastChild.append(details);
  function reset() {
    successfulInput = undefined;
    details.hidden = true;
    scope.textContent = 'بررسی نشده';
    ordersTiming.clear();
    report(note, 'نتیجه بررسی دسترسی اینجا نمایش داده می‌شود.');
    count.textContent = '—';
    report(orderStatus, idle);
    orders.replaceChildren();
    ordersResponse.update('');
    ordersResponse.panel.hidden = true;
  }
  const connection = connectionPanel('woo', reset);
  const limit = node('input');
  Object.assign(limit, { type: 'number', min: '1', max: '100', value: '10', required: true, dir: 'ltr' });
  limit.addEventListener('input', reset);
  connection.fields.append(field('تعداد سفارش', limit));
  const run = button('تست و دریافت سفارش‌ها', () => {
    if (!connection.form.reportValidity()) return;
    const input = { ...connection.payload(), limit: limit.value };
    void connection.busy(async () => {
      reset();
      report(orderStatus, 'در حال دریافت سفارش‌ها…');
      const timeout = requestTimeout;
      ordersTiming.start(timeout);
      try {
        const result = await sendTest('woo', 'run', input, timeout);
        ordersTiming.finish('پاسخ دریافت شد', 'ok');
        scope.textContent = { write: 'خواندن / نوشتن', read: 'فقط خواندن', unknown: 'نامشخص' }[result.scope];
        report(note, result.scope === 'unknown'
          ? 'خواندن تأیید شد. پاسخ فروشگاه برای تشخیص دسترسی نوشتن کافی نبود.'
          : 'دسترسی کلید برای ' + result.host + ' بررسی شد.');
        count.textContent = number.format(result.orders.length) + ' سفارش';
        report(orderStatus, result.orders.length ? 'برای دیدن جزئیات، سفارش را باز کنید.' : 'سفارشی پیدا نشد.');
        orders.replaceChildren(...result.orders.map(orderRow));
        ordersResponse.update(JSON.stringify(result, null, 2));
        ordersResponse.panel.hidden = false;
        successfulInput = input;
        details.hidden = false;
      } catch (error) {
        ordersTiming.fail(error);
        scope.textContent = 'نامشخص';
        report(note, 'دسترسی خواندن تأیید نشد.');
        report(orderStatus, error.message, 'error');
      }
    });
  }, 'primary');
  connection.actions.prepend(run);
  connection.form.addEventListener('submit', () => run.click());
  view.append(connection.panel, scopePanel, orderPanel, dialog);
  return connection;
}

function requestEditor(service, endpoint, request, drafts) {
  const template = JSON.stringify(endpoint.body, null, 2);
  const message = status('در حال بارگیری پیش‌نویس…');
  const retry = button('تلاش دوباره', () => void flush());
  retry.hidden = true;
  let timer;
  let pending;
  let saving = false;

  async function flush() {
    clearTimeout(timer);
    if (saving || pending === undefined) return;
    const body = pending;
    pending = undefined;
    saving = true;
    retry.hidden = true;
    report(message, 'در حال ذخیره…');
    let saved = false;
    try {
      await api(service, 'drafts', { endpoint: endpoint.id, body });
      saved = true;
      if (pending === undefined) report(message, body === null ? 'نمونه پیش‌فرض بازیابی شد.' : 'پیش‌نویس ذخیره شد.', 'ok');
    } catch (error) {
      if (pending === undefined) pending = body;
      report(message, error.message, 'error');
      retry.hidden = false;
    } finally {
      saving = false;
      if (saved && pending !== undefined) void flush();
    }
  }

  function schedule(body, immediately = false) {
    pending = body;
    retry.hidden = true;
    clearTimeout(timer);
    if (immediately) void flush();
    else {
      report(message, 'در انتظار ذخیره…');
      timer = setTimeout(flush, 400);
    }
  }

  const reset = button('بازنشانی JSON', () => {
    request.value = template;
    schedule(null, true);
  });
  request.value = template;
  request.disabled = reset.disabled = true;
  const ready = drafts.then(result => {
    request.value = result.values?.[endpoint.id] ?? template;
    report(message, result.error ?? '', result.error ? 'error' : 'muted');
    request.disabled = reset.disabled = false;
  });
  request.addEventListener('input', () => schedule(request.value));
  request.addEventListener('blur', () => { if (retry.hidden) void flush(); });
  return { message, reset, retry, ready };
}

function responseViewer(label = 'پاسخ سرویس') {
  const panel = node('section', '', 'response-viewer');
  const toolbar = node('div', '', 'response-toolbar');
  const output = node('pre');
  output.dir = 'ltr';
  output.tabIndex = 0;
  output.setAttribute('aria-label', label);
  const copyStatus = status();
  let text = '';
  const copy = button('کپی پاسخ', async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const selection = window.getSelection();
        if (!selection) throw new Error();
        const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
        let copied;
        try {
          selection.selectAllChildren(output);
          copied = document.execCommand('copy');
        } finally {
          selection.removeAllRanges();
          for (const range of ranges) selection.addRange(range);
        }
        if (!copied) throw new Error();
      }
      report(copyStatus, 'پاسخ کپی شد.', 'ok');
    } catch {
      report(copyStatus, 'کپی خودکار انجام نشد. متن پاسخ را انتخاب و کپی کنید.', 'error');
    }
  });

  const search = node('div', '', 'response-search');
  search.hidden = true;
  const input = node('input');
  input.type = 'search';
  input.dir = 'auto';
  input.maxLength = 256;
  input.placeholder = 'جست‌وجو در پاسخ';
  input.setAttribute('aria-label', 'جست‌وجو در پاسخ');
  const count = node('span', '', 'muted');
  count.role = 'status';
  let matches = [];
  let active = 0;

  function render() {
    previous.disabled = next.disabled = matches.length < 2;
    count.textContent = matches.length
      ? number.format(active + 1) + ' از ' + number.format(matches.length)
      : input.value && !search.hidden ? 'نتیجه‌ای پیدا نشد.' : '';
    if (!matches.length) {
      output.textContent = text;
      return;
    }
    const start = matches[active];
    const end = start + input.value.length;
    const mark = node('mark', text.slice(start, end));
    output.replaceChildren(text.slice(0, start), mark, text.slice(end));
    output.scrollTop = mark.offsetTop - output.clientHeight / 2 + mark.offsetHeight / 2;
  }
  function find() {
    matches = [];
    active = 0;
    if (input.value && !search.hidden) {
      const escaped = input.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const match of text.matchAll(new RegExp(escaped, 'giu'))) matches.push(match.index);
    }
    render();
  }
  function move(delta) {
    if (!matches.length) return;
    active = (active + delta + matches.length) % matches.length;
    render();
  }
  const previous = button('قبلی', () => move(-1));
  const next = button('بعدی', () => move(1));
  function toggleSearch(open) {
    search.hidden = !open;
    searchButton.setAttribute('aria-expanded', String(open));
    find();
    if (open) input.focus();
    else searchButton.focus();
  }
  const searchButton = button('جست‌وجو', () => toggleSearch(search.hidden));
  searchButton.setAttribute('aria-expanded', 'false');
  input.addEventListener('input', find);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      toggleSearch(false);
    }
  });
  search.append(input, previous, next, count);
  toolbar.append(copy, searchButton);
  copy.disabled = searchButton.disabled = true;
  panel.append(node('div', label, 'response-label'), toolbar, search, output, copyStatus);

  return {
    panel,
    update(value) {
      text = value;
      copy.disabled = searchButton.disabled = !value;
      report(copyStatus, '');
      output.scrollTop = 0;
      find();
    }
  };
}

function shippingView(service, view) {
  const endpoints = catalog[service];
  const drafts = api(service, 'drafts').then(values => ({ values }), error => ({ error: error.message }));
  const cards = [];
  let running = false;
  const connection = connectionPanel(service, () => {});
  const tools = node('section', '', 'panel');
  const list = node('section', '', 'panel full');
  const heading = node('div', '', 'topline');
  const count = node('span', '', 'badge');
  heading.append(node('h2', 'مسیرهای API'), count);
  list.append(heading);
  const search = node('input');
  search.type = 'search';
  search.placeholder = 'نام یا آدرس مسیر';
  const queueStatus = status();
  const runSafe = button('اجرای گروهی مسیرهای بدون تغییر', () => runQueue());
  tools.append(node('h2', 'ابزار تست'), field('جستجوی مسیر', search), node('div', '', 'actions'), queueStatus);
  tools.querySelector('.actions').append(runSafe);

  async function runQueue() {
    if (running) return;
    const queue = cards.filter(card => !card.endpoint.danger && !card.entry.hidden);
    if (!queue.length) return;
    running = true;
    runSafe.disabled = true;
    const context = connection.payload();
    const timeout = requestTimeout;
    let successful = 0;
    let skipped = 0;
    try {
      for (const [index, card] of queue.entries()) {
        report(queueStatus, number.format(index + 1) + ' / ' + number.format(queue.length) + ' · ' + card.endpoint.title);
        const result = await card.send(context, timeout);
        if (result === null) skipped++;
        else if (result) successful++;
      }
      const summary = number.format(successful) + ' پاسخ موفق از ' + number.format(queue.length) + ' مسیر';
      report(queueStatus, skipped ? summary + ' · ' + number.format(skipped) + ' مسیر در حال ارسال بود' : summary);
    } finally {
      running = false;
      runSafe.disabled = false;
    }
  }
  let group;
  for (const endpoint of endpoints) {
    if (endpoint.group) {
      group = node('h3', endpoint.group);
      list.append(group);
    }
    const entry = node('details');
    const summary = node('summary');
    const title = node('span', '', 'endpoint-title');
    title.append(node('span', endpoint.method, 'method'), node('strong', endpoint.title));
    if (endpoint.danger) title.append(node('small', 'تغییر داده', 'danger'));
    summary.append(title);
    const telemetry = requestTelemetry();
    summary.append(telemetry.element);
    const path = node('code', endpoint.url);
    path.dir = 'ltr';
    const actions = node('div', '', 'actions');
    const response = responseViewer();
    const split = node('div', '', 'split');
    const request = node('textarea');
    request.dir = 'ltr';
    request.spellcheck = false;
    const editor = endpoint.method === 'POST' ? requestEditor(service, endpoint, request, drafts) : null;
    if (editor) {
      const body = node('div');
      body.append(field('بدنه درخواست (JSON)', request), editor.message);
      split.append(body);
      actions.append(editor.reset, editor.retry);
    }
    split.append(response.panel);
    const message = status();
    const open = node('a', 'باز کردن در تب جدید', 'badge');
    open.target = '_blank';
    open.rel = 'noreferrer noopener';
    open.hidden = true;
    async function send(context = connection.payload(), timeout = requestTimeout) {
      if (sendButton.disabled) return null;
      sendButton.disabled = true;
      const values = { ...context.values };
      try {
        await editor?.ready;
        telemetry.start(timeout);
        report(message, '');
        response.update('');
        open.hidden = true;
        const result = await sendTest(service, 'run', {
          profileId: context.profileId, values, endpoint: endpoint.id, body: request.value
        }, timeout);
        const ok = result.status >= 200 && result.status < 300;
        telemetry.finish('HTTP ' + result.status, ok ? 'ok' : 'error', result.ms);
        try { response.update(JSON.stringify(JSON.parse(result.body), null, 2)); }
        catch { response.update(result.body); }
        const live = connection.payload();
        for (const [name, value] of Object.entries(result.captured)) {
          // Reuse captured IDs inside the batch without changing a different connection or newer input.
          context.values[name] = value;
          if (live.profileId === context.profileId && live.values.auth === values.auth &&
              live.values.shop_id === values.shop_id && live.values[name] === values[name]) {
            connection.inputs[name].value = value;
          }
        }
        if (endpoint.html && ok) {
          open.href = result.url;
          open.hidden = false;
        }
        return ok;
      } catch (error) {
        telemetry.fail(error);
        report(message, error.message, 'error');
        return false;
      } finally {
        sendButton.disabled = false;
      }
    }
    const sendButton = button('ارسال درخواست', () => {
      if (!endpoint.danger || window.confirm('این عملیات می‌تواند داده‌ها یا اعتبار سرویس را تغییر دهد. ارسال شود؟')) {
        void send();
      }
    }, 'primary');
    actions.prepend(sendButton);
    actions.append(open);
    entry.append(summary, path);
    if (endpoint.note) entry.append(node('p', endpoint.note, 'muted'));
    entry.append(split, actions, message);
    list.append(entry);
    cards.push({ endpoint, entry, group, send });
  }
  function filter() {
    const query = search.value.trim().toLowerCase();
    const visibleGroups = new Set();
    let shown = 0;
    for (const card of cards) {
      card.entry.hidden = ![card.endpoint.title, card.endpoint.id, card.endpoint.url].some(value => value.toLowerCase().includes(query));
      if (!card.entry.hidden) {
        shown++;
        visibleGroups.add(card.group);
      }
    }
    for (const card of cards) if (card.group) card.group.hidden = !visibleGroups.has(card.group);
    count.textContent = number.format(shown) + ' مسیر';
    runSafe.hidden = !cards.some(card => !card.entry.hidden && !card.endpoint.danger);
  }
  search.addEventListener('input', filter);
  filter();
  view.append(connection.panel, tools, list);
  return connection;
}

const views = new Map();
const nav = byId('nav');
function show(service) {
  const config = services[service];
  for (const tab of nav.children) {
    if (tab.dataset.service === service) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  document.documentElement.style.setProperty('--accent', config.color);
  byId('service-title').textContent = config.title;
  byId('service-description').textContent = config.description;
  byId('hero-icon').replaceChildren(serviceIcon(config, 'hero-service-icon'));
  if (!views.has(service)) {
    const content = node('div', '', 'workspace');
    const connection = service === 'woo' ? wooView(content) : shippingView(service, content);
    views.set(service, { content, connection });
  }
  const current = byId('workspace');
  const { content: next, connection } = views.get(service);
  if (current !== next) {
    current.removeAttribute('id');
    next.id = 'workspace';
    current.replaceWith(next);
  }
  return connection;
}
for (const [service, config] of Object.entries(services)) {
  const tab = button(config.title, () => { location.hash = service; });
  tab.dataset.service = service;
  const icon = serviceIcon(config, 'nav-icon');
  icon.style.setProperty('--nav-color', config.color);
  tab.prepend(icon);
  nav.append(tab);
}
const settings = node('dialog', '', 'request-settings');
settings.setAttribute('aria-label', 'تنظیمات');
const settingsHeader = node('div', '', 'topline');
settingsHeader.append(node('h2', 'تنظیمات'), button('بستن', () => settings.close()));
const settingsForm = node('form');
const timeoutInput = node('input');
Object.assign(timeoutInput, { type: 'number', min: '1', max: '60', step: '1', dir: 'ltr', required: true });
const saveSettings = node('button', 'ذخیره', 'primary');
saveSettings.type = 'submit';
settingsForm.append(field('زمان انتظار پاسخ (ثانیه)', timeoutInput), saveSettings);
settingsForm.addEventListener('submit', event => {
  event.preventDefault();
  requestTimeout = timeoutInput.valueAsNumber;
  try { localStorage.setItem(timeoutKey, String(requestTimeout)); }
  catch { /* The setting remains available for this page. */ }
  settings.close();
});
settings.append(settingsHeader, settingsForm);
document.body.append(settings);
byId('settings-entry').addEventListener('click', () => {
  timeoutInput.value = String(requestTimeout);
  settings.showModal();
  timeoutInput.focus();
});

const directory = node('dialog', '', 'connection-directory');
directory.setAttribute('aria-label', 'لیست اتصال‌ها');
const directoryHeader = node('div', '', 'topline');
directoryHeader.append(node('h2', 'لیست اتصال‌ها'), button('بستن', () => directory.close()));
const directoryStatus = status();
const directoryList = node('div', '', 'connection-groups');
directory.append(directoryHeader, directoryStatus, directoryList);
document.body.append(directory);

const directoryButton = byId('connection-index');
directoryButton.setAttribute('aria-haspopup', 'dialog');
directoryButton.addEventListener('click', async () => {
  directoryList.replaceChildren();
  report(directoryStatus, 'در حال دریافت اتصال‌ها…');
  directory.showModal();
  directoryButton.disabled = true;
  try {
    const entries = Object.entries(services);
    const results = await Promise.allSettled(entries.map(([service]) => api(service, 'profiles')));
    for (const [index, [service, config]] of entries.entries()) {
      const result = results[index];
      const group = node('section', '', 'connection-group');
      group.style.setProperty('--connection-color', config.color);
      const heading = node('h3');
      const serviceName = node('span', '', 'directory-service');
      serviceName.append(serviceIcon(config, 'nav-icon'), node('span', config.title));
      heading.append(serviceName);
      group.append(heading);
      if (result.status === 'fulfilled') {
        heading.append(node('span', number.format(result.value.length), 'badge'));
        if (result.value.length === 0) group.append(node('p', 'اتصال ذخیره‌شده‌ای وجود ندارد.', 'muted'));
        for (const profile of result.value) {
          group.append(button(profile.name, async () => {
            try {
              const connection = show(service);
              location.hash = service;
              await connection.openProfile(profile);
              directory.close();
              connection.panel.querySelector('[aria-pressed="true"]')?.focus();
            } catch (error) {
              report(directoryStatus, error.message, 'error');
            }
          }, 'directory-profile'));
        }
      } else {
        group.append(node('p', result.reason.message, 'error'));
      }
      directoryList.append(group);
    }
    report(directoryStatus, '');
  } finally {
    directoryButton.disabled = false;
  }
});
function selectService() {
  const service = location.hash.slice(1);
  show(Object.hasOwn(services, service) ? service : 'woo');
}
window.addEventListener('hashchange', selectService);
selectService();
