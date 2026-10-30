// Very common passwords of 8 or more characters (shorter ones already fail the length rule). Not a security list, just
// a stop for the passwords everyone tries first. Compared in lower case, so "Password1" is "password1".
const COMMON = [
  'password', 'password1', 'password12', 'password123', 'password1234', 'password!', 'password01', 'password2',
  'password3', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'pa$$word', 'passw0rd1', 'mypassword', 'newpassword', 'password0',
  '12345678', '123456789', '1234567890', '12345678910', '123123123', '1234512345', '0123456789', '987654321',
  '9876543210', '87654321', '11111111', '111111111', '1111111111', '00000000', '000000000', '0000000000', '22222222',
  '55555555', '66666666', '77777777', '88888888', '99999999', '12341234', '12121212', '123456789a', '1q2w3e4r',
  '1q2w3e4r5t', '1qaz2wsx', '1qazxsw2', 'qwertyui', 'qwertyuiop', 'qwerty12', 'qwerty123', 'qwerty1234', 'qwerty12345',
  'qwerty123456', 'qwertyuio', 'qazwsxedc', 'asdfghjk', 'asdfghjkl', 'asdf1234', 'zxcvbnm1', 'zxcvbnm123', 'zxcvbnm,',
  'abcd1234', 'abc12345', 'abc123456', 'abcdefgh', 'abcdefg1', 'abcdefghi', 'abcdefghij', 'iloveyou', 'iloveyou1',
  'iloveyou2', 'iloveyou!', 'letmein1', 'letmein123', 'letmein12', 'welcome1', 'welcome123', 'welcome12', 'welcome01',
  'admin123', 'admin1234', 'administrator', 'adminadmin', 'administrator1', 'changeme', 'changeme1', 'changeme123',
  'football', 'football1', 'baseball', 'basketball', 'superman', 'batman123', 'princess', 'princess1', 'sunshine',
  'sunshine1', 'whatever', 'trustno1', 'starwars', 'monkey123', 'dragon123', 'master123', 'shadow123', 'michael1',
  'jennifer', 'jordan23', 'charlie1', 'computer', 'internet', 'samsung1', 'pokemon1', 'minecraft', 'maganda1',
  'iloveyou1', 'studyrevr', 'studyreviewer', 'study123', 'student1', 'student123', 'studentpassword', 'reviewer',
  'reviewer1', 'reviewer123', 'research', 'research1', 'research123', 'teacher1', 'teacher123', 'school123',
  'philippines', 'philippines1', 'pilipinas', 'pilipinas1', 'mabuhay1', 'kapamilya', 'password.', 'qwer1234',
];

const BLOCKED = new Set(COMMON);

// What a person typed, as it is compared: composed (NFC), trimmed, lower case.
const folded = (pw) => String(pw ?? '').normalize('NFC').trim().toLowerCase();

// True when the password is on the list, or is just the part of the email before the "@".
export function isCommonPassword(password, email) {
  const typed = folded(password);
  if (BLOCKED.has(typed)) return true;
  const local = folded(String(email ?? '').split('@')[0]);
  return local !== '' && typed === local;
}
