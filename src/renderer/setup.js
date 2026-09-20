'use strict';

const $ = (id) => document.getElementById(id);
let resumeText = '';

function applyProviderState(res) {
  const banner = $('provider');
  const needsKey = res.mode === 'needs-key' || res.mode === 'error';

  $('keyField').style.display = needsKey ? '' : 'none';

  if (needsKey) {
    banner.className = 'banner err';
    banner.textContent = res.error;
    $('start').disabled = true;
    return false;
  }

  banner.className = 'banner ok';
  banner.textContent = `Ready — ${res.note}`;
  refreshStartButton();
  return true;
}

async function checkProviders() {
  return applyProviderState(await window.api.checkProviders());
}

$('saveKey').addEventListener('click', async () => {
  const input = $('apikey');
  const btn = $('saveKey');
  const key = input.value.trim();
  if (!key) return;

  btn.disabled = true;
  btn.textContent = 'Saving…';

  const res = await window.api.saveKey(key);

  btn.disabled = false;
  btn.textContent = 'Save';

  if (!res.ok) {
    const banner = $('provider');
    banner.className = 'banner err';
    banner.textContent = res.error;
    return;
  }
  input.value = '';
  applyProviderState(res);
});

$('apikey').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('saveKey').click();
});

function refreshStartButton() {
  const ready =
    resumeText.length > 0 &&
    $('role').value.trim().length > 0 &&
    $('company').value.trim().length > 0 &&
    $('provider').classList.contains('ok');
  $('start').disabled = !ready;
}

$('pick').addEventListener('click', async () => {
  const status = $('resumeStatus');
  status.textContent = 'Reading…';
  status.className = 'resume-status';

  const res = await window.api.pickResume();
  if (!res) { status.textContent = 'No file selected'; return; }

  if (res.error) {
    status.textContent = res.error;
    status.className = 'resume-status';
    resumeText = '';
  } else {
    resumeText = res.text;
    status.textContent = `${res.name} — ${res.chars.toLocaleString()} characters`;
    status.className = 'resume-status loaded';
  }
  refreshStartButton();
});

for (const id of ['role', 'company']) {
  $(id).addEventListener('input', refreshStartButton);
}

$('start').addEventListener('click', async () => {
  const btn = $('start');
  btn.disabled = true;
  btn.textContent = 'Starting…';

  const res = await window.api.startSession({
    resumeText,
    role: $('role').value.trim(),
    company: $('company').value.trim(),
    jobDescription: $('jd').value.trim(),
    focus: $('focus').value.trim(),
  });

  if (!res.ok) {
    const banner = $('provider');
    banner.className = 'banner err';
    banner.textContent = res.error;
    btn.disabled = false;
    btn.textContent = 'Start listening';
    return;
  }

  btn.textContent = `Running — ${res.contextTokens.toLocaleString()} tokens of context cached`;
});

/**
 * The permission banner.
 *
 * Granting Screen Recording is a one-time thing, and this screen's job is to
 * make sure it stays that way: say exactly what is left to do, never offer a
 * button that cannot work, and get out of the way the moment it is granted.
 */
async function checkPermissions() {
  // Windows and Linux have no screen-recording consent gate, so there is
  // nothing to ask for and the banner would be pure confusion.
  if (window.api.platform !== 'darwin') {
    $('permBanner').style.display = 'none';
    return true;
  }

  const st = await window.api.screenStatus();
  const banner = $('permBanner');
  const title = banner.querySelector('strong');
  const grant = $('grantBtn');
  const settings = $('settingsBtn');
  const restart = $('relaunchBtn');
  const steps = $('permSteps');

  if (st.screen === 'granted') {
    banner.style.display = 'none';
    return true;
  }

  banner.style.display = '';

  $('permAppName').textContent = st.appName || 'Help Interview';

  if (st.canPrompt) {
    // macOS has never asked. One click and it will.
    title.textContent = 'Screen Recording permission needed.';
    steps.style.display = 'none';
    grant.style.display = '';
    settings.style.display = 'none';
    restart.style.display = 'none';
  } else if (st.needsRestart) {
    // Already granted at some point — this process just predates it.
    title.textContent = 'Permission granted. Restart to pick it up.';
    steps.style.display = 'none';
    grant.style.display = 'none';
    settings.style.display = 'none';
    restart.style.display = '';
  } else {
    // Refused once. macOS will not ask again, ever, so the button is a lie.
    title.textContent = 'Turn on Screen Recording, then restart.';
    steps.style.display = '';
    grant.style.display = 'none';
    settings.style.display = '';
    restart.style.display = '';
  }
  return false;
}

$('grantBtn').addEventListener('click', async () => {
  const btn = $('grantBtn');
  btn.disabled = true;
  btn.textContent = 'Requesting…';

  const res = await window.api.requestScreenAccess();

  btn.disabled = false;
  btn.textContent = 'Grant permission';
  await checkPermissions();
});

$('settingsBtn').addEventListener('click', () => window.api.openScreenSettings());
$('relaunchBtn').addEventListener('click', () => window.api.relaunch());

// Re-check when the window regains focus. Someone flipping the toggle in
// System Settings comes straight back here, and the banner should already
// say "restart" rather than still asking for something they just did.
window.addEventListener('focus', () => { checkPermissions(); });

checkPermissions();
checkProviders();
