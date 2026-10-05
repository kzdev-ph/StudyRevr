// Light / dark follows the system. A manual choice (Settings) is kept in localStorage and sets data-theme on <html>.
const KEY = 'studyrevr-theme';

const read = () => {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
};

export function applyTheme(choice = read()) {
  const root = document.documentElement;
  if (choice === 'light' || choice === 'dark') root.dataset.theme = choice;
  else delete root.dataset.theme;
}

export const getThemeChoice = read;

export function setThemeChoice(choice) {
  try {
    if (choice === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    // storage blocked: the choice still applies for this visit
  }
  applyTheme(choice);
}
