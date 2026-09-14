const form = document.getElementById('job-form');
const input = document.getElementById('url-input');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('status');
const statusLabel = document.getElementById('status-label');
const statusDetail = document.getElementById('status-detail');
const downloadLink = document.getElementById('download-link');

let pollTimer = null;

function normalizeUrl(value) {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return 'https://' + trimmed;
  }
  return trimmed;
}

function setStatus(label, cls, detail) {
  statusEl.hidden = false;
  statusLabel.textContent = label;
  statusLabel.className = cls || '';
  statusDetail.textContent = detail || '';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (pollTimer) clearInterval(pollTimer);

  const url = normalizeUrl(input.value);
  submitBtn.disabled = true;
  downloadLink.hidden = true;
  setStatus('starting', '', 'Kicking off the crawl…');

  let jobId;
  try {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus('error', 'error', data.error || 'Something went wrong.');
      submitBtn.disabled = false;
      return;
    }
    jobId = data.jobId;
  } catch {
    setStatus('error', 'error', 'Could not reach the server. Try again.');
    submitBtn.disabled = false;
    return;
  }

  setStatus('archiving', '', 'Mirroring pages, styles, and images. This can take a few minutes for larger sites.');

  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      const data = await res.json();
      if (!res.ok) {
        clearInterval(pollTimer);
        setStatus('error', 'error', data.error || 'Job expired.');
        submitBtn.disabled = false;
        return;
      }
      if (data.status === 'done') {
        clearInterval(pollTimer);
        setStatus('done', 'done', 'Ready.');
        downloadLink.hidden = false;
        downloadLink.href = `/api/jobs/${jobId}/download`;
        submitBtn.disabled = false;
      } else if (data.status === 'error') {
        clearInterval(pollTimer);
        setStatus('error', 'error', data.error || 'The crawl failed.');
        submitBtn.disabled = false;
      }
      // else still running — keep polling
    } catch {
      // transient network hiccup, keep polling
    }
  }, 2500);
});
