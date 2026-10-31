// Reads files the way an upload would and says whether letters look to be missing from the text (src/services/text-damage.js).
// No database, no AI call, no key; nothing is written.
//   npm run text:check -- <file or folder>...     a folder means every .docx, .pptx and .pdf directly inside it
// A relative path is from where you typed the command.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSignature, fileExtension } from '../src/middleware/upload.js';
import { extractText } from '../src/services/extract.js';
import { describeDamage } from '../src/services/text-damage.js';

const USAGE = 'Usage: npm run text:check -- <file or folder>...';
const SUPPORTED = new Set(['.docx', '.pptx', '.pdf']);

// -> the files to read, in order; a folder gives the supported files directly inside it
export function listFiles(args, cwd) {
  const files = [];
  for (const arg of args) {
    const p = path.resolve(cwd, arg);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) {
        if (SUPPORTED.has(path.extname(name).toLowerCase()) && fs.statSync(path.join(p, name)).isFile()) files.push(path.join(p, name));
      }
    } else files.push(p);
  }
  return files;
}

// -> one line: "name  <wordCount> words  <describeDamage>", or the message of what went wrong
export async function checkFile(file) {
  const name = path.basename(file);
  try {
    const ext = fileExtension(file);
    if (!SUPPORTED.has(ext)) return `${name}  not read: unsupported file type "${ext}"`;
    const buffer = fs.readFileSync(file);
    assertSignature(buffer, ext);
    const { wordCount, damage } = await extractText(buffer, ext);
    return `${name}  ${wordCount} words  ${describeDamage(damage)}`;
  } catch (e) {
    return `${name}  not read: ${e.message}`;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    // npm runs this inside server/; a relative path means where you typed the command
    const files = listFiles(args, process.env.INIT_CWD ?? process.cwd());
    if (!files.length) console.log('No .docx, .pptx or .pdf files found.');
    for (const file of files) console.log(await checkFile(file));
  }
}
