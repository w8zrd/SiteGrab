const express = require('express');
const { spawn } = require('child_process');
const dns = require('dns').promises;
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');
const net = require('net');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Configuration ----------------------------------------------------
const PORT = process.env.PORT || 3000;
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 5 * 60 * 1000); // 5 min wall clock per job
const MAX_SITE_BYTES = process.env.MAX_SITE_BYTES || '500m'; // wget --quota
const TMP_ROOT = process.env.TMP_ROOT || path.join(os.tmpdir(), 'sitegrab');
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 15 * 60 * 1000); // delete finished jobs after 15 min

// ---- SSRF protection ---------------------------------------------------
// A public, unauthenticated URL-fetcher is a classic SSRF vector: without
// this check, anyone could point the tool at internal/cloud-metadata IPs.
// This is a baseline safety check, not a content restriction.
function isPrivateOrReservedIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('fe80')) return true; // link-local
    return false;
  }
  return true; // unknown format -> block
}

async function assertPublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('That doesn\'t look like a valid URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are supported.');
  }
  const hostname = parsed.hostname;
  if (hostname === 'localhost') throw new Error('That host isn\'t allowed.');

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error('Could not resolve that hostname.');
  }
  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new Error('That host resolves to a private/internal address and isn\'t allowed.');
    }
  }
  return parsed;
}

// ---- Job management ------------------------------------------------------
const jobs = new Map(); // id -> { status, error, zipPath, dir, createdAt }

function newJobId() {
  return crypto.randomBytes(8).toString('hex');
}

function scheduleCleanup(jobId) {
  setTimeout(async () => {
    const job = jobs.get(jobId);
    if (!job) return;
    jobs.delete(jobId);
    try {
      if (job.dir) await fsp.rm(job.dir, { recursive: true, force: true });
      if (job.zipPath) await fsp.rm(job.zipPath, { force: true });
    } catch (e) {
      console.error('cleanup error', jobId, e.message);
    }
  }, JOB_TTL_MS);
}

async function runWget(targetUrl, outDir) {
  return new Promise((resolve, reject) => {
    const args = [
      '--mirror',              // recursive, timestamping, infinite depth
      '--convert-links',       // rewrite links for local viewing
      '--adjust-extension',    // add .html where needed
      '--page-requisites',     // grab css/js/images needed to render pages
      '--no-parent',           // don't climb above the starting directory
      '--quota=' + MAX_SITE_BYTES, // stop once this much has been downloaded
      '--tries=2',
      '--timeout=20',
      '--random-wait',
      '--wait=0.5',
      '-e', 'robots=off',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '-P', outDir,
      targetUrl,
    ];
    const child = spawn('wget', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, JOB_TIMEOUT_MS);

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      // wget exits non-zero for lots of benign reasons (a few broken links,
      // quota hit, etc). What matters is whether we got any files at all.
      resolve({ code, stderr });
    });
  });
}

async function dirHasFiles(dir) {
  try {
    const entries = await fsp.readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function zipDirectory(sourceDir, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

// ---- Routes ----------------------------------------------------------
app.post('/api/jobs', async (req, res) => {
  const { url: rawUrl } = req.body || {};
  if (!rawUrl) return res.status(400).json({ error: 'Missing url.' });

  let parsed;
  try {
    parsed = await assertPublicUrl(rawUrl);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const jobId = newJobId();
  const dir = path.join(TMP_ROOT, jobId);
  await fsp.mkdir(dir, { recursive: true });

  jobs.set(jobId, { status: 'running', createdAt: Date.now(), dir });
  res.json({ jobId });

  // Run the actual work after responding so the client can start polling.
  (async () => {
    try {
      const { code, stderr } = await runWget(parsed.toString(), dir);
      const gotFiles = await dirHasFiles(dir);
      if (!gotFiles) {
        const hint = (stderr || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
        jobs.set(jobId, {
          ...jobs.get(jobId),
          status: 'error',
          error: 'wget did not download any files. The site may block bots, the URL may be unreachable, or something failed on the server.' + (hint ? ` Details: ${hint}` : ''),
        });
        scheduleCleanup(jobId);
        return;
      }
      const zipPath = path.join(TMP_ROOT, `${jobId}.zip`);
      await zipDirectory(dir, zipPath);
      const job = jobs.get(jobId);
      jobs.set(jobId, { ...job, status: 'done', zipPath, wgetExitCode: code });
      scheduleCleanup(jobId);
    } catch (e) {
      jobs.set(jobId, { ...jobs.get(jobId), status: 'error', error: e.message || 'Download failed.' });
      scheduleCleanup(jobId);
    }
  })();
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found (it may have expired).' });
  res.json({ status: job.status, error: job.error || null });
});

app.get('/api/jobs/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready.' });
  res.download(job.zipPath, 'site.zip');
});

app.listen(PORT, () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  console.log(`sitegrab listening on port ${PORT}`);
});
