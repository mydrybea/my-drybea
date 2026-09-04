(() => {
  'use strict';

  const SUPABASE_URL = 'https://dztuyfiiyxllnvciunjv.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR6dHV5ZmlpeXhsbG52Y2l1bmp2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwMDg3NjUsImV4cCI6MjEwMzU4NDc2NX0.NT5_fvlwZZr_MQMgerYaIZYHeeJ9l9SrConqcN50M84';
  // The anon/publishable key is intended for browser use. Never put a service_role key here.

  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'sb-dztuyfiiyxllnvciunjv-auth-token'
    }
  });

  const $ = id => document.getElementById(id);
  $('year').textContent = new Date().getFullYear();

  function showError(message) {
    $('statusBox').classList.remove('show');
    $('errBox').textContent = message;
    $('errBox').classList.add('show');
  }
  function showStatus(message) {
    $('errBox').classList.remove('show');
    $('statusBox').textContent = message;
    $('statusBox').classList.add('show');
  }

  // If a valid Supabase session already exists, go to the app.
  (async () => {
    try {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      if (data.session) window.location.replace('index.html');
    } catch (err) {
      showError('Supabase connection error. Check your Supabase URL/key and internet connection.');
      console.error(err);
    }
  })();

  // ---- Rate limiting / brute-force lockout ----
  // Same tier schedule as the server-side RPCs in rate_limiting_setup.sql,
  // kept in sync so the UI feels consistent whichever layer triggers first.
  const LOCK_TIERS = [
    { attempts: 12, ms: 30 * 60 * 1000 },
    { attempts: 8,  ms: 5 * 60 * 1000 },
    { attempts: 5,  ms: 1 * 60 * 1000 }
  ];
  const ATTEMPTS_STORE_KEY = 'my-drybea-login-attempts';

  function readAttemptsStore() {
    try { return JSON.parse(localStorage.getItem(ATTEMPTS_STORE_KEY) || '{}'); }
    catch { return {}; }
  }
  function writeAttemptsStore(store) {
    try { localStorage.setItem(ATTEMPTS_STORE_KEY, JSON.stringify(store)); } catch {}
  }
  function tierLockMs(count) {
    for (const t of LOCK_TIERS) if (count >= t.attempts) return t.ms;
    return 0;
  }
  // Client-side check (fast, offline-capable, but bypassable by clearing storage —
  // this is only the first line of defense; the RPC calls below are authoritative).
  function getClientLock(email) {
    const rec = readAttemptsStore()[email];
    if (!rec || !rec.lockedUntil) return null;
    return rec.lockedUntil > Date.now() ? rec.lockedUntil : null;
  }
  function registerClientFailure(email) {
    const store = readAttemptsStore();
    const rec = store[email] || { count: 0, lockedUntil: 0 };
    if (!rec.lockedUntil || rec.lockedUntil <= Date.now()) rec.count += 1;
    const ms = tierLockMs(rec.count);
    rec.lockedUntil = ms ? Date.now() + ms : 0;
    store[email] = rec;
    writeAttemptsStore(store);
    return rec;
  }
  function clearClientAttempts(email) {
    const store = readAttemptsStore();
    delete store[email];
    writeAttemptsStore(store);
  }

  let lockCountdownTimer = null;
  function formatRemaining(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
  function lockLoginUI(untilMs) {
    const btn = $('loginBtn');
    $('email').disabled = true;
    $('password').disabled = true;
    btn.disabled = true;

    if (lockCountdownTimer) clearInterval(lockCountdownTimer);
    const tick = () => {
      const remaining = untilMs - Date.now();
      if (remaining <= 0) {
        clearInterval(lockCountdownTimer);
        lockCountdownTimer = null;
        $('email').disabled = false;
        $('password').disabled = false;
        btn.disabled = false;
        btn.textContent = '🔐 Access Dashboard';
        $('errBox').classList.remove('show');
        return;
      }
      showError(`Too many failed attempts. Try again in ${formatRemaining(remaining)}.`);
      btn.textContent = `🔒 Locked (${formatRemaining(remaining)})`;
    };
    tick();
    lockCountdownTimer = setInterval(tick, 1000);
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = $('email').value.trim().toLowerCase();
    const password = $('password').value;
    const btn = $('loginBtn');

    $('errBox').classList.remove('show');
    $('statusBox').classList.remove('show');

    if (!email || !password) {
      showError('Please enter both your business email and password.');
      return;
    }

    // 1) Client-side check first — instant, no network needed.
    const clientLockUntil = getClientLock(email);
    if (clientLockUntil) {
      lockLoginUI(clientLockUntil);
      return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Signing in…';

    try {
      // 2) Server-side check — authoritative, can't be bypassed by clearing localStorage.
      const { data: lockData, error: lockErr } = await client.rpc('check_login_lock', { p_email: email });
      if (!lockErr && lockData && lockData[0] && lockData[0].is_locked) {
        const untilMs = new Date(lockData[0].locked_until).getTime();
        lockLoginUI(untilMs);
        return;
      }

      const { data, error } = await client.auth.signInWithPassword({ email, password });

      if (error) {
        // Friendly messages without exposing unnecessary backend details.
        const msg = (error.message || '').toLowerCase();

        if (msg.includes('invalid login credentials')) {
          const clientRec = registerClientFailure(email);
          let serverLockUntil = null;
          try {
            const { data: failData } = await client.rpc('register_failed_login', { p_email: email });
            if (failData && failData[0] && failData[0].is_locked) {
              serverLockUntil = new Date(failData[0].locked_until).getTime();
            }
          } catch (rpcErr) {
            console.error('register_failed_login RPC failed:', rpcErr);
          }

          const lockUntil = serverLockUntil || (clientRec.lockedUntil || null);
          if (lockUntil) {
            lockLoginUI(lockUntil);
          } else {
            const remaining = Math.max(0, 5 - clientRec.count);
            showError(remaining > 0
              ? `Invalid email or password. ${remaining} attempt${remaining === 1 ? '' : 's'} left before a temporary lockout.`
              : 'Invalid email or password.');
          }
        } else if (msg.includes('email not confirmed')) {
          showError('This email has not been confirmed yet. Confirm the user in Supabase Authentication, then try again.');
        } else {
          showError(error.message || 'Login failed. Please try again.');
        }
        return;
      }

      if (!data.session) {
        showError('Login succeeded but no session was returned. Please try again.');
        return;
      }

      clearClientAttempts(email);
      try { await client.rpc('register_successful_login', { p_email: email }); } catch (rpcErr) { console.error('register_successful_login RPC failed:', rpcErr); }

      showStatus('Login successful. Opening dashboard…');
      window.location.replace('index.html');
    } catch (err) {
      console.error(err);
      showError('Could not connect to Supabase. Check your internet connection and Supabase project settings.');
    } finally {
      if (!lockCountdownTimer) {
        btn.disabled = false;
        btn.textContent = '🔐 Access Dashboard';
      }
    }
  });

  // Keep auth state in sync.
  client.auth.onAuthStateChange((event, session) => {
    if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {
      // Do not redirect during an active form submission twice.
    }
  });

  // ---- Forgot password: view toggle (no navigation, no layout shift) ----
  const loginView = $('loginView');
  const forgotView = $('forgotView');

  function openForgotView() {
    $('errBox').classList.remove('show');
    $('statusBox').classList.remove('show');
    $('fpErrBox').classList.remove('show');
    $('fpStatusBox').classList.remove('show');
    $('forgotForm').reset();
    loginView.classList.remove('show');
    forgotView.classList.add('show');
    $('fpEmail').focus({ preventScroll: true });
  }

  function closeForgotView() {
    $('fpErrBox').classList.remove('show');
    $('fpStatusBox').classList.remove('show');
    forgotView.classList.remove('show');
    loginView.classList.add('show');
  }

  $('showForgotBtn').addEventListener('click', openForgotView);
  $('backToLoginBtn').addEventListener('click', closeForgotView);

  function showForgotError(message) {
    $('fpStatusBox').classList.remove('show');
    $('fpErrBox').textContent = message;
    $('fpErrBox').classList.add('show');
  }
  function showForgotStatus(message) {
    $('fpErrBox').classList.remove('show');
    $('fpStatusBox').textContent = message;
    $('fpStatusBox').classList.add('show');
  }

  $('forgotForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = $('fpEmail').value.trim().toLowerCase();
    const btn = $('forgotBtn');

    $('fpErrBox').classList.remove('show');
    $('fpStatusBox').classList.remove('show');

    if (!email) {
      showForgotError('Please enter your business email.');
      return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Sending…';

    try {
      const { error } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname.replace('login.html', 'reset-password.html')
      });

      if (error) {
        showForgotError(error.message || 'Could not send reset link. Please try again.');
        return;
      }

      // Neutral success message regardless of whether the email exists,
      // so the form can't be used to check which emails are registered.
      showForgotStatus('If that email is registered, a password reset link has been sent. Please check your inbox (and spam folder).');
      btn.textContent = '✓ Link Sent';
    } catch (err) {
      console.error(err);
      showForgotError('Could not connect to Supabase. Check your internet connection and try again.');
    } finally {
      btn.disabled = false;
      if (btn.textContent !== '✓ Link Sent') btn.textContent = '✉ Send Reset Link';
    }
  });
})();

(()=>{const r=document.documentElement,s=localStorage.getItem('my-drybea-theme');if(s==='light')r.dataset.theme='light';const b=document.getElementById('themeToggle');const sync=()=>{const l=r.dataset.theme==='light';if(b)b.textContent=l?'☀':'☾';localStorage.setItem('my-drybea-theme',l?'light':'dark')};if(b)b.addEventListener('click',()=>{r.dataset.theme=r.dataset.theme==='light'?'dark':'light';sync()});sync()})();
