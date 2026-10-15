import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const MAX_LENGTH = 4096;
const DEFAULT_BUTTON_TEXT = '👤 Admin bilan bog‘lanish';
const PENDING_KEY = 'neo-sisra.pending-broadcast';
const MONTHS = ['yan', 'fev', 'mar', 'apr', 'may', 'iyun', 'iyul', 'avg', 'sen', 'okt', 'noy', 'dek'];
const number = (value) => Number.isFinite(value) ? new Intl.NumberFormat('uz-UZ').format(value) : '—';
const date = (value, options = {}) => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tashkent', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(parsed).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const time = `${parts.hour}:${parts.minute}`;
  if (Object.hasOwn(options, 'day') && options.day === undefined && options.month === undefined) return time;
  return `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]}, ${time}`;
};

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, { method = 'GET', body, csrfToken, signal } = {}) {
  let response;
  try {
    response = await fetch(`/api/admin${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
    });
  } catch (error) {
    if (error.name === 'AbortError' && signal?.aborted) throw error;
    throw new ApiError('Server bilan aloqa uzildi. Internet aloqasini tekshirib, qayta urinib ko‘ring.', 0);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(payload?.error || 'So‘rovni bajarib bo‘lmadi. Qayta urinib ko‘ring.', response.status);
  if (!payload) throw new ApiError('Server javobini o‘qib bo‘lmadi. Qayta urinib ko‘ring.', 0);
  return payload;
}

function validateButton(button) {
  const rawText = typeof button?.text === 'string' ? button.text : '';
  const text = rawText.trim();
  const rawUrl = typeof button?.url === 'string' ? button.url : '';
  const url = rawUrl.trim();
  const textError = !text ? 'Tugma nomini kiriting.' : text.length > 64 ? 'Tugma nomi 64 belgidan oshmasligi kerak.' : /[\u0000-\u001f\u007f]/.test(rawText) ? 'Tugma nomini bir qatorda, oddiy matn bilan kiriting.' : '';
  let urlError = '';
  let parsed;
  if (!url) urlError = 'Tugma ochadigan HTTPS havolani kiriting.';
  else if (url.length > 2048) urlError = 'Havola 2 048 belgidan oshmasligi kerak.';
  else {
    try {
      parsed = new URL(url);
      if (!/^https:\/\//i.test(url) || parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || /[\u0000-\u001f\u007f]/.test(rawUrl) || /[\s\\]/.test(url)) {
        urlError = 'Login yoki parolsiz, https:// bilan boshlanadigan to‘liq havola kiriting.';
      } else if (parsed.href.length > 2048) urlError = 'Havola 2 048 belgidan oshmasligi kerak.';
    } catch { urlError = 'To‘g‘ri HTTPS havolani kiriting. Masalan: https://t.me/username'; }
  }
  return { textError, urlError, value: !textError && !urlError ? { text, url: parsed.href } : null };
}

function emptyButtonDraft() { return { enabled: false, text: DEFAULT_BUTTON_TEXT, url: '' }; }

function readPending() {
  try {
    const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY));
    if (pending && typeof pending.text === 'string' && pending.text.length > 0 && pending.text.length <= MAX_LENGTH && /^[0-9a-f-]{36}$/i.test(pending.requestId)) {
      const button = pending.button === undefined ? undefined : validateButton(pending.button).value;
      if (button === null) return null;
      return { text: pending.text, requestId: pending.requestId, ...(button ? { button } : {}) };
    }
  } catch { /* A private browser may disable session storage. */ }
  return null;
}

function Icon({ name, size = 20, ...props }) {
  const paths = {
    send: <><path d="m21 3-7 18-4-7-7-4 18-7Z" /><path d="m10 14 11-11" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87" /><circle cx="9" cy="7" r="4" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    checks: <><path d="m3 12 4 4L17 6m-5 10 9-10" /></>,
    block: <><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></>,
    alert: <><path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></>,
    history: <><path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7" /><path d="M12 7v5l3 2" /></>,
    arrow: <><path d="M4 12h16m-6-6 6 6-6 6" /></>,
    external: <><path d="M14 3h7v7m0-7L10 14" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
    eyeOff: <><path d="m3 3 18 18M9.9 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.9 17.9 0 0 1-3.1 4M6.1 6.1A19 19 0 0 0 2 12s3.5 7 10 7a11.7 11.7 0 0 0 5.9-1.9M10 10a2.8 2.8 0 0 0 4 4" /></>,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m5 14 5-5-5-5m-7 5h12" /></>,
    close: <><path d="m6 6 12 12M6 18 18 6" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></>,
    pause: <><path d="M9 5v14M15 5v14" /></>,
    play: <path d="m8 4 12 8-12 8V4Z" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    chevronDown: <path d="m6 9 6 6 6-6" />,
    document: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" /><path d="M14 2v6h6M8 13h8m-8 4h5" /></>,
    shield: <><path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Z" /><path d="m8 12 3 3 5-6" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name] || paths.info}</svg>;
}

function Brand({ compact = false }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 36 36"><path d="M8 27V9h6l8 12V9h6v18h-6L14 15v12Z" fill="currentColor" /></svg></span><span className="brand-word">neo<span>sisra</span><small>BOT BOSHQARUVI</small></span></div>;
}

function Spinner({ size = 18 }) { return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />; }

function Alert({ children, tone = 'error', onClose }) {
  return <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}><Icon name={tone === 'error' ? 'alert' : 'info'} size={19} /><div>{children}</div>{onClose && <button className="icon-button" type="button" aria-label="Bildirishnomani yopish" onClick={onClose}><Icon name="close" size={16} /></button>}</div>;
}

function Login({ onLogin, notice }) {
  const [username, setUsername] = useState('neo-admin');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitted = useRef(false);
  async function submit(event) {
    event.preventDefault();
    if (submitted.current) return;
    submitted.current = true;
    setBusy(true);
    setError('');
    try { onLogin(await api('/login', { method: 'POST', body: { username: username.trim(), password } })); }
    catch (error) { setError(error.message); }
    finally { submitted.current = false; setBusy(false); }
  }
  return <main className="login-page">
    <section className="login-story" aria-label="Neo Sisra">
      <Brand />
      <div className="story-content"><h1>Har doim<br />aloqada bo‘ling<span>.</span></h1><p>Yangiliklar, muhim eslatmalar va takliflaringizni Neo Sisra bot foydalanuvchilariga yetkazing.</p>
        <div className="story-message"><div className="story-message-icon"><Icon name="send" size={25} /></div><div><strong>Sizning xabaringiz</strong><span>Neo Sisra orqali, to‘g‘ridan to‘g‘ri.</span></div><span className="story-check"><Icon name="checks" size={23} /></span></div>
      </div>
      <div className="story-orbit orbit-one" aria-hidden="true" /><div className="story-orbit orbit-two" aria-hidden="true" />
    </section>
    <section className="login-form-side">
      <div className="mobile-brand"><Brand compact /></div>
      <div className="login-form-wrap"><h2>Xush kelibsiz</h2><p className="login-subtitle">Davom etish uchun hisobingizga kiring.</p>
        {notice && <Alert tone="info">{notice}</Alert>}
        <form onSubmit={submit}>
          <label htmlFor="username">Foydalanuvchi nomi</label>
          <input id="username" name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={100} disabled={busy} spellCheck="false" autoCapitalize="none" />
          <label htmlFor="password">Parol</label><div className="password-input"><input id="password" name="password" type={visible ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Parolingizni kiriting" required disabled={busy} /><button type="button" className="icon-button" aria-label={visible ? 'Parolni yashirish' : 'Parolni ko‘rsatish'} onClick={() => setVisible(!visible)}><Icon name={visible ? 'eyeOff' : 'eye'} /></button></div>
          {error && <Alert>{error}</Alert>}
          <button className="button button-primary login-submit" disabled={busy || !username.trim() || !password} type="submit">{busy ? <><Spinner /> Tekshirilmoqda...</> : <>Panelga kirish <Icon name="arrow" /></>}</button>
        </form>
      </div>
    </section>
  </main>;
}

function ButtonEditor({ value, onChange, disabled, validation }) {
  const [touched, setTouched] = useState({ text: false, url: false });
  const textError = (touched.text || value.text.trim()) && validation.textError;
  const urlError = (touched.url || value.url.trim()) && validation.urlError;
  return <div className="button-editor">
    <div className="button-editor-heading"><div><strong id="button-toggle-label">Tugma qo‘shish</strong><p id="button-toggle-hint">Ixtiyoriy · Xabar ostida havolali tugma chiqadi.</p></div><button type="button" className="button-toggle" role="switch" aria-checked={value.enabled} aria-labelledby="button-toggle-label" aria-describedby="button-toggle-hint" aria-controls="button-fields" disabled={disabled} onClick={() => { setTouched({ text: false, url: false }); onChange({ ...value, enabled: !value.enabled }); }}><span /></button></div>
    {value.enabled && <div className="button-fields" id="button-fields">
      <div><label htmlFor="button-text">Tugma nomi</label><input id="button-text" value={value.text} onChange={(event) => onChange({ ...value, text: event.target.value })} onBlur={() => setTouched((previous) => ({ ...previous, text: true }))} disabled={disabled} placeholder={DEFAULT_BUTTON_TEXT} aria-invalid={Boolean(textError)} aria-describedby={textError ? 'button-text-error button-text-hint' : 'button-text-hint'} /><div className="button-field-hint" id="button-text-hint">Emoji qo‘shishingiz mumkin.<span>{number(value.text.trim().length)} / 64</span></div>{textError && <p className="field-error" id="button-text-error" role="alert">{textError}</p>}</div>
      <div><label htmlFor="button-url">Tugma havolasi</label><input id="button-url" type="url" inputMode="url" autoCapitalize="none" autoComplete="off" spellCheck="false" value={value.url} onChange={(event) => onChange({ ...value, url: event.target.value })} onBlur={() => setTouched((previous) => ({ ...previous, url: true }))} disabled={disabled} placeholder="https://t.me/username" aria-invalid={Boolean(urlError)} aria-describedby={urlError ? 'button-url-error button-url-hint' : 'button-url-hint'} /><p className="button-field-hint" id="button-url-hint">Telegram profil yoki saytning HTTPS manzilini kiriting.</p>{urlError && <p className="field-error" id="button-url-error" role="alert">{urlError}</p>}</div>
    </div>}
  </div>;
}

function SavedButton({ button }) {
  if (!button) return null;
  return <div className="saved-button"><Icon name="external" size={16} /><div><strong>{button.text}</strong><span>{button.url}</span></div></div>;
}

function TelegramPreview({ text, button, compact = false }) {
  return <div className={`telegram-preview ${compact ? 'preview-compact' : ''}`}>
    <div className="telegram-header"><span className="telegram-avatar">N</span><div><strong>Neo Sisra</strong><small>bot</small></div><span className="telegram-dots" aria-hidden="true">⋮</span></div>
    <div className="telegram-chat"><span className="telegram-date">Bugun</span><div className={`telegram-message ${button ? 'telegram-message-with-button' : ''}`}><div className={`telegram-bubble ${!text.trim() ? 'bubble-placeholder' : ''}`}><p>{text.trim() ? text : 'Xabaringiz shu yerda ko‘rinadi. Xabar matnini yozishni boshlang.'}</p><div className="telegram-time">{new Intl.DateTimeFormat('uz-UZ', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }).format(new Date())}<Icon name="checks" size={15} /></div></div>{button && <div className="telegram-inline-button" title={button.url}><span>{button.text.trim() || 'Tugma nomi'}</span><Icon name="external" size={12} /></div>}</div></div>
  </div>;
}

function Modal({ title, subtitle, children, onClose, busy = false }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus?.(); };
  }, []);
  return <dialog className="modal" ref={dialogRef} aria-labelledby={titleId} aria-describedby={subtitle ? descriptionId : undefined} onCancel={(event) => { event.preventDefault(); if (!busy) onClose?.(); }} onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose?.(); }}><div className="modal-content"><div className="modal-header"><div><span className="eyebrow">YUBORISHDAN OLDIN</span><h2 id={titleId}>{title}</h2>{subtitle && <p id={descriptionId}>{subtitle}</p>}</div>{onClose && <button type="button" className="icon-button" aria-label="Oynani yopish" disabled={busy} onClick={onClose}><Icon name="close" /></button>}</div>{children}</div></dialog>;
}

function StatCard({ label, value, icon, tone, subtitle }) {
  return <div className={`stat-card stat-${tone}`}><div className="stat-label"><span>{label}</span><span className="stat-icon"><Icon name={icon} size={19} /></span></div><strong>{number(value)}</strong><p>{subtitle}</p></div>;
}

const jobLabels = { running: 'Yuborilmoqda', done: 'Yakunlandi', interrupted: 'To‘xtab qolgan', cancelled: 'To‘xtatilgan' };
function JobStatus({ status }) { return <span className={`job-badge badge-${status}`}><span />{jobLabels[status] || status}</span>; }

function DeliveryProgress({ job, busy, onResume, onCancel }) {
  const progress = job.total > 0 ? Math.min(100, Math.round(job.processed / job.total * 100)) : 0;
  return <section className="panel delivery-panel" aria-labelledby="delivery-title"><div className="panel-heading"><div><span className="eyebrow">SO‘NGGI XABAR</span><h2 id="delivery-title">{job.status === 'running' ? 'Xabar yetkazilmoqda' : job.status === 'interrupted' ? 'Yuborishni davom ettirish mumkin' : 'Yuborish natijasi'}</h2></div><JobStatus status={job.status} /></div>
    <p className="delivery-excerpt">{job.text}</p>
    {job.button && <div className="delivery-button"><SavedButton button={job.button} /></div>}
    <div className="progress-heading"><span>{number(job.processed)} / {number(job.total)} ta foydalanuvchi</span><strong>{progress}%</strong></div>
    <progress className={`delivery-progress progress-${job.status}`} value={job.processed} max={Math.max(job.total, 1)} aria-label="Yuborish jarayoni" />
    <div className="delivery-breakdown"><span><i className="dot-sent" />{number(job.sent)} yetkazildi</span><span><i className="dot-blocked" />{number(job.blocked)} bloklagan</span><span><i className="dot-failed" />{number(job.failed)} xatolik</span>{job.unknown > 0 && <span><i className="dot-unknown" />{number(job.unknown)} noma’lum</span>}<span className="remaining-count">{number(job.remaining)} qoldi</span></div>
    {job.unknown > 0 && <Alert tone="info">{number(job.unknown)} ta xabarning yetkazilganini tasdiqlab bo‘lmadi. Takroriy xabar yubormaslik uchun bu foydalanuvchilarga avtomatik qayta yuborilmaydi.</Alert>}
    {job.status === 'interrupted' && <Alert tone="info">Yuborish jarayoni uzilib qolgan. Davom ettirsangiz, xabar hali yuborilmagan foydalanuvchilarga yetkaziladi.</Alert>}
    <div className="delivery-footer"><span><Icon name="history" size={15} /> {date(job.createdAt)}{job.finishedAt ? ` · Tugadi: ${date(job.finishedAt, { day: undefined, month: undefined })}` : ''}</span><div>{job.status === 'interrupted' && <button className="button button-primary button-small" disabled={busy} onClick={onResume}>{busy ? <Spinner size={15} /> : <Icon name="play" size={15} />} Davom ettirish</button>}{['running', 'interrupted'].includes(job.status) && <button className="button button-quiet button-small stop-button" disabled={busy} onClick={onCancel}><Icon name="pause" size={15} /> To‘xtatish</button>}</div></div>
  </section>;
}

function History({ history, loading, expanded, setExpanded }) {
  return <section className="panel history-panel" id="history" aria-labelledby="history-title"><div className="panel-heading"><div><span className="eyebrow">YUBORILGAN XABARLAR</span><h2 id="history-title">Xabarlar tarixi <span className="count-tag">{number(history?.length || 0)}</span></h2></div><span className="history-caption">Eng so‘nggi yuborishlar</span></div>
    {loading ? <div className="empty-state"><Spinner /><span>Tarix yuklanmoqda...</span></div> : !history?.length ? <div className="empty-state"><span className="empty-icon"><Icon name="history" size={26} /></span><strong>Hali xabar yuborilmagan</strong><p>Birinchi xabaringizni yuboring. Natijalar shu yerda saqlanadi.</p></div> : <div className="history-list">{history.map((job) => <article className="history-item" key={job.id}><button className="history-row" onClick={() => setExpanded(expanded === job.id ? null : job.id)} aria-expanded={expanded === job.id} aria-controls={`history-${job.id}`}><span className="history-message-icon"><Icon name="send" size={18} /></span><span className="history-message"><strong>{job.text}</strong><small>{date(job.createdAt)}</small></span><span className="history-metric"><strong>{number(job.sent)} <span>/ {number(job.total)}</span></strong><small>yetkazildi</small></span><JobStatus status={job.status} /><Icon name="chevronDown" size={17} className={`history-chevron ${expanded === job.id ? 'expanded' : ''}`} /></button>{expanded === job.id && <div className="history-detail" id={`history-${job.id}`}><p>{job.text}</p><SavedButton button={job.button} /><div className="history-detail-stats"><span><strong>{number(job.sent)}</strong> yetkazildi</span><span><strong>{number(job.blocked)}</strong> botni bloklagan</span><span><strong>{number(job.failed)}</strong> xatolik</span>{job.unknown > 0 && <span><strong>{number(job.unknown)}</strong> noma’lum</span>}<span><strong>{number(job.remaining)}</strong> yuborilmagan</span></div></div>}</article>)}</div>}
  </section>;
}

function Dashboard({ session, onUnauthorized, onLogout, draft, setDraft, buttonDraft, setButtonDraft, pending, setPending }) {
  const [dashboard, setDashboard] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notification, setNotification] = useState('');
  const [reload, setReload] = useState(0);
  const [confirm, setConfirm] = useState(Boolean(pending));
  const [confirmError, setConfirmError] = useState('');
  const [sending, setSending] = useState(false);
  const [jobAction, setJobAction] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [activeNav, setActiveNav] = useState('compose');
  const mutationLock = useRef(false);
  const latestRequest = useRef(0);
  const textRef = useRef(null);
  const currentJob = dashboard?.job;
  const inProgress = currentJob && ['running', 'interrupted'].includes(currentJob.status);
  const overLimit = draft.length > MAX_LENGTH;
  const buttonValidation = validateButton(buttonDraft);
  const buttonInvalid = buttonDraft.enabled && !buttonValidation.value;
  const composeLocked = Boolean(pending) || sending || Boolean(inProgress);
  const previewButton = pending ? pending.button : buttonDraft.enabled ? { text: buttonDraft.text, url: buttonDraft.url } : undefined;
  const canSend = draft.trim().length > 0 && !overLimit && !buttonInvalid && dashboard && dashboard.audienceCount > 0 && !inProgress && !pending && !loadError && !sending;

  useEffect(() => {
    let stopped = false;
    let timer;
    const controller = new AbortController();
    async function poll() {
      const requestVersion = ++latestRequest.current;
      let nextDelay = 10000;
      try {
        const result = await api('/dashboard', { signal: controller.signal });
        if (stopped) return;
        if (requestVersion === latestRequest.current) { setDashboard(result); setLoadError(''); }
        nextDelay = result.job?.status === 'running' ? 1500 : 10000;
      } catch (error) {
        if (stopped || error.name === 'AbortError') return;
        if (error.status === 401) { onUnauthorized(); return; }
        setLoadError(error.message);
        nextDelay = 5000;
      }
      if (!stopped) timer = setTimeout(poll, nextDelay);
    }
    poll();
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [reload, onUnauthorized]);

  function mergeJob(job) {
    latestRequest.current++;
    setDashboard((previous) => previous ? { ...previous, job } : previous);
    setReload((value) => value + 1);
  }

  async function sendBroadcast() {
    if (mutationLock.current || (!pending && !canSend)) return;
    const request = pending || { text: draft, requestId: crypto.randomUUID(), ...(buttonDraft.enabled ? { button: buttonValidation.value } : {}) };
    setPending(request);
    mutationLock.current = true;
    setSending(true);
    setConfirmError('');
    try {
      const { job } = await api('/broadcasts', { method: 'POST', csrfToken: session.csrfToken, body: request });
      mergeJob(job);
      setPending(null);
      if (draft === request.text) setDraft('');
      setButtonDraft(emptyButtonDraft());
      setConfirm(false);
      setNotification(job.status === 'running' ? 'Xabar yuborish boshlandi. Natijalarni quyida kuzatishingiz mumkin.' : job.status === 'done' ? 'Xabar yuborish yakunlangan. Natijalarni quyida ko‘rishingiz mumkin.' : job.status === 'interrupted' ? 'Oldingi yuborish topildi. Jarayon to‘xtab qolgan, uni quyida davom ettirish mumkin.' : 'Oldingi yuborish topildi. Jarayon to‘xtatilgan, natijalar quyida ko‘rsatilgan.');
    } catch (error) {
      if (error.status === 401) { onUnauthorized(); return; }
      if (error.status >= 400 && error.status < 500 && error.status !== 429) setPending(null);
      setConfirmError(error.message);
    } finally { mutationLock.current = false; setSending(false); }
  }

  async function mutateJob(action) {
    if (!currentJob || mutationLock.current) return;
    mutationLock.current = true;
    setJobAction(true);
    setActionError('');
    try {
      const { job } = await api(`/broadcasts/${encodeURIComponent(currentJob.id)}/${action}`, { method: 'POST', csrfToken: session.csrfToken, body: {} });
      mergeJob(job);
      setCancelConfirm(false);
      setNotification(action === 'resume' ? 'Xabar yuborish davom ettirildi.' : 'Yuborish to‘xtatildi. Oldin yuborilgan xabarlar saqlanadi.');
    } catch (error) {
      if (error.status === 401) onUnauthorized();
      else setActionError(error.message);
    } finally { mutationLock.current = false; setJobAction(false); }
  }

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setActionError('');
    try { await api('/logout', { method: 'POST', csrfToken: session.csrfToken, body: {} }); onLogout(); }
    catch (error) { if (error.status === 401) onLogout(); else setActionError(error.message); }
    finally { setLoggingOut(false); }
  }

  function navigate(section) {
    setActiveNav(section);
    document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (section === 'compose') textRef.current?.focus({ preventScroll: true });
  }

  return <div className="app-shell">
    <aside className="sidebar"><Brand /><div className="sidebar-section-label">ISH MAYDONI</div><nav aria-label="Asosiy menyu"><button className={`nav-link ${activeNav === 'compose' ? 'active' : ''}`} onClick={() => navigate('compose')}><Icon name="send" /> Xabar yuborish <Icon name="chevron" size={15} /></button><button className={`nav-link ${activeNav === 'history' ? 'active' : ''}`} onClick={() => navigate('history')}><Icon name="history" /> Xabarlar tarixi</button></nav><div className="sidebar-footer"><span className="account-avatar">N</span><div><strong>{session.username}</strong><small>Administrator</small></div><button className="icon-button logout-button" title="Hisobdan chiqish" aria-label="Hisobdan chiqish" disabled={loggingOut} onClick={logout}>{loggingOut ? <Spinner size={17} /> : <Icon name="logout" size={19} />}</button></div></aside>
    <main className="workspace"><header className="topbar"><div className="breadcrumb"><span>Boshqaruv paneli</span><Icon name="chevron" size={13} /><strong>Xabarlar</strong></div><div className="topbar-actions"><div className={`connection-status ${loadError ? 'connection-error' : ''}`}><span className="status-dot" />{loadError ? 'Aloqa uzildi' : dashboard ? 'Panel ulangan' : 'Ulanmoqda...'}</div><button className="icon-button mobile-logout" title="Hisobdan chiqish" aria-label="Hisobdan chiqish" disabled={loggingOut} onClick={logout}>{loggingOut ? <Spinner size={17} /> : <Icon name="logout" size={19} />}</button></div></header>
      <div className="workspace-content"><h1 className="sr-only">Xabar yuborish</h1>
        {dashboard?.demoMode && <Alert tone="info">Demo rejimi · Haqiqiy foydalanuvchilarga xabar yuborilmaydi.</Alert>}
        {loadError && <Alert>{loadError} <button className="text-button" onClick={() => setReload((value) => value + 1)}>Yangilash</button></Alert>}
        {actionError && !cancelConfirm && <Alert onClose={() => setActionError('')}>{actionError}</Alert>}
        {notification && <Alert tone="success" onClose={() => setNotification('')}>{notification}</Alert>}
        <div className="stats-grid"><StatCard label="Qabul qiluvchilar" value={dashboard?.audienceCount} icon="users" tone="audience" subtitle="Xabar yuborish uchun auditoriya" /><StatCard label="Yetkazildi" value={currentJob?.sent} icon="checks" tone="sent" subtitle="So‘nggi yuborish natijasi" /><StatCard label="Botni bloklagan" value={currentJob?.blocked} icon="block" tone="blocked" subtitle="So‘nggi yuborishda aniqlangan" /><StatCard label="Xatoliklar" value={currentJob?.failed} icon="alert" tone="failed" subtitle="Yetkazib bo‘lmagan xabarlar" /></div>
        <div className="composer-layout" id="compose"><section className="panel compose-panel" aria-labelledby="compose-title"><div className="panel-heading"><div><span className="eyebrow">YANGI XABAR</span><h2 id="compose-title">Nima yangilik?</h2></div><span className="panel-icon"><Icon name="document" size={20} /></span></div><div className="compose-body"><label htmlFor="message">Xabar matni</label><div className={`textarea-wrap ${overLimit ? 'textarea-error' : ''}`}><textarea ref={textRef} id="message" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={'Salom! Siz bilan muhim yangilikni\nulashmoqchimiz...'} disabled={composeLocked} aria-describedby="message-hint message-counter" aria-invalid={overLimit} /><div className="textarea-footer"><span id="message-hint">Oddiy matn · Havola qo‘shish mumkin</span><span className={overLimit ? 'over-limit' : ''} id="message-counter">{number(draft.length)} <span>/ 4 096</span></span></div></div>{overLimit && <p className="field-error" role="alert">Matn 4 096 belgidan oshmasligi kerak. {number(draft.length - MAX_LENGTH)} ta belgini qisqartiring.</p>}<ButtonEditor value={buttonDraft} onChange={setButtonDraft} disabled={composeLocked} validation={buttonValidation} />{inProgress && <Alert tone="info">{currentJob.status === 'running' ? 'Hozir xabar yuborilmoqda. Yangi xabar uchun jarayon tugashini kuting.' : 'Oldingi yuborish to‘xtab qolgan. Avval uni davom ettiring yoki to‘xtating.'}</Alert>}{dashboard?.audienceCount === 0 && <Alert tone="info">Hozircha botda xabar yuborish mumkin bo‘lgan foydalanuvchilar yo‘q.</Alert>}{pending && <Alert tone="info">Oldingi yuborish so‘rovi javobi kutilmoqda. <button className="text-button" onClick={() => setConfirm(true)}>So‘rovni tekshirish</button></Alert>}</div><div className="compose-footer"><span><Icon name="shield" size={15} /> Yuborishdan oldin tasdiqlaysiz</span><button className="button button-primary" disabled={!canSend} onClick={() => { setConfirmError(''); setConfirm(true); }}><Icon name="send" size={18} /> Xabarni yuborish</button></div></section>
          <aside className="preview-column"><div className="preview-heading"><Icon name="eye" size={17} /><strong>Oldindan ko‘rish</strong><span>TELEGRAM</span></div><TelegramPreview text={draft} button={previewButton} /></aside>
        </div>
        {currentJob && <DeliveryProgress job={currentJob} busy={jobAction} onResume={() => mutateJob('resume')} onCancel={() => { setActionError(''); setCancelConfirm(true); }} />}
        <History history={dashboard?.history} loading={!dashboard && !loadError} expanded={expanded} setExpanded={setExpanded} />
        <footer className="workspace-footer"><span>Neo Sisra <span>·</span> Boshqaruv paneli</span><span>Vaqt: Toshkent (UTC+5)</span></footer>
      </div>
    </main>
    {confirm && <Modal title={pending ? 'Yuborish holatini tekshirish' : 'Xabarni yuboramizmi?'} subtitle={pending ? 'Qayta urinish avvalgi so‘rovni takroriy yuborishsiz tekshiradi.' : `Xabar ${number(dashboard?.audienceCount)} ta foydalanuvchiga bot nomidan yuboriladi.`} busy={sending} onClose={() => setConfirm(false)}><TelegramPreview text={pending?.text ?? draft} button={pending ? pending.button : buttonValidation.value && buttonDraft.enabled ? buttonValidation.value : undefined} compact />{(pending?.button || (buttonDraft.enabled && buttonValidation.value)) && <SavedButton button={pending ? pending.button : buttonValidation.value} />}{confirmError && <Alert>{confirmError}</Alert>}{pending && !sending && <Alert tone="info">Yuborish boshlangan bo‘lishi mumkin. Natijani aniqlash uchun ayni so‘rov bilan qayta tekshiring.</Alert>}<p className="confirm-note"><Icon name="info" size={16} /> Yuborilgan xabarni qaytarib olib bo‘lmaydi.</p><div className="modal-actions"><button className="button button-secondary" disabled={sending} onClick={() => setConfirm(false)}>{pending ? 'Keyinroq tekshirish' : 'Tahrirlash'}</button><button className="button button-primary" onClick={sendBroadcast} disabled={sending || !dashboard || Boolean(loadError) || (!pending && !canSend)}>{sending ? <><Spinner /> {pending ? 'Tekshirilmoqda...' : 'Boshlanmoqda...'}</> : pending ? <><Icon name="refresh" size={18} /> Natijani tekshirish</> : <><Icon name="send" size={18} /> Ha, yuborish</>}</button></div></Modal>}
    {cancelConfirm && <Modal title="Yuborishni to‘xtatish?" subtitle="Hali yuborilmagan xabarlar navbatdan chiqariladi. Oldin yuborilgan xabarlar o‘chirilmaydi." busy={jobAction} onClose={() => setCancelConfirm(false)}>{actionError && <Alert>{actionError}</Alert>}<div className="modal-actions"><button className="button button-secondary" disabled={jobAction} onClick={() => setCancelConfirm(false)}>Ortga qaytish</button><button className="button button-danger" disabled={jobAction} onClick={() => mutateJob('cancel')}>{jobAction ? <Spinner /> : <Icon name="pause" size={17} />} Yuborishni to‘xtatish</button></div></Modal>}
  </div>;
}

function App() {
  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, updatePending] = useState(readPending);
  const [draft, setDraft] = useState(() => readPending()?.text || '');
  const [buttonDraft, setButtonDraft] = useState(() => {
    const button = readPending()?.button;
    return button ? { enabled: true, ...button } : emptyButtonDraft();
  });
  const setPending = useCallback((value) => {
    updatePending(value);
    try { if (value) sessionStorage.setItem(PENDING_KEY, JSON.stringify(value)); else sessionStorage.removeItem(PENDING_KEY); } catch { /* Continue safely in memory. */ }
  }, []);
  const onUnauthorized = useCallback(() => { setNotice('Sessiya muddati tugadi. Davom etish uchun qayta kiring.'); setSession(null); }, []);
  const checkSession = useCallback(async () => {
    setBooting(true); setBootError('');
    try { setSession(await api('/session')); }
    catch (error) { if (error.status !== 401) setBootError(error.message); }
    finally { setBooting(false); }
  }, []);
  useEffect(() => { checkSession(); }, [checkSession]);
  if (booting || bootError) return <main className="boot-screen"><Brand compact /><div className="boot-content">{bootError ? <><Icon name="alert" size={32} /><h1>Panelga ulanib bo‘lmadi</h1><p>{bootError}</p><button className="button button-primary" onClick={checkSession}><Icon name="refresh" size={18} /> Qayta urinish</button></> : <><Spinner size={28} /><p>Panel yuklanmoqda...</p></>}</div></main>;
  if (!session) return <Login onLogin={(value) => { setSession(value); setNotice(''); }} notice={notice} />;
  return <Dashboard session={session} onUnauthorized={onUnauthorized} onLogout={() => { setSession(null); setNotice(''); if (!pending) { setDraft(''); setButtonDraft(emptyButtonDraft()); } }} draft={draft} setDraft={setDraft} buttonDraft={buttonDraft} setButtonDraft={setButtonDraft} pending={pending} setPending={setPending} />;
}

createRoot(document.getElementById('root')).render(<App />);
