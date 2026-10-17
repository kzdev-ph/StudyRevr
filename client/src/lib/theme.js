// Five choices: Match my device (light or dark by the system), Light, Dark, AMA (a light theme in the AMA Computer College
// colours) and AMA Dark. A device with no saved choice gets AMA. A choice (Settings) is kept in localStorage and sets
// data-theme on <html>; "Match my device" is stored as `system` so it can be told apart from "never chose".
const KEY = 'studyrevr-theme';
export const THEME_CHOICES = ['system', 'light', 'dark', 'ama', 'ama-dark'];
const DEFAULT_CHOICE = 'ama';

// the status-bar colour of the two AMA themes (their paper); Light, Dark and Match my device keep the media-based tags in index.html
const BAR = { ama: '#f7f3e8', 'ama-dark': '#1b1a18' };

const read = () => {
  try {
    const v = window.localStorage.getItem(KEY);
    return THEME_CHOICES.includes(v) ? v : DEFAULT_CHOICE;
  } catch {
    return DEFAULT_CHOICE;
  }
};

function setBar(choice) {
  const head = document.head;
  let tag = head.querySelector('meta[name="theme-color"][data-theme-override]');
  if (!BAR[choice]) {
    tag?.remove();
    return;
  }
  if (!tag) {
    tag = document.createElement('meta');
    tag.name = 'theme-color';
    tag.dataset.themeOverride = '';
    head.prepend(tag); // before the media-based tags, so it wins on a device of either scheme
  }
  tag.content = BAR[choice];
}

export function applyTheme(choice = read()) {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  setBar(choice);
}

export const getThemeChoice = read;

export function setThemeChoice(choice) {
  try {
    window.localStorage.setItem(KEY, choice);
  } catch {
    // storage blocked: the choice still applies for this visit
  }
  applyTheme(choice);
}
