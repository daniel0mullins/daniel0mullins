// Side effects for alerts: sound, vibration, system notifications and a
// flashing tab title. Everything degrades silently outside a browser or when
// an API is unavailable, so the state machine never depends on this module.

const PATTERNS = {
  calm: { wave: 'triangle', gain: 0.12, notes: [[660, 140], [660, 140]], gap: 110, vibrate: [200, 100, 200] },
  firm: { wave: 'triangle', gain: 0.14, notes: [[740, 140], [740, 140], [740, 140]], gap: 90, vibrate: [250, 80, 250, 80, 250] },
  loud: { wave: 'square', gain: 0.1, notes: [[880, 120], [880, 120], [880, 120], [880, 120]], gap: 70, vibrate: [300, 60, 300, 60, 300, 60, 300] },
  hostile: { wave: 'square', gain: 0.12, notes: [[880, 100], [1175, 100], [880, 100], [1175, 100], [880, 100], [1175, 100]], gap: 50, vibrate: [400, 50, 400, 50, 400, 50, 400, 50, 400] },
};

export function createNotifier(getSettings, env = {}) {
  const win = env.window !== undefined ? env.window : (typeof window !== 'undefined' ? window : null);
  const doc = env.document !== undefined ? env.document : (typeof document !== 'undefined' ? document : null);
  const nav = env.navigator !== undefined ? env.navigator : (typeof navigator !== 'undefined' ? navigator : null);

  let ctx = null;
  let titleTimer = null;
  let activated = false;
  const baseTitle = doc ? doc.title : '';

  function settings() {
    try {
      return getSettings() || {};
    } catch (err) {
      return {};
    }
  }

  /** Create/resume the audio context. Must be called from a user gesture at least once. */
  function unlock() {
    activated = true;
    if (!win) return;
    try {
      const Ctx = win.AudioContext || win.webkitAudioContext;
      if (!Ctx) return;
      if (!ctx) ctx = new Ctx();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch (err) {
      ctx = null;
    }
  }

  function beep(tier) {
    if (!settings().sound || !ctx || ctx.state !== 'running') return;
    const p = PATTERNS[tier] || PATTERNS.calm;
    try {
      let t = ctx.currentTime + 0.01;
      for (const [freq, ms] of p.notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = p.wave;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(p.gain, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + ms / 1000 + 0.02);
        t += ms / 1000 + p.gap / 1000;
      }
    } catch (err) {
      // audio is best-effort
    }
  }

  /** Browsers block vibration until the page has been tapped at least once. */
  function hasActivation() {
    if (nav && nav.userActivation && typeof nav.userActivation.hasBeenActive === 'boolean') {
      return nav.userActivation.hasBeenActive;
    }
    return activated;
  }

  function vibrate(tier) {
    if (!settings().vibrate || !nav || typeof nav.vibrate !== 'function' || !hasActivation()) return;
    try {
      nav.vibrate((PATTERNS[tier] || PATTERNS.calm).vibrate);
    } catch (err) {
      // ignore
    }
  }

  function permission() {
    if (!win || typeof win.Notification === 'undefined') return 'unsupported';
    return win.Notification.permission;
  }

  function requestPermission() {
    if (permission() === 'unsupported') return Promise.resolve('unsupported');
    try {
      const result = win.Notification.requestPermission();
      // Older Safari uses the callback form and returns undefined.
      if (result && typeof result.then === 'function') return result.catch(() => permission());
      return new Promise((resolve) => setTimeout(() => resolve(permission()), 0));
    } catch (err) {
      return Promise.resolve(permission());
    }
  }

  /** System notification when the tab is not visible. */
  function systemNotify(task, u) {
    if (permission() !== 'granted') return;
    if (doc && doc.visibilityState === 'visible') return;
    try {
      const n = new win.Notification(u.heading, {
        body: task.title,
        tag: `nag-${task.id}`,
        renotify: true,
        requireInteraction: true,
      });
      n.onclick = () => {
        try {
          win.focus();
        } catch (err) {
          // ignore
        }
        n.close();
      };
    } catch (err) {
      // ignore
    }
  }

  function flashTitle(text) {
    if (!doc) return;
    stopTitle();
    let on = false;
    titleTimer = setInterval(() => {
      on = !on;
      doc.title = on ? `⚠ ${text}` : baseTitle;
    }, 1000);
  }

  function stopTitle() {
    if (titleTimer) {
      clearInterval(titleTimer);
      titleTimer = null;
    }
    if (doc) doc.title = baseTitle;
  }

  return {
    unlock,
    permission,
    requestPermission,
    /** A new alert (or a re-escalated one) has appeared. */
    alert(task, u) {
      beep(u.tier);
      vibrate(u.tier);
      systemNotify(task, u);
      flashTitle(u.heading);
    },
    /** Periodic reminder while an alert sits unanswered. */
    nag(u) {
      beep(u.tier);
      vibrate(u.tier);
    },
    /** The alert has been answered. */
    stop() {
      stopTitle();
    },
  };
}
