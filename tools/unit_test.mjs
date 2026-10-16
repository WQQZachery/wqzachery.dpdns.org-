// Unit tests for pure helpers in worker/worker.js (filename sanitizing, blocked types, magic-byte sniff, constant-time compare).
// Usage: node tools/unit_test.mjs
import fs from 'fs'; import vm from 'vm'; import path from 'path'; import { fileURLToPath } from 'url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let src = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8')
  .replace(/^import (\w+) from .*$/gm, (_, n) => `const ${n} = '';`)
  .replace(/^import \{ DurableObject \} from .*$/m, 'class DurableObject { constructor(){} }')
  .replace('export default {', 'const __default = {').replace('export class Store', 'class Store');
src += '\n;globalThis.T = { cleanName, blockedName, sniff, safeEq, okPath, extOf };';
const ctx = vm.createContext({ TextEncoder, TextDecoder, crypto: globalThis.crypto, URL, Response: class {}, Headers: class {}, atob, btoa, console });
vm.runInContext(src, ctx);
const { cleanName, blockedName, sniff, safeEq, okPath } = ctx.T;
let ok = 0, bad = 0; const t = (n, c, i = '') => { if (c) { ok++; console.log('PASS', n) } else { bad++; console.log('FAIL', n, i) } };
const u8 = s => Uint8Array.from(typeof s === 'string' ? [...s].map(c => c.charCodeAt(0)) : s);
// filenames
const odd = cleanName('  ..\\..//evil\u202egnp<script>:*?.txt.  ' + 'a'.repeat(300));
t('sanitize: no slashes / bidi / <> / leading dots, ≤150', !/[\/\\<>\u202e]/.test(odd) && odd.length <= 150 && !odd.startsWith('.'), JSON.stringify(odd));
t('sanitize: trailing dots/spaces stripped', cleanName('a.exe. . ') === 'a.exe', cleanName('a.exe. . '));
t('sanitize: empty → file', cleanName('...') === 'file' && cleanName('') === 'file');
t('sanitize keeps normal Chinese names', cleanName('测试 文件(1).pdf') === '测试 文件(1).pdf', cleanName('测试 文件(1).pdf'));
t('RLO trick name blocked', blockedName(cleanName('photo\u202egpj.exe')));
for (const n of ['a.exe', 'B.MSI', 'c.apk', 'd.bat', 'e.cmd', 'f.ps1', 'g.scr', 'h.com', 'i.vbs', 'j.jar', 'k.dll', 'l.sh', 'm.app', 'n.dmg', 'o.deb', 'p.rpm', 'q.ipa', 'r.msix']) t('blocked ' + n, blockedName(n));
for (const n of ['a.jpg', 'b.pdf', 'c.zip', 'd.txt', 'e.py', 'f.docx', 'g.mp4', 'noext']) t('allowed ' + n, !blockedName(n));
// sniff
t('sniff MZ', !!sniff(u8('MZ\x90\x00')));
t('sniff ELF', !!sniff(u8('\x7fELF\x02')));
t('sniff Mach-O 64', !!sniff(u8([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1])));
t('sniff fat Mach-O', !!sniff(u8([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2])));
t('sniff shebang', !!sniff(u8('#!/bin/bash\n')));
t('sniff deb', !!sniff(u8('!<arch>\ndebian-binary')));
t('sniff rpm', !!sniff(u8([0xed, 0xab, 0xee, 0xdb, 3, 0])));
t('sniff APK zip', !!sniff(u8('PK\x03\x04' + '\0'.repeat(26) + 'AndroidManifest.xml')));
t('sniff JAR zip', !!sniff(u8('PK\x03\x04' + '\0'.repeat(26) + 'META-INF/MANIFEST.MF')));
t('sniff IPA zip', !!sniff(u8('PK\x03\x04' + '\0'.repeat(26) + 'Payload/Foo.app/Info.plist')));
t('docx zip allowed', !sniff(u8('PK\x03\x04' + '\0'.repeat(26) + '[Content_Types].xml word/document.xml')));
t('png allowed', !sniff(u8([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])));
t('jpeg allowed', !sniff(u8([0xff, 0xd8, 0xff, 0xe0])));
t('pdf allowed', !sniff(u8('%PDF-1.7')));
t('text allowed', !sniff(u8('hello world')));
// compare + paths
t('safeEq equal', safeEq('abc', 'abc')); t('safeEq differ', !safeEq('abd', 'abc')); t('safeEq prefix', !safeEq('ab', 'abc')); t('safeEq longer', !safeEq('abcd', 'abc')); t('safeEq empty', !safeEq('', 'abc'));
t('okPath rejects ..', !okPath('files/../x')); t('okPath ok', okPath('files/a/b.txt'));
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
