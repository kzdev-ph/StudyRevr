import { useEffect, useState } from 'react';
import Notice from './Notice.jsx';
import { api } from '../lib/api.js';

// A student's AI for Explain simpler and Filipino/Taglish: the app's Default, or their own key (only while the
// researcher allows it). A key is saved only after "Test key" passes, and is never shown again (last 4 characters).
export default function MyAiSettings() {
  const [state, setState] = useState(null);
  const [mode, setMode] = useState('default');
  const [provider, setProvider] = useState('google');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState(null);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(null); // 'models' | 'test' | 'remove'
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .myAi(controller.signal)
      .then((data) => {
        setState(data);
        if (data.key) {
          setMode('own');
          setProvider(data.key.provider);
        }
      })
      .catch(() => {}); // Settings still works without this section
    return () => controller.abort();
  }, []);

  if (!state || (!state.allowed && !state.key)) return null;
  const label = (id) => state.providers.find((p) => p.id === id)?.label ?? id;

  const run = async (what, fn) => {
    setBusy(what);
    setProblem(null);
    setMessage('');
    try {
      await fn();
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(null);
    }
  };
  const loadModels = () =>
    run('models', async () => {
      setModels(null);
      const { models: list } = await api.myAiModels(provider, apiKey.trim());
      const suggested = state.providers.find((p) => p.id === provider)?.default_model;
      setModels(list);
      setModel(list.includes(suggested) ? suggested : (list[0] ?? ''));
      if (!list.length) setProblem(`${label(provider)} didn’t list any chat models for this key.`);
    });
  const test = () =>
    run('test', async () => {
      const saved = await api.saveMyKey({ provider, model, apiKey: apiKey.trim() });
      setState(saved);
      setApiKey('');
      setModels(null);
      setMessage(saved.message);
    });
  const remove = () =>
    run('remove', async () => {
      setState(await api.removeMyKey());
      setMode('default');
      setMessage('Your key was removed. Explain simpler and Filipino/Taglish use the default AI.');
    });

  const chooseProvider = (id) => {
    setProvider(id);
    setModels(null);
    setModel('');
    setProblem(null);
  };

  // own keys turned off by the researcher, but one is still saved: it isn't used; offer to remove it
  if (!state.allowed) {
    return (
      <section className="stack stack--tight" aria-labelledby="my-ai">
        <h2 id="my-ai" className="setting-heading">
          AI for Explain simpler and Filipino/Taglish
        </h2>
        <p className="muted">
          Your saved key ({state.key.provider_label} …{state.key.last4}) isn’t used right now: your teacher turned own keys off. The default AI answers.
        </p>
        <div>
          <button type="button" className="btn btn--quiet" onClick={remove} disabled={busy !== null}>
            {busy === 'remove' ? 'Removing…' : 'Remove my key'}
          </button>
        </div>
        <p role="status" className="status-ok">
          {message}
        </p>
        {problem && <Notice onDismiss={() => setProblem(null)}>{problem}</Notice>}
      </section>
    );
  }

  return (
    <section className="stack stack--tight" aria-labelledby="my-ai">
      <h2 id="my-ai" className="setting-heading">
        AI for Explain simpler and Filipino/Taglish
      </h2>
      <fieldset className="choice">
        <legend className="visually-hidden">Which AI answers</legend>
        <div className="segmented">
          {[
            ['default', 'Default'],
            ['own', 'Use your own key'],
          ].map(([id, text]) => (
            <label key={id} className="segmented__item">
              <input type="radio" name="my-ai" value={id} checked={mode === id} onChange={() => setMode(id)} />
              <span>{text}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {mode === 'default' && !state.key && <p className="muted">The app’s AI answers ({state.default.model}), set by your teacher.</p>}
      {mode === 'default' && state.key && (
        <p className="muted">Going back to Default removes your saved key. Use Remove my key below.</p>
      )}

      {state.key && (
        <div className="setting-row">
          <p className="setting-row__text">
            <span className="setting-row__title">
              Your key: {state.key.provider_label} …{state.key.last4}
            </span>
            <span className="muted">Model {state.key.model}. Answers from your key are shown to you only.</span>
          </p>
          <button type="button" className="btn btn--quiet" onClick={remove} disabled={busy !== null}>
            {busy === 'remove' ? 'Removing…' : 'Remove my key'}
          </button>
        </div>
      )}

      {mode === 'own' && (
        <form
          className="stack stack--tight"
          onSubmit={(e) => {
            e.preventDefault();
            if (model) test();
          }}
        >
          {state.key && <p className="muted">To use a different key, fill this in and test it. It replaces the saved one.</p>}
          <label className="field">
            <span className="field__label">Provider</span>
            <select className="field__input" value={provider} onChange={(e) => chooseProvider(e.target.value)}>
              {state.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Your API key</span>
            <input
              className="field__input"
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setModels(null);
              }}
              placeholder="Paste your key"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="my-key-warning"
            />
          </label>
          <div id="my-key-warning">
            <Notice tone="warn">Your key is stored on the study laptop. Only use a key you can delete later.</Notice>
          </div>
          {models ? (
            <label className="field">
              <span className="field__label">Model</span>
              <select className="field__input" value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div>
              <button type="button" className="btn btn--quiet" onClick={loadModels} disabled={busy !== null || apiKey.trim().length < 8}>
                {busy === 'models' ? 'Checking the key…' : 'Show models'}
              </button>
            </div>
          )}
          {models && (
            <div>
              <button type="submit" className="btn btn--primary" disabled={busy !== null || !model || apiKey.trim().length < 8}>
                {busy === 'test' ? 'Testing…' : 'Test key'}
              </button>
            </div>
          )}
          <p className="muted">Test key sends one tiny request. The key is saved only if it works.</p>
        </form>
      )}

      <p role="status" className="status-ok">
        {message}
      </p>
      {problem && <Notice onDismiss={() => setProblem(null)}>{problem}</Notice>}
    </section>
  );
}
