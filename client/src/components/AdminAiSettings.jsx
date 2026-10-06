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
          <span id="admin-key-note" className="muted">
            {current.keySet ? 'Key set.' : 'No key set.'} The key is never shown again or included in exports and backups.
          </span>
        </label>
      )}
      <label className="field">
        <span className="field__label">Model</span>
        {listed ? (
          <select className="field__input" value={model} onChange={(e) => setModel(e.target.value)}>
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
        <span id="admin-model-note" className="muted">
          {models === null ? 'Loading the model list…' : listed ? `Chat models only. Recommended: ${current.defaultModel}.` : 'The model list isn’t available; type a model id.'}
        </span>
      </label>
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

function StudySettings() {
  const [settings, setSettings] = useState(null);
  const [perDay, setPerDay] = useState('');
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
  const n = Number(perDay);
  const valid = perDay.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 9999;

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
