// Apply page (apply.html?job=<id>): load the position from the link, let the
// applicant fill in the form (optionally autofilled from their CV) and submit
// it with the CV attached.

const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Form fields, in the same names the n8n workflows use.
const FIELDS = [
  'full_name', 'email', 'phone', 'current_title', 'years_experience',
  'university', 'degree', 'graduation_year', 'skills',
];

const state = {
  job: null,          // the position being applied for
  file: null,         // the attached CV
  parsing: false,     // a CV is being read by the AI
  submitting: false,
};

function showView(id) {
  for (const view of ['loading-view', 'missing-view', 'apply-view', 'done-view']) show($(view), view === id);
  window.scrollTo(0, 0);
}

// ---------- Loading the position ----------

// There is no endpoint for a single position, so fetch the open ones
// and pick the one whose id is in the link.
async function loadJob() {
  const jobId = new URLSearchParams(location.search).get('job');
  if (!jobId) return showMissing();

  showView('loading-view');
  const res = await api('/jobs');
  if (!res.ok) {
    return showMissing('We couldn’t load this position', 'Check your connection and try again.', true);
  }

  const job = rows(res.data).find((j) => String(j.id) === jobId);
  if (!job) return showMissing();
  openJob(job);
}

function showMissing(
  title = 'This position isn’t available',
  text = 'It may have been filled or closed. Have a look at the other open positions.',
  canRetry = false,
) {
  $('missing-title').textContent = title;
  $('missing-text').textContent = text;
  show($('retry-btn'), canRetry);
  document.title = 'Position not found | CV Analysis';
  showView('missing-view');
}

function openJob(job) {
  state.job = job;
  $('apply-title').textContent = job.title;
  $('apply-reqs').textContent = job.requirements || '';
  document.title = job.title + ' | Careers';
  setFile(null);
  showView('apply-view');
}

// Highlight the current step in the 1-2-3 progress list next to the form.
function updateSteps() {
  const current = state.submitting ? 3 : state.file ? 2 : 1;
  for (const li of $('steps').children) {
    const step = Number(li.dataset.step);
    li.classList.toggle('done', step < current);
    li.classList.toggle('current', step === current);
    if (step === current) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
}

// ---------- The CV file ----------

// There is only one attached file, but it is shown in two places: the autofill
// card at the top and the attachment section at the bottom of the form.
function setFile(file) {
  state.file = file;
  for (const place of ['top', 'bottom']) {
    show($('drop-' + place), !file);
    show($('chip-' + place), !!file);
    $('name-' + place).textContent = file ? file.name : '';
    $('name-' + place).title = file ? file.name : '';
    $('size-' + place).textContent = file ? formatSize(file.size) : '';
  }
  show($('attach-hint'), !file);
  updateSteps();
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// Lock the file buttons and the submit button while a request is running.
function setBusy(busy) {
  for (const id of ['refill-btn', 'remove-top', 'remove-bottom', 'submit-btn']) $(id).disabled = busy;
}

// Quick checks in the browser before anything is uploaded.
function checkFile(file, notice) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    setNotice(notice, 'error', 'Please upload your CV as a PDF file.');
    return false;
  }
  if (file.size > MAX_FILE_BYTES) {
    setNotice(notice, 'error', 'This file is larger than 5 MB. Please upload a smaller PDF.');
    return false;
  }
  return true;
}

// Send the file to the parse-cv workflow, which decides whether the PDF really
// is a CV and reads the details out of it. Both dropzones go through here.
// The verdict is one of: 'cv', 'not_pdf', 'no_text', 'not_cv' or 'unavailable'.
async function readCv(file, notice, busyText) {
  state.parsing = true;
  setFile(file);
  setBusy(true);
  setLoadingNotice(notice, busyText);

  const body = new FormData();
  body.append('cv', file); // must match the binary field name in n8n
  const res = await api('/parse-cv', { method: 'POST', body });

  state.parsing = false;
  setBusy(false);

  if (res.status === 400) return { verdict: 'not_pdf' };
  if (res.status === 422 && res.data && res.data.error === 'no_text') return { verdict: 'no_text' };
  if (res.status === 422 || (res.ok && res.data && res.data.is_cv === false)) return { verdict: 'not_cv' };
  if (!res.ok || !res.data) return { verdict: 'unavailable' }; // AI quota or outage
  return { verdict: 'cv', data: res.data };
}

function rejectFile(verdict, notice) {
  setFile(null);
  const messages = {
    not_pdf: 'Please upload your CV as a PDF file.',
    no_text: 'We couldn’t read any text in this PDF. It may be a scanned image. Please upload a PDF with selectable text.',
    not_cv: 'This file doesn’t look like a CV. Please upload your CV.',
  };
  setNotice(notice, 'error', messages[verdict]);
}

