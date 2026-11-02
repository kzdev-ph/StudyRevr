// Plain text only. Never includes a study ID.
export function verifyMessage(link) {
  return {
    subject: 'Verify your email for StudyRevr',
    text: [
      'Someone made a StudyRevr account with this email address.',
      '',
      'To confirm it was you, open this link and tap "Verify my email":',
      link,
      '',
      'The link works for 24 hours and only once.',
      'If this was not you, ignore this email and nothing will happen.',
    ].join('\n'),
  };
}

export function resetMessage(link) {
  return {
    subject: 'Reset your StudyRevr password',
    text: [
      'Open this link to choose a new StudyRevr password:',
      link,
      '',
      'The link works for 30 minutes and only once.',
      'If you did not ask for this, ignore this email. Your password stays the same.',
    ].join('\n'),
  };
}
