// Shared helpers used by both pages (careers and HR console).

const API = window.CV_CONFIG.API_BASE.replace(/\/$/, '');

const $ = (id) => document.getElementById(id);

// Build a DOM element. Text always goes through textContent, so data coming
// from the database (names, job titles, AI reasons) can never inject HTML.
//   el('button', { class: 'ghost', text: 'Save', onclick: save })
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Call `make` n times and return the results, e.g. a few loading placeholders.
function times(n, make) {
  return Array.from({ length: n }, make);
}

function spinner() {
  return el('span', { class: 'spinner', 'aria-hidden': 'true' });
}

// ---------- Talking to n8n ----------

// Call an n8n webhook. Never throws: a network failure comes back as status 0.
async function api(path, options = {}) {
  try {
    // ngrok's free plan shows a warning page to browsers unless this header is sent.
    const headers = { 'ngrok-skip-browser-warning': 'true', ...(options.headers || {}) };
    const res = await fetch(API + path, { ...options, headers });
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

// n8n answers [{}] when a query has no rows, so keep only real records.
function rows(data) {
  return (Array.isArray(data) ? data : []).filter((r) => r && r.id);
}

// ---------- Showing and hiding things ----------

function show(node, visible) {
  node.hidden = !visible;
}

// Notices are the coloured message boxes (info, success, warn, error).
// An empty message hides the box.
function setNotice(node, kind, message) {
  node.className = 'notice ' + kind;
  node.textContent = message;
  node.hidden = !message;
}

function clearNotice(node) {
  setNotice(node, 'info', '');
}

// An info notice with a spinner, for "please wait" messages.
function setLoadingNotice(node, message) {
  node.className = 'notice info';
  node.replaceChildren(spinner(), message);
  node.hidden = false;
}

// Swap a button's label for a spinner while its request is running.
function setButtonLoading(button, loading, label) {
  button.disabled = loading;
  if (loading) button.replaceChildren(spinner(), label);
  else button.textContent = label;
}
