// Careers page (index.html): list the open positions.
// Each "Apply" button is a real link to apply.html?job=<id>, so a position
// can be shared, bookmarked or opened in a new tab.

let jobs = [];

async function loadJobs() {
  const list = $('jobs-list');
  list.setAttribute('aria-busy', 'true');
  list.replaceChildren(...times(3, () => el('div', { class: 'job-card skeleton', 'aria-hidden': 'true' })));
  clearNotice($('jobs-notice'));
  $('jobs-count').textContent = '';

  const res = await api('/jobs');
  list.setAttribute('aria-busy', 'false');

  if (!res.ok) {
    jobs = [];
    list.replaceChildren(emptyCard(
      'We couldn’t load the open positions',
      'Check your connection and try again.',
      el('button', { type: 'button', class: 'ghost', text: 'Try again', onclick: loadJobs }),
    ));
    return;
  }
  jobs = rows(res.data);
  $('jobs-search').disabled = !jobs.length;
  renderJobs();
}

function renderJobs() {
  const list = $('jobs-list');
  const search = $('jobs-search').value.trim();
  const query = search.toLowerCase();
  const shown = jobs.filter((job) =>
    !query || (job.title + ' ' + (job.requirements || '')).toLowerCase().includes(query));

  $('jobs-count').textContent = jobsCountText(shown.length, jobs.length, query);

  if (!jobs.length) {
    list.replaceChildren(emptyCard(
      'No open positions right now',
      'New roles are posted here as soon as they open. Please check back soon.',
    ));
    return;
  }
  if (!shown.length) {
    list.replaceChildren(emptyCard('No positions match “' + search + '”', 'Try a different keyword.'));
    return;
  }
  list.replaceChildren(...shown.map(jobCard));
  requestAnimationFrame(measureJobCards);
}

function jobsCountText(shown, total, query) {
  if (!total) return '';
  if (query) return shown + ' of ' + total + ' positions';
  return total + (total === 1 ? ' position' : ' positions') + ' open';
}

function emptyCard(title, text, action) {
  return el('div', { class: 'card empty' },
    el('p', { class: 'empty-title', text: title }),
    el('p', { text }),
    action,
  );
}

function jobCard(job) {
  const posted = formatDate(job.created_at);
  return el('article', { class: 'job-card', onclick: toggleJobCard },
    el('div', { class: 'job-icon', 'aria-hidden': 'true' }),
    el('div', { class: 'job-main' },
      el('h3', { class: 'job-title', text: job.title }),
      job.requirements && el('p', { class: 'job-reqs', text: job.requirements }),
      el('div', { class: 'job-meta' },
        posted && el('span', { text: 'Posted ' + posted }),
        el('span', { class: 'job-more', 'aria-hidden': 'true', text: 'Full details' }),
      ),
    ),
    el('a', {
      class: 'btn job-apply',
      href: 'apply.html?job=' + encodeURIComponent(job.id),
      'aria-label': 'Apply for ' + job.title,
    }, 'Apply', el('span', { class: 'arrow', 'aria-hidden': 'true', text: '→' })),
  );
}

// The full description opens on hover. Touch screens have no hover,
// so a tap on the card (anywhere except the Apply link) opens it instead.
function toggleJobCard(event) {
  if (event.target.closest('a')) return;
  event.currentTarget.classList.toggle('open');
}

// Remember each description's full height so the card slides open to exactly
// that size, and mark the cards whose text is longer than the two-line preview.
function measureJobCards() {
  for (const reqs of document.querySelectorAll('#jobs-list .job-reqs')) {
    reqs.style.setProperty('--full', reqs.scrollHeight + 'px');
    reqs.closest('.job-card').classList.toggle('expandable', reqs.scrollHeight > reqs.clientHeight + 2);
  }
}

function formatDate(value) {
  const date = new Date(value || '');
  if (isNaN(date)) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------- Start ----------

$('jobs-search').addEventListener('input', renderJobs);
window.addEventListener('resize', () => requestAnimationFrame(measureJobCards));
$('year').textContent = new Date().getFullYear();

loadJobs();