// Bottom dropzone: make sure the file is a CV and attach it. The form is left alone.
async function attachOnly(file) {
  if (!file || state.parsing || state.submitting) return;
  const notice = $('apply-notice');
  if (!checkFile(file, notice)) return;
  clearNotice($('fill-notice'));

  const { verdict } = await readCv(file, notice, 'Checking your file…');
  if (verdict === 'not_pdf' || verdict === 'no_text' || verdict === 'not_cv') return rejectFile(verdict, notice);
  // If the check itself is down, keep the file instead of blocking the applicant.
  setNotice(notice, 'success', 'CV attached.');
}

// Top dropzone and the "Refill form" button: attach the file and let the AI fill in the form.
async function autofill(file) {
  if (!file || state.parsing || state.submitting) return;
  const notice = $('fill-notice');
  if (!checkFile(file, notice)) return;
  clearNotice($('apply-notice'));

  const { verdict, data } = await readCv(file, notice, 'Reading your CV and filling in the form…');
  if (verdict === 'not_pdf' || verdict === 'no_text' || verdict === 'not_cv') return rejectFile(verdict, notice);
  if (verdict === 'unavailable') {
    return setNotice(notice, 'error', 'Autofill isn’t available right now. Your CV is still attached, so you can fill in the form yourself and submit, or press Refill form to try again.');
  }

  const filled = fillForm(data);
  if (!filled) {
    return setNotice(notice, 'warn', 'Your CV is attached, but we couldn’t read any details from it. Please fill in the form yourself.');
  }
  setNotice(notice, 'warn',
    'We filled in ' + filled + ' field' + (filled === 1 ? '' : 's') + ' from your CV. ' +
    'AI can make mistakes, so please check every field before you submit. ' +
    'If something looks wrong, correct it or press Refill form to read the CV again.');
}

// Put the values the AI found into the form. Returns how many fields were filled.
function fillForm(data) {
  let filled = 0;
  for (const name of FIELDS) {
    const value = data[name];
    if (value == null || value === '') continue;
    $(name).value = Array.isArray(value) ? value.join(', ') : value;
    filled += 1;
  }
  return filled;
}

function removeFile() {
  if (state.parsing || state.submitting) return;
  setFile(null);
  clearNotice($('fill-notice'));
  clearNotice($('apply-notice'));
}

// ---------- Submit ----------

const SUBMIT_ERRORS = {
  already_applied: 'You have already applied for this position with this email address.',
  invalid_request: 'Please fill in your name, email and phone number.',
};

async function submitApplication(event) {
  event.preventDefault();
  if (state.parsing || state.submitting) return;
  const notice = $('apply-notice');
  if (!$('apply-form').reportValidity()) return;
  if (!state.file) {
    setNotice(notice, 'error', 'Please attach your CV before submitting.');
    $('drop-bottom').focus();
    return;
  }

  const body = new FormData();
  body.append('cv', state.file);
  body.append('job_id', state.job.id);
  for (const name of FIELDS) body.append(name, $(name).value.trim());

  const button = $('submit-btn');
  state.submitting = true;
  updateSteps();
  setBusy(true);
  setButtonLoading(button, true, 'Submitting…');
  clearNotice(notice);

  const res = await api('/submit-application', { method: 'POST', body });

  state.submitting = false;
  setButtonLoading(button, false, 'Submit application');
  setBusy(false);
  updateSteps();

  if (res.ok && res.data && res.data.ok) {
    $('done-job').textContent = ' for ' + state.job.title;
    return showView('done-view');
  }

  const error = res.data && res.data.error;
  setNotice(notice, 'error', SUBMIT_ERRORS[error]
    || (res.status === 0
      ? 'We couldn’t reach the server. Check your connection and try again.'
      : 'Something went wrong while saving your application. Please try again.'));
}

// ---------- Dropzones ----------

// A dropzone accepts a click (opens the file picker), Enter/Space, or a dragged file.
function wireDropzone(zone, input, onFile) {
  const pick = () => { if (!state.parsing) input.click(); };
  zone.addEventListener('click', pick);
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
  });
  input.addEventListener('change', () => {
    onFile(input.files[0]);
    input.value = ''; // so picking the same file again still fires "change"
  });
  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.remove('over'); });
  }
  zone.addEventListener('drop', (e) => onFile(e.dataTransfer.files[0]));
}

// ---------- Start ----------

// A file dropped outside a dropzone would otherwise make the browser open it and leave the page.
for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());

wireDropzone($('drop-top'), $('input-top'), autofill);
wireDropzone($('drop-bottom'), $('input-bottom'), attachOnly);

$('refill-btn').addEventListener('click', () => autofill(state.file));
$('remove-top').addEventListener('click', removeFile);
$('remove-bottom').addEventListener('click', removeFile);
$('apply-form').addEventListener('submit', submitApplication);
$('retry-btn').addEventListener('click', loadJob);
$('year').textContent = new Date().getFullYear();

loadJob();
