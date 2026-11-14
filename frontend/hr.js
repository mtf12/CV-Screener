// HR console: sign in with the team access key, manage positions,
// review applicants and run the AI screening.

const KEY_STORAGE = 'cv_hr_key';

const state = {
  key: readKey(),
  jobs: [],
  job: null,              // the selected position
  candidates: [],         // applicants of the selected position
  filter: 'all',          // all | accepted | rejected | pending
  screening: new Set(),   // ids of positions whose screening is still running
};

// ---------- Access key ----------

// The key is kept in sessionStorage, so it is forgotten when the tab is closed.
// Storage can be blocked (private mode), which is why both calls are wrapped.
function readKey() {
  try { return sessionStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
}

function saveKey(key) {
  try {
    if (key) sessionStorage.setItem(KEY_STORAGE, key);
    else sessionStorage.removeItem(KEY_STORAGE);
  } catch { /* storage blocked */ }
}

// Every HR request carries the key in the x-hr-key header.
// n8n checks it before anything else runs and answers 403 if it is wrong.
function hrApi(path, options = {}) {
  const headers = { ...(options.headers || {}), 'x-hr-key': state.key };
  return api(path, { ...options, headers });
}

function postJson(path, payload) {
  return hrApi(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ---------- Sign in / sign out ----------

function showOnly(view) {
  for (const id of ['boot-view', 'login-view', 'dash-view']) show($(id), id === view);
  show($('logout-btn'), view === 'dash-view');
}

// Any HR endpoint works as a check: a wrong key gets 403, a right one 200.
// Returns true / false, or null when the server could not be reached.
async function checkKey() {
  const res = await hrApi('/candidates?job_id=00000000-0000-0000-0000-000000000000');
  return res.status === 0 ? null : res.ok;
}

async function login(event) {
  event.preventDefault();
  const notice = $('login-notice');
  const key = $('hr-key').value.trim();
  if (!key) {
    setNotice(notice, 'error', 'Enter your access key.');
    return $('hr-key').focus();
  }

  state.key = key;
  setButtonLoading($('login-btn'), true, 'Signing in…');
  const valid = await checkKey();
  setButtonLoading($('login-btn'), false, 'Sign in');

  if (valid === null) {
    return setNotice(notice, 'error', 'We couldn’t reach the server. Check your connection and try again.');
  }
  if (!valid) {
    setNotice(notice, 'error', 'That access key isn’t valid.');
    return $('hr-key').select();
  }
  saveKey(state.key);
  enterDashboard();
}

// Used by "Sign out" and whenever the server rejects the key.
function logout(message = '') {
  saveKey('');
  state.key = '';
  state.job = null;
  state.jobs = [];
  state.candidates = [];
  $('hr-key').value = '';
  if ($('job-dialog').open) $('job-dialog').close();
  showOnly('login-view');
  setNotice($('login-notice'), 'error', message);
  $('hr-key').focus();
}

function sessionExpired() {
  logout('Your session has expired. Please sign in again.');
}

function enterDashboard() {
  clearNotice($('login-notice'));
  showOnly('dash-view');
  state.job = null;
  show($('empty-state'), true);
  show($('job-panel'), false);
  loadJobs();
}

// If a key was saved earlier in this tab, check it is still valid and skip the login form.
async function restoreSession() {
  if (!state.key) return showOnly('login-view');

  showOnly('boot-view');
  const valid = await checkKey();
  if (valid) return enterDashboard();
  if (valid === null) {
    showOnly('login-view');
    return setNotice($('login-notice'), 'error', 'We couldn’t reach the server. Check your connection and sign in again.');
  }
  sessionExpired();
}

function toggleKeyVisibility() {
  const input = $('hr-key');
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  $('toggle-key').setAttribute('aria-pressed', String(visible));
  $('toggle-key').setAttribute('aria-label', visible ? 'Hide access key' : 'Show access key');
}

// ---------- Positions ----------

async function loadJobs() {
  const list = $('job-list');
  list.replaceChildren(...times(3, () => el('div', { class: 'job-item skeleton', 'aria-hidden': 'true' })));
  $('job-count').textContent = 'Loading…';

  const res = await api('/jobs');
  if (!res.ok) {
    state.jobs = [];
    $('job-count').textContent = '';
    list.replaceChildren(el('div', { class: 'nav-message' },
      el('p', { text: 'Couldn’t load positions.' }),
      el('button', { type: 'button', class: 'ghost small', text: 'Try again', onclick: loadJobs }),
    ));
    return;
  }
  state.jobs = rows(res.data);
  renderJobs();
}

function renderJobs() {
  const list = $('job-list');
  const query = $('job-search').value.trim().toLowerCase();
  const jobs = state.jobs.filter((job) => !query || job.title.toLowerCase().includes(query));
  const total = state.jobs.length;
  $('job-count').textContent = total === 1 ? '1 position' : total + ' positions';

  if (!total) {
    list.replaceChildren(navMessage('No positions yet. Create your first one to start receiving applications.'));
    return;
  }
  if (!jobs.length) {
    list.replaceChildren(navMessage('No positions match your filter.'));
    return;
  }
  list.replaceChildren(...jobs.map(jobButton));
}

function navMessage(text) {
  return el('div', { class: 'nav-message' }, el('p', { text }));
}

function jobButton(job) {
  const active = state.job && state.job.id === job.id;
  return el('button', {
    type: 'button',
    class: 'job-item' + (active ? ' active' : ''),
    'aria-current': active ? 'true' : null,
    onclick: () => selectJob(job),
  }, el('span', { class: 'job-item-title', text: job.title }));
}

// ---------- New position dialog ----------

function openJobDialog() {
  $('job-form').reset();
  clearNotice($('job-notice'));
  $('job-dialog').showModal();
  $('job-title').focus();
}

// The dialog stays open while the position is being saved.
function closeJobDialog() {
  if (!$('job-btn').disabled) $('job-dialog').close();
}

async function addJob(event) {
  event.preventDefault();
  const notice = $('job-notice');
  const title = $('job-title').value.trim();
  const requirements = $('job-reqs').value.trim();
  if (!title || !requirements) {
    setNotice(notice, 'error', 'Please enter a job title and its requirements.');
    return (title ? $('job-reqs') : $('job-title')).focus();
  }

  setButtonLoading($('job-btn'), true, 'Publishing…');
  const res = await postJson('/jobs', { title, requirements });
  setButtonLoading($('job-btn'), false, 'Publish position');

  if (res.status === 403) return sessionExpired();
  if (!res.ok || !res.data || !res.data.id) {
    return setNotice(notice, 'error', res.status === 0
      ? 'We couldn’t reach the server. Please try again.'
      : 'The position couldn’t be created. Please try again.');
  }

  $('job-dialog').close();
  $('job-search').value = '';
  state.jobs.unshift(res.data);
  await selectJob(res.data);
  setNotice($('panel-notice'), 'success', 'Position published. It is now visible on the careers page.');
}

// ---------- Selected position ----------

async function selectJob(job) {
  state.job = job;
  state.filter = 'all';
  $('cand-search').value = '';
  renderFilters();
  renderJobs();

  show($('empty-state'), false);
  show($('job-panel'), true);
  $('panel-title').textContent = job.title;
  showRequirements(job.requirements || '');
  clearNotice($('panel-notice'));

  syncScreening();
  await loadCandidates();
}

// Requirements start folded to three lines; "Show full requirements"
// only appears when the text is actually longer than that.
function showRequirements(text) {
  const reqs = $('panel-reqs');
  reqs.textContent = text;
  reqs.classList.add('clamp');
  $('reqs-toggle').textContent = 'Show full requirements';
  requestAnimationFrame(() => show($('reqs-toggle'), reqs.scrollHeight > reqs.clientHeight + 2));
}

function toggleRequirements() {
  const folded = $('panel-reqs').classList.toggle('clamp');
  $('reqs-toggle').textContent = folded ? 'Show full requirements' : 'Show less';
}

// ---------- Applicants ----------

async function loadCandidates() {
  const body = $('cand-body');
  state.candidates = [];
  renderStats(null);
  body.replaceChildren(...times(3, skeletonRow));
  $('refresh-btn').disabled = true;

  const jobId = state.job.id;
  const res = await hrApi('/candidates?job_id=' + encodeURIComponent(jobId));
  if (res.status === 403) return sessionExpired();
  if (!state.job || state.job.id !== jobId) return; // another position was picked meanwhile
  $('refresh-btn').disabled = false;

  if (!res.ok) {
    body.replaceChildren(tableMessage(res.status === 0
      ? 'We couldn’t reach the server. Press Refresh to try again.'
      : 'Couldn’t load applicants. Press Refresh to try again.'));
  } else {
    state.candidates = rows(res.data);
    renderStats(state.candidates);
    renderCandidates();
  }
  syncScreening();
}

function skeletonRow() {
  return el('tr', { class: 'skeleton-row', 'aria-hidden': 'true' },
    ...times(6, () => el('td', {}, el('span', { class: 'skeleton-line' }))));
}

function tableMessage(text) {
  return el('tr', {}, el('td', { colspan: '6', class: 'table-message', text }));
}

// The screening result comes back as an object or a one-item array.
// `key` is used for colours and filters, `label` is what HR sees.
function resultOf(candidate) {
  const screenings = candidate.screenings;
  const result = Array.isArray(screenings) ? screenings[0] : screenings;
  if (!result || !result.status) return { key: 'pending', label: 'Not screened', result: null };

  const status = String(result.status).toLowerCase();
  const key = status === 'accepted' || status === 'rejected' ? status : 'other';
  return { key, label: String(result.status), result };
}

// Score as a whole number between 0 and 100, or null if there is none.
function scoreOf(result) {
  const n = result ? Number(result.score) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

// Counts per result, shown on the stat cards and next to the filter buttons.
// Pass null while loading to show a dash instead of a number.
function renderStats(candidates) {
  const counts = { all: 0, accepted: 0, rejected: 0, pending: 0 };
  for (const c of candidates || []) {
    counts.all += 1;
    const key = resultOf(c).key;
    if (key in counts) counts[key] += 1;
  }
  const text = (key) => (candidates ? String(counts[key]) : '–');

  $('stat-total').textContent = text('all');
  $('stat-accepted').textContent = text('accepted');
  $('stat-rejected').textContent = text('rejected');
  $('stat-pending').textContent = text('pending');
  for (const badge of document.querySelectorAll('[data-count]')) badge.textContent = text(badge.dataset.count);
}

// The stat cards and the filter buttons both work as filters, so they are kept in sync.
function renderFilters() {
  for (const button of document.querySelectorAll('#filters [data-filter], #stats [data-filter]')) {
    const active = button.dataset.filter === state.filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function setFilter(event) {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  state.filter = button.dataset.filter;
  renderFilters();
  renderCandidates();
}

function matchesSearch(candidate, query) {
  if (!query) return true;
  const c = candidate;
  return [c.full_name, c.email, c.phone, c.current_title, c.skills, c.university, c.degree]
    .filter(Boolean).join(' ').toLowerCase().includes(query);
}

function renderCandidates() {
  const body = $('cand-body');
  if (!state.candidates.length) {
    return body.replaceChildren(tableMessage('No applicants yet. Share the careers page to start receiving applications.'));
  }

  const query = $('cand-search').value.trim().toLowerCase();
  const list = state.candidates
    .filter((c) => state.filter === 'all' || resultOf(c).key === state.filter)
    .filter((c) => matchesSearch(c, query))
    // Best score first; applicants without a score keep their original order at the end.
    .map((c, i) => ({ c, i, score: scoreOf(resultOf(c).result) }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.i - b.i)
    .map((x) => x.c);

  if (!list.length) return body.replaceChildren(tableMessage('No applicants match the current filter.'));
  body.replaceChildren(...list.map((c, i) => candidateRow(c, i + 1)));
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  const first = (parts[0] || '?')[0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function experienceText(value) {
  const years = Number(value);
  if (value == null || value === '' || !Number.isFinite(years)) return '';
  return years + (years === 1 ? ' year' : ' years') + ' experience';
}

function candidateRow(c, number) {
  const { key, label, result } = resultOf(c);
  const score = scoreOf(result);
  const experience = experienceText(c.years_experience);
  const education = [c.degree, c.university, c.graduation_year].filter(Boolean).join(' · ');

  return el('tr', { class: 'row-' + key },
    el('td', { class: 'col-num', text: String(number) }),

    el('td', {},
      el('div', { class: 'person' },
        el('span', { class: 'avatar ' + key, 'aria-hidden': 'true', text: initials(c.full_name) }),
        el('div', { class: 'person-text' },
          el('div', { class: 'strong', text: c.full_name || '—' }),
          c.email && el('a', { class: 'sub link', href: 'mailto:' + c.email, text: c.email }),
          c.phone && el('div', { class: 'sub', text: c.phone }),
        ),
      ),
    ),

    el('td', { class: 'profile' },
      el('div', { class: 'strong', text: c.current_title || '—' }),
      experience && el('div', { class: 'sub', text: experience }),
      education && el('div', { class: 'sub', text: education }),
    ),

    el('td', { class: 'result' },
      el('span', { class: 'badge ' + key, text: label }),
      score != null && el('div', { class: 'score', title: 'Match score ' + score + ' of 100' },
        el('span', { class: 'score-bar' }, el('span', { class: 'score-fill ' + key, style: 'width:' + score + '%' })),
        el('span', { class: 'score-num', text: String(score) }),
      ),
    ),

    el('td', { class: 'reason', text: result && result.reason ? result.reason : 'Not screened yet.' }),

    el('td', { class: 'cell-action' },
      c.cv_path
        ? el('button', { type: 'button', class: 'ghost small', text: 'View CV', onclick: (e) => openCv(c.cv_path, e.currentTarget) })
        : el('span', { class: 'sub', text: 'No CV' }),
    ),
  );
}

// CVs live in a private bucket, so n8n hands out a short-lived signed link.
// The tab is opened right away, while we are still inside the click,
// otherwise the browser would block it as a popup.
async function openCv(path, button) {
  const tab = window.open('', '_blank');
  button.disabled = true;
  const res = await hrApi('/cv-link?path=' + encodeURIComponent(path));
  button.disabled = false;

  if (res.status === 403) {
    if (tab) tab.close();
    return sessionExpired();
  }
  if (!res.ok || !res.data || !res.data.url) {
    if (tab) tab.close();
    return setNotice($('panel-notice'), 'error', 'The CV couldn’t be opened. Please try again.');
  }
  if (tab) {
    tab.opener = null;
    tab.location = res.data.url;
  } else {
    window.location = res.data.url;
  }
}

// ---------- AI screening ----------

// Keep the "Screen with AI" button and its notice in line with the selected position.
function syncScreening() {
  if (!state.job) return;
  const running = state.screening.has(state.job.id);
  $('screen-btn').disabled = running || !state.candidates.length;
  if (running) setLoadingNotice($('panel-notice'), 'Screening applicants with AI. This can take a minute…');
}

async function screenCandidates() {
  if (!state.job || state.screening.has(state.job.id)) return;
  const jobId = state.job.id;
  state.screening.add(jobId);
  syncScreening();

  const res = await postJson('/screen', { job_id: jobId });
  state.screening.delete(jobId);

  if (res.status === 403) return sessionExpired();
  if (!state.job || state.job.id !== jobId) return; // HR moved to another position meanwhile

  if (res.ok) setNotice($('panel-notice'), 'success', 'Screening finished. Results are up to date.');
  else setNotice($('panel-notice'), 'error', 'Screening failed. The AI service may be busy, so please try again in a minute.');
  await loadCandidates();
}

// ---------- Start ----------

$('login-form').addEventListener('submit', login);
$('logout-btn').addEventListener('click', () => logout());
$('toggle-key').addEventListener('click', toggleKeyVisibility);

$('new-job-btn').addEventListener('click', openJobDialog);
$('job-cancel').addEventListener('click', closeJobDialog);
$('job-cancel-x').addEventListener('click', closeJobDialog);
$('job-dialog').addEventListener('cancel', (e) => { if ($('job-btn').disabled) e.preventDefault(); }); // Esc while saving
$('job-dialog').addEventListener('click', (e) => { if (e.target === $('job-dialog')) closeJobDialog(); }); // click on the backdrop
$('job-form').addEventListener('submit', addJob);
$('job-search').addEventListener('input', renderJobs);

$('reqs-toggle').addEventListener('click', toggleRequirements);
$('screen-btn').addEventListener('click', screenCandidates);
$('refresh-btn').addEventListener('click', () => state.job && loadCandidates());
$('cand-search').addEventListener('input', renderCandidates);
$('filters').addEventListener('click', setFilter);
$('stats').addEventListener('click', setFilter);
$('year').textContent = new Date().getFullYear();

restoreSession();
