import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// Loads one lesson with its sections, key points, key terms and saved review progress.
// `setVersion` stores an on-demand rewrite (simpler / Filipino) on its section so it shows without a reload.
export function useLesson(id) {
  const [state, setState] = useState({ data: null, error: null, loading: true });

  const load = useCallback(
    async (signal) => {
      try {
        const data = await api.getLesson(id, signal);
        setState({ data, error: null, loading: false });
      } catch (err) {
        if (err.name !== 'AbortError') setState((s) => ({ ...s, error: err, loading: false }));
      }
    },
    [id],
  );

  useEffect(() => {
    const controller = new AbortController();
    setState({ data: null, error: null, loading: true });
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const setVersion = useCallback((sectionId, kind, version) => {
    const field = kind === 'simple' ? 'simple_version' : 'filipino_version';
    setState((s) =>
      s.data ? { ...s, data: { ...s.data, sections: s.data.sections.map((sec) => (sec.id === sectionId ? { ...sec, [field]: version } : sec)) } } : s,
    );
  }, []);

  const reload = useCallback(() => load(), [load]);
  return { ...state, reload, setVersion };
}
