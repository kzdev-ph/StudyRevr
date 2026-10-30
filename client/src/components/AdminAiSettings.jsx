import { useCallback, useEffect, useState } from 'react';
import Notice from './Notice.jsx';
import { api } from '../lib/api.js';

// Admin: the app's Default AI (provider, key, model) and the study settings: new flashcards per day and whether
// students may use their own API key. Lesson processing always uses this Default; only the live rewrites fall back.
function DefaultAi() {
  const [settings, setSettings] = useState(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState(null); // null while loading; [] when the provider lists none
  const [busy, setBusy] = useState(null); // 'test' | 'save'
  const [result, setResult] = useState(null); // { ok, text }
  const [problems, setProblems] = useState([]); // the Default's recent failures that settings can fix (students only see "try again")

  const load = useCallback(async (signal) => {
    try {
      const data = await api.aiSettings(signal);
      setSettings(data);
      setProvider(data.provider);
      setModel(data.providers.find((p) => p.id === data.provider)?.model ?? '');
    } catch (err) {
      if (err.name !== 'AbortError') setResult({ ok: false, text: err.message });
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // the chosen provider's chat models (the server filters out image, audio, agent and other non-chat models)
  useEffect(() => {
    if (!provider) return undefined;
    const controller = new AbortController();
    setModels(null);
    api
      .aiModels(provider, controller.signal)
      .then((data) => setModels(data.models))
      .catch((err) => err.name !== 'AbortError' && setModels([]));
    return () => controller.abort();
  }, [provider, settings]);

  // re-read after every save: a fixed Default stops adding to the 24-hour count, but the list says what happened
  useEffect(() => {
    const controller = new AbortController();
    api
      .aiProblems(controller.signal)
      .then((data) => setProblems(data.problems))
      .catch(() => {});
    return () => controller.abort();
  }, [settings]);

  if (!settings) return result ? <Notice>{result.text}</Notice> : <p className="muted">Loading the AI settings…</p>;
  const current = settings.providers.find((p) => p.id === provider);

  const choose = (id) => {
    setProvider(id);
    setModel(settings.providers.find((p) => p.id === id)?.model ?? '');
    setApiKey('');
    setResult(null);
  };
  const body = () => ({ provider, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });

  const test = async () => {
    setBusy('test');
    setResult(null);
    try {
      const r = await api.testAi(body());
      setResult({ ok: true, text: `Connected. ${r.model} answered in ${(r.latencyMs / 1000).toFixed(1)} s.` });
    } catch (err) {
      setResult({ ok: false, text: err.message });
    } finally {
      setBusy(null);
    }
  };
  const save = async (event) => {
    event.preventDefault();
    setBusy('save');
    setResult(null);
    try {
      setSettings(await api.saveAiSettings(body()));
      setApiKey('');
      setResult({ ok: true, text: `Saved. The app now uses ${current.label}, ${model}.` });
    } catch (err) {
      setResult({ ok: false, text: err.message });
    } finally {
      setBusy(null);
    }
  };

  const listed = models?.length ? (models.includes(model) || !model ? models : [model, ...models]) : null;
  return (
    <form className="stack stack--tight" onSubmit={save}>
      <h3 className="admin-sub">Default AI</h3>
      <p className="muted">Used to prepare every lesson and for Explain simpler and Filipino/Taglish. Lesson processing never falls back to another model.</p>
      {problems.length > 0 && (
        <div className="stack stack--tight" role="group" aria-label="Recent problems with the Default AI">
          {problems.map((p) => (
            <Notice key={p.code} tone="warn">
              {p.message} In the last 24 hours this happened {p.count} time{p.count === 1 ? '' : 's'}
              {p.answered_by_backup ? `; the backup AI answered ${p.answered_by_backup}` : ''}
              {p.failed ? `; ${p.failed} request${p.failed === 1 ? '' : 's'} got “try again”` : ''}.
            </Notice>
          ))}
        </div>
      )}
      <label className="field">
        <span className="field__label">Provider</span>
        <select className="field__input" value={provider} onChange={(e) => choose(e.target.value)}>
          {settings.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {current.needsKey && (
        <div className="field-group">
          <label className="field">
          <span className="field__label">API key</span>
          <input
            className="field__input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={current.keySet ? 'A key is saved. Paste a new one to replace it.' : 'Paste the key'}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="admin-key-note"
          />
          </label>
          <p id="admin-key-note" className="muted">
            {current.keySet ? 'Key set.' : 'No key set.'} The key is never shown again or included in exports and backups.
          </p>
        </div>
      )}
      <div className="field-group">
      <label className="field">
        <span className="field__label">Model</span>
        {listed ? (
          <select className="field__input" value={model} onChange={(e) => setModel(e.target.value)} aria-describedby="admin-model-note">
            {listed.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="field__input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={current.defaultModel || 'model id'}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="admin-model-note"
          />
        )}
      </label>
      <p id="admin-model-note" className="muted">
        {models === null ? 'Loading the model list…' : listed ? `Chat models only. Recommended: ${current.defaultModel}.` : 'The model list isn’t available; type a model id.'}
      </p>
      </div>
      <p role="status" className="status-ok">
        {result?.ok ? result.text : ''}
      </p>
      {result && !result.ok && <Notice onDismiss={() => setResult(null)}>{result.text}</Notice>}
      <div className="admin-actions">
        <button type="button" className="btn btn--quiet" onClick={test} disabled={busy !== null || !model}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy !== null || !model}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

const THINKING = [
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

function StudySettings() {
  const [settings, setSettings] = useState(null);
  const [perDay, setPerDay] = useState('');
  const [uploadsPerDay, setUploadsPerDay] = useState('');
  const [timeoutS, setTimeoutS] = useState('');
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .appSettings(controller.signal)
      .then((data) => {
        setSettings(data);
        setPerDay(String(data.flashcard_new_per_day));
        setUploadsPerDay(String(data.student_uploads_per_day));
        setTimeoutS(String(data.session_timeout_seconds));
      })
      .catch((err) => err.name !== 'AbortError' && setProblem(err.message));
    return () => controller.abort();
  }, []);

  const save = async (change, done) => {
    setBusy(true);
    setProblem(null);
    setMessage('');
    try {
      setSettings(await api.saveAppSettings(change));
      setMessage(done);
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };
  const [confirmingKeys, setConfirmingKeys] = useState(false);
  const deleteKeys = async () => {
    setBusy(true);
    setProblem(null);
    setMessage('');
    try {
      const { deleted } = await api.deleteStudentKeys();
      setSettings(await api.appSettings());
      setConfirmingKeys(false);
      setMessage(deleted ? `Deleted ${deleted} saved student key${deleted === 1 ? '' : 's'}.` : 'No student keys were saved.');
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };
  const n = Number(perDay);
  const valid = perDay.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 9999;

  const u = Number(uploadsPerDay);
  const uploadsValid = uploadsPerDay.trim() !== '' && Number.isInteger(u) && u >= 0 && u <= 20;

  const ts = Number(timeoutS);
  const timeoutValid = timeoutS.trim() !== '' && Number.isInteger(ts) && ts >= 30 && ts <= 1800;

  if (!settings) return problem ? <Notice>{problem}</Notice> : null;
  return (
    <div className="stack stack--tight">
      <h3 className="admin-sub">Study settings</h3>
      <form
        className="admin-add"
        onSubmit={(e) => {
          e.preventDefault();
          save({ flashcard_new_per_day: n }, `Saved. Students get up to ${n} new flashcards a day.`);
        }}
      >
        <label className="field">
          <span className="field__label">New flashcards per day</span>
          <input
            className="field__input"
            type="number"
            inputMode="numeric"
            min={0}
            max={9999}
            value={perDay}
            onChange={(e) => setPerDay(e.target.value)}
            aria-invalid={!valid}
            aria-describedby="admin-perday-note"
          />
        </label>
        <button type="submit" className="btn btn--primary" disabled={busy || !valid || n === settings.flashcard_new_per_day}>
          Save
        </button>
      </form>
      <p id="admin-perday-note" className="muted">
        One budget per student per study day (from 04:00), across all lessons. Default 20.
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          role="switch"
          checked={settings.allow_student_keys}
          disabled={busy}
          onChange={(e) =>
            save(
              { allow_student_keys: e.target.checked },
              e.target.checked ? 'Students can now add their own key in Settings.' : 'Students’ own keys are off; everyone uses the Default.',
            )
          }
          aria-describedby="admin-keys-note"
        />
        Allow students to use their own API key
      </label>
      <p id="admin-keys-note" className="muted">
        Only for Explain simpler and Filipino/Taglish. Answers from a student’s key are shown to that student only. Lessons are always prepared with the Default.
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          role="switch"
          checked={settings.show_taglish}
          disabled={busy}
          onChange={(e) =>
            save(
              { show_taglish: e.target.checked },
              e.target.checked ? 'Students now see Filipino/Taglish under each section.' : 'Filipino/Taglish is hidden from students.',
            )
          }
          aria-describedby="admin-taglish-note"
        />
        Show Filipino/Taglish to students
      </label>
      <p id="admin-taglish-note" className="muted">
        Off by default. While it is off students see only English, and Prepare still makes the Taglish versions for later.
      </p>
      <div className="field-group" role="group" aria-labelledby="admin-signups-title">
        <h4 id="admin-signups-title" className="admin-sub">
          Sign-ups
        </h4>
        <label className="check-row">
          <input
            type="checkbox"
            role="switch"
            checked={settings.allow_signups}
            disabled={busy}
            onChange={(e) =>
              save(
                { allow_signups: e.target.checked },
                e.target.checked ? 'New sign-ups are open.' : 'New sign-ups are closed. Students with an account can still sign in.',
              )
            }
            aria-describedby="admin-signups-note admin-signups-detail"
          />
          Allow new sign-ups
        </label>
        <p id="admin-signups-note" className="muted">
          Turn this off after enrolment so nobody else can create an account.
        </p>
        <p id="admin-signups-detail" className="muted">
          Every sign-up uses up a study number (P01 to P999) that is never reused. Behind a proxy, all students share one address for the sign-up limit. Someone who
          knows an email can keep that account locked for a while; Reset password in Accounts lifts it.
        </p>
      </div>
      <div className="field-group" role="group" aria-labelledby="admin-timeout-title">
        <h4 id="admin-timeout-title" className="admin-sub">
          New-device prompt
        </h4>
        <form
          className="admin-add"
          onSubmit={(e) => {
            e.preventDefault();
            save({ session_timeout_seconds: ts }, `Saved. A device counts as active for ${ts} seconds.`);
          }}
        >
          <label className="field">
            <span className="field__label">Seconds before a signed-in device counts as gone</span>
            <input
              className="field__input"
              type="number"
              inputMode="numeric"
              min={30}
              max={1800}
              value={timeoutS}
              onChange={(e) => setTimeoutS(e.target.value)}
              aria-invalid={!timeoutValid}
              aria-describedby="admin-timeout-note"
            />
          </label>
          <button type="submit" className="btn btn--primary" disabled={busy || !timeoutValid || ts === settings.session_timeout_seconds}>
            Save
          </button>
        </form>
        <p id="admin-timeout-note" className="muted">
          If the account was active on another device within this time, a new sign-in asks first. 30 to 1800 seconds. Default 60.
        </p>
      </div>
      <p className="muted">
        {settings.student_keys_saved
          ? `${settings.student_keys_saved} student key${settings.student_keys_saved === 1 ? ' is' : 's are'} saved on this computer.`
          : 'No student keys are saved.'}{' '}
        Delete them all when the study is over.
      </p>
      {confirmingKeys ? (
        <div className="stack stack--tight" role="group" aria-label="Delete all student keys">
          <p>Delete every saved student key? Students would have to paste theirs again. This can’t be undone.</p>
          <div className="admin-actions">
            <button type="button" className="btn btn--primary btn--destroy" onClick={deleteKeys} disabled={busy}>
              Yes, delete all
            </button>
            <button type="button" className="btn btn--quiet" onClick={() => setConfirmingKeys(false)} disabled={busy}>
              Keep them
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button type="button" className="btn btn--quiet" onClick={() => setConfirmingKeys(true)} disabled={busy || !settings.student_keys_saved}>
            Delete all student keys
          </button>
        </div>
      )}
      <label className="check-row">
        <input
          type="checkbox"
          role="switch"
          checked={settings.allow_student_uploads}
          disabled={busy}
          onChange={(e) =>
            save(
              { allow_student_uploads: e.target.checked },
              e.target.checked ? 'Students can now upload their own lessons.' : 'Student uploads are off. Lessons already uploaded stay.',
            )
          }
          aria-describedby="admin-uploads-note"
        />
        Allow students to upload lessons
      </label>
      <p id="admin-uploads-note" className="muted">
        Off by default, so the study runs on your lesson. An upload is private to the student until you share it from the lesson list. Turning this off only
        hides the Upload button; lessons already uploaded and their records stay. Uploads are prepared with the Default AI, one lesson at a time, never with a
        student’s own key.
      </p>
      <form
        className="admin-add"
        onSubmit={(e) => {
          e.preventDefault();
          save({ student_uploads_per_day: u }, `Saved. Each student can upload ${u} ${u === 1 ? 'lesson' : 'lessons'} a study day.`);
        }}
      >
        <label className="field">
          <span className="field__label">Uploads per student per study day</span>
          <input
            className="field__input"
            type="number"
            inputMode="numeric"
            min={0}
            max={20}
            value={uploadsPerDay}
            onChange={(e) => setUploadsPerDay(e.target.value)}
            aria-invalid={!uploadsValid}
            aria-describedby="admin-uploadsperday-note"
          />
        </label>
        <button type="submit" className="btn btn--primary" disabled={busy || !uploadsValid || u === settings.student_uploads_per_day}>
          Save
        </button>
      </form>
      <p id="admin-uploadsperday-note" className="muted">
        The study day starts at 04:00. Deleting an upload doesn’t give it back. Default 2.
      </p>
      <fieldset className="choice" aria-describedby="admin-thinking-note">
        <legend>Think harder when preparing lessons</legend>
        <div className="segmented">
          {THINKING.map(({ id, label }) => (
            <label key={id} className="segmented__item">
              <input
                type="radio"
                name="lesson-thinking"
                value={id}
                checked={settings.lesson_thinking === id}
                disabled={busy}
                onChange={() =>
                  save(
                    { lesson_thinking: id },
                    id === 'minimal' ? 'Saved. The next lesson is prepared without thinking.' : `Saved. The next lesson is prepared with ${id} thinking.`,
                  )
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <p id="admin-thinking-note" className="muted">
        Low, Medium and High ask the AI to think before it writes the review, cards, quiz answers and checks, and to restate only what the lesson says. Higher levels are
        slower and use more of the daily AI quota; a change only applies to lessons prepared from now on. Low is the default: in a test on three lessons it made the fewest
        mistakes. Minimal asks for no thinking. Explain simpler and Filipino/Taglish never think.
      </p>
      <p role="status" className="status-ok">
        {message}
      </p>
      {problem && <Notice onDismiss={() => setProblem(null)}>{problem}</Notice>}
    </div>
  );
}

export default function AdminAiSettings() {
  return (
    <section className="admin-section" aria-labelledby="admin-ai">
      <h2 id="admin-ai" className="admin-section__title">
        AI and study settings
      </h2>
      <DefaultAi />
      <StudySettings />
    </section>
  );
}
