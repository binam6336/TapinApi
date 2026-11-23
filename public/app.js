const catalog = await fetch(new URL('./catalog.json', import.meta.url)).then(response => response.json());

const services = {
  woo: { title: 'ووکامرس', description: 'سطح دسترسی کلید فروشگاه را بررسی کنید و آخرین سفارش‌ها را ببینید.', icon: 'W', color: '#bda9ff', fields: ['site', 'key', 'secret'] },
  post: { title: 'پست', description: 'درخواست‌های فروشگاه، سفارش، رهگیری و چاپ را بررسی کنید.', icon: '✉', color: '#f2c879', fields: ['auth', 'shop_id', 'order_id', 'order_uuid', 'task_id'] },
  tipax: { title: 'تیپاکس', description: 'استعلام قیمت، سفارش‌ها و وضعیت مرسوله‌های تیپاکس را بررسی کنید.', icon: '⇢', color: '#f5a99e', fields: ['auth', 'shop_id', 'order_uuid', 'hash'] },
  rail: { title: 'قطاربار', description: 'وب‌سرویس‌های سفارش و رهگیری قطاربار را بررسی کنید.', icon: '↔', color: '#89ddcd', fields: ['auth', 'shop_id', 'order_uuid', 'hash'] }
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
async function api(service, action, input) {
  const response = await fetch(new URL('./api/' + service + '/' + action, import.meta.url), input == null ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'درخواست ناموفق بود.');
  return result;
}

function connectionPanel(service, onChange) {
  const config = services[service];
  const panel = node('section', '', 'panel');
  const form = node('form');
  form.autocomplete = 'off';
  const heading = node('h2', 'اطلاعات اتصال');
  const profiles = node('select');
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
  const controls = node('div', '', 'fields');
  controls.append(field('اتصال ذخیره‌شده', profiles), field('نام اتصال برای ذخیره', name));
  const profileId = () => profiles.value ? Number(profiles.value) : null;
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
  async function refresh(selected = null) {
    const connections = await api(service, 'profiles');
    profiles.replaceChildren(new Option('اتصال جدید', ''), ...connections.map(connection => new Option(connection.name, connection.id)));
    profiles.value = selected == null ? '' : String(selected);
    updateHelp();
  }
  async function busy(operation) {
    const controls = [...form.querySelectorAll('button, input, select')];
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
  profiles.addEventListener('change', () => {
    for (const input of Object.values(inputs)) input.value = '';
    name.value = profileId() ? profiles.selectedOptions[0].text : '';
    report(message, '');
    updateHelp();
    onChange();
  });
  for (const input of Object.values(inputs)) input.addEventListener('input', onChange);
  form.addEventListener('submit', event => event.preventDefault());
  actions.append(save, remove);
  form.append(heading, controls, help, fields, actions, message);
  panel.append(form);
  updateHelp();
  profiles.disabled = true;
  refresh().catch(error => report(message, error.message, 'error')).finally(() => { profiles.disabled = false; });
  return { panel, form, fields, inputs, actions, payload, busy };
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
  orderHead.append(node('h2', 'آخرین سفارش‌ها'), count);
  orderPanel.append(orderHead, orderStatus, orders);
  const dialog = node('dialog');
  dialog.setAttribute('aria-label', 'جزئیات فروشگاه');
  const detailsStatus = status();
  const detailFacts = node('div');
  const close = button('بستن', () => dialog.close());
  const dialogHead = node('div', '', 'topline');
  dialogHead.append(node('h2', 'جزئیات فروشگاه'), close);
  dialog.append(dialogHead, detailsStatus, detailFacts);
  let successfulInput;
  const details = button('جزئیات بیشتر', async () => {
    if (!successfulInput) return;
    details.disabled = true;
    detailFacts.replaceChildren();
    report(detailsStatus, 'در حال دریافت…');
    dialog.showModal();
    try {
      const values = await api('woo', 'details', successfulInput);
      report(detailsStatus, '');
      detailFacts.append(facts([
        ['نسخه ووکامرس', values.version], ['نسخه وردپرس', values.wp_version],
        ['نسخه PHP', values.php_version],
        ['حافظه وردپرس', typeof values.wp_memory_limit === 'number'
          ? number.format(values.wp_memory_limit / 1048576) + ' مگابایت'
          : values.wp_memory_limit],
        ['HTTPS فروشگاه', values.https == null ? null : values.https ? 'فعال' : 'غیرفعال']
      ]));
    } catch (error) { report(detailsStatus, error.message, 'error'); }
    finally { details.disabled = false; }
  });
  details.hidden = true;
  scopePanel.append(node('h2', 'نوع کلید'), scope, note, node('div', '', 'actions'));
  scopePanel.lastChild.append(details);
  function reset() {
    successfulInput = undefined;
    details.hidden = true;
    scope.textContent = 'بررسی نشده';
    report(note, 'نتیجه بررسی دسترسی اینجا نمایش داده می‌شود.');
    count.textContent = '—';
    report(orderStatus, idle);
    orders.replaceChildren();
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
      try {
        const result = await api('woo', 'run', input);
        scope.textContent = { write: 'خواندن / نوشتن', read: 'فقط خواندن', unknown: 'نامشخص' }[result.scope];
        report(note, result.scope === 'unknown'
          ? 'خواندن تأیید شد. پاسخ فروشگاه برای تشخیص دسترسی نوشتن کافی نبود.'
          : 'دسترسی کلید برای ' + result.host + ' بررسی شد.');
        count.textContent = number.format(result.orders.length) + ' سفارش';
        report(orderStatus, result.orders.length ? 'برای دیدن جزئیات، سفارش را باز کنید.' : 'سفارشی پیدا نشد.');
        orders.replaceChildren(...result.orders.map(orderRow));
        successfulInput = input;
        details.hidden = false;
      } catch (error) {
        scope.textContent = 'نامشخص';
        report(note, 'دسترسی خواندن تأیید نشد.');
        report(orderStatus, error.message, 'error');
      }
    });
  }, 'primary');
  connection.actions.prepend(run);
  connection.form.addEventListener('submit', () => run.click());
  view.append(connection.panel, scopePanel, orderPanel, dialog);
}

