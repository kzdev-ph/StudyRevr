// `node --import ./test/helpers/register.mjs file.mjs`: lets node load the app's .jsx files (the screens under test).
import { register } from 'node:module';

register('./jsx-hooks.mjs', import.meta.url);