function shippingView(service, view) {
  const endpoints = catalog[service];
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

  async function locked(operation) {
    if (running) return;
    running = true;
    runSafe.disabled = true;
    for (const { sendButton } of cards) sendButton.disabled = true;
    try { await connection.busy(operation); }
    finally {
      running = false;
      runSafe.disabled = false;
      for (const { sendButton } of cards) sendButton.disabled = false;
    }
  }
  async function runQueue() {
    if (running) return;
    const queue = cards.filter(card => !card.endpoint.danger && !card.entry.hidden);
    if (!queue.length) return;
    await locked(async () => {
      let successful = 0;
      for (const [index, card] of queue.entries()) {
        report(queueStatus, number.format(index + 1) + ' / ' + number.format(queue.length) + ' · ' + card.endpoint.title);
        if (await card.send()) successful++;
      }
      report(queueStatus, number.format(successful) + ' پاسخ موفق از ' + number.format(queue.length) + ' مسیر');
    });
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
    const summaryStatus = node('small');
    summary.append(summaryStatus);
    const path = node('code', endpoint.url);
    path.dir = 'ltr';
    const actions = node('div', '', 'actions');
    const response = node('pre');
    response.dir = 'ltr';
    const split = node('div', '', 'split');
    const request = node('textarea');
    request.dir = 'ltr';
    request.spellcheck = false;
    if (endpoint.method === 'POST') {
      const template = JSON.stringify(endpoint.body, null, 2);
      request.value = template;
      split.append(field('بدنه درخواست (JSON)', request));
      actions.append(button('بازنشانی JSON', () => { request.value = template; }));
    }
    split.append(field('پاسخ سرویس', response));
    const message = status();
    const open = node('a', 'باز کردن در تب جدید', 'badge');
    open.target = '_blank';
    open.rel = 'noreferrer noopener';
    open.hidden = true;
    async function send() {
      report(message, 'در حال ارسال…');
      summaryStatus.textContent = '…';
      response.textContent = '';
      open.hidden = true;
      try {
        const result = await api(service, 'run', { ...connection.payload(), endpoint: endpoint.id, body: request.value });
        const ok = result.status >= 200 && result.status < 300;
        const short = 'HTTP ' + result.status + ' · ' + result.ms + ' ms';
        report(message, short, ok ? 'ok' : 'error');
        summaryStatus.textContent = short;
        try { response.textContent = JSON.stringify(JSON.parse(result.body), null, 2); }
        catch { response.textContent = result.body; }
        for (const [name, value] of Object.entries(result.captured)) {
          connection.inputs[name].value = value;
        }
        if (endpoint.html && ok) {
          open.href = result.url;
          open.hidden = false;
        }
        return ok;
      } catch (error) {
        report(message, error.message, 'error');
        summaryStatus.textContent = 'خطا';
        return false;
      }
    }
    const sendButton = button('ارسال درخواست', () => {
      if (!endpoint.danger || window.confirm('این عملیات می‌تواند داده‌ها یا اعتبار سرویس را تغییر دهد. ارسال شود؟')) {
        void locked(send);
      }
    }, 'primary');
    actions.prepend(sendButton);
    actions.append(open);
    entry.append(summary, path);
    if (endpoint.note) entry.append(node('p', endpoint.note, 'muted'));
    entry.append(split, actions, message);
    list.append(entry);
    cards.push({ endpoint, entry, group, sendButton, send });
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
  byId('hero-icon').textContent = config.icon;
  if (!views.has(service)) {
    const content = node('div', '', 'workspace');
    if (service === 'woo') wooView(content);
    else shippingView(service, content);
    views.set(service, content);
  }
  const current = byId('workspace');
  const next = views.get(service);
  if (current !== next) {
    current.removeAttribute('id');
    next.id = 'workspace';
    current.replaceWith(next);
  }
}
for (const [service, config] of Object.entries(services)) {
  const tab = button(config.title, () => { location.hash = service; });
  tab.dataset.service = service;
  const icon = node('span', config.icon, 'nav-icon');
  icon.style.setProperty('--nav-color', config.color);
  icon.setAttribute('aria-hidden', 'true');
  tab.prepend(icon);
  nav.append(tab);
}
function selectService() {
  const service = location.hash.slice(1);
  show(Object.hasOwn(services, service) ? service : 'woo');
}
window.addEventListener('hashchange', selectService);
selectService();
