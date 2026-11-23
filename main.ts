// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order: [old path, new path]. Used for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** Section 3: a file's lines, its line break and whether it ends with one. */
interface FileParts {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileParts {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, finalBreak: false };
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** Section 5: one new line, with the index of the old line it mirrors (context) or null. */
interface NewLine {
  text: string;
  oIndex: number | null;
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function tierEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  const trimEnd = (s: string): string => s.replace(/[ \t]+$/, '');
  if (tier === 1) return trimEnd(a) === trimEnd(b);
  const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return trimBoth(a) === trimBoth(b);
}

/** All 0-based positions where O occurs in the file lines at one tier. */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!tierEqual(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs at least once, with its positions. */
function firstTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Re-indent one new line at tier 2: replace O's first line leading whitespace by the file's. */
function reindent(line: string, f: string, p: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

/** Replace the k lines at `at` by N: context lines are the file's own lines, others re-indented at tier 2. */
function spliceMatch(lines: string[], at: number, o: string[], n: NewLine[], tier: number): string[] {
  const f = lines[at] !== undefined ? leadingWs(lines[at]!) : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const made: string[] = [];
  for (const item of n) {
    if (item.oIndex !== null) made.push(lines[at + item.oIndex]!);
    else if (tier === 2) made.push(reindent(item.text, f, p));
    else made.push(item.text);
  }
  return [...lines.slice(0, at), ...made, ...lines.slice(at + o.length)];
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 6: one hunk body item. `bs` is a `\` line (it annotates the line before it).
 * `rawEmpty` marks a context item whose patch line was literally empty (a ` ` line is not). */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  rawEmpty?: boolean;
}

interface Hunk {
  a: number;
  body: BodyItem[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const diffGitHead = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

/** The path after `--- ` or `+++ ` (text after the four characters, to the first tab, trimmed). */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** Split a hunk body into its old lines O and its new lines N (context lines mirror O). */
function hunkLines(h: Hunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const item of h.body) {
    if (item.kind === 'ctx') {
      const oi = o.length;
      o.push(item.text);
      n.push({ text: item.text, oIndex: oi });
    } else if (item.kind === 'old') o.push(item.text);
    else if (item.kind === 'new') n.push({ text: item.text, oIndex: null });
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line (final-break rule). */
function backslashAfterLast(h: Hunk): boolean {
  for (let i = h.body.length - 1; i >= 0; i -= 1) {
    const item = h.body[i]!;
    if (item.kind === 'ctx' || item.kind === 'new') {
      return i + 1 < h.body.length && h.body[i + 1]!.kind === 'bs';
    }
  }
  return false;
}

/** Read every unified section of the patch; parse faults throw Exit2 with the patch line. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let i = 0;
  const n = lines.length;
  // State machine: out | header | between (after the header, between hunks) | body.
  let state: 'out' | 'header' | 'between' | 'body' = 'out';
  let cur: UniSection | null = null;
  let curHunk: Hunk | null = null;
  let pairOld: string | null | undefined;
  let pairNew: string | null | undefined;
  let renOld: string | undefined;
  let renNew: string | undefined;
  let gitOld = '';
  let gitNew = '';

  const finishSection = (): void => {
    if (cur === null) return;
    if (curHunk !== null) {
      trimHunk(curHunk);
      cur.hunks.push(curHunk);
      curHunk = null;
    }
    cur.oldPath = pairOld !== undefined ? pairOld : renOld !== undefined ? renOld : gitOld;
    cur.newPath = pairNew !== undefined ? pairNew : renNew !== undefined ? renNew : gitNew;
    sections.push(cur);
    cur = null;
  };
  const trimHunk = (h: Hunk): void => {
    // Trailing literally-empty lines are not part of a body; a ` ` line or a bare `+` line is.
    while (h.body.length > 0) {
      const last = h.body[h.body.length - 1]!;
      if (last.kind === 'ctx' && last.rawEmpty === true) h.body.pop();
      else break;
    }
  };
  const startSection = (oldP: string, newP: string): void => {
    finishSection();
    gitOld = oldP;
    gitNew = newP;
    pairOld = undefined;
    pairNew = undefined;
    renOld = undefined;
    renNew = undefined;
    cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
    state = 'header';
  };
  const startHunk = (lineNo: number, line: string): void => {
    const m = hunkHead.exec(line);
    if (m === null) throw new Exit2(`error: parse ${lineNo}`);
    if (curHunk !== null) {
      trimHunk(curHunk);
      cur!.hunks.push(curHunk);
    }
    curHunk = { a: Number(m[1]), body: [] };
    state = 'body';
  };

  while (i < n) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        const m = diffGitHead.exec(line);
        if (m === null) throw new Exit2(`error: parse ${lineNo}`);
        finishSection();
        startSection(m[1]!, m[2]!);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finishSection();
        startSection('', '');
        continue;
      }
      if (line.startsWith('@@')) {
        startHunk(lineNo, line);
        i += 1;
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        const kind: BodyItem['kind'] = line === '' ? 'ctx' : line.startsWith(' ') ? 'ctx' : line.startsWith('-') ? 'old' : line.startsWith('+') ? 'new' : 'bs';
        curHunk!.body.push({ kind, text: line === '' ? '' : line.slice(1), rawEmpty: line === '' ? true : undefined });
        i += 1;
        continue;
      }
      // The body ends here; the line is handled outside the body.
      trimHunk(curHunk!);
      cur!.hunks.push(curHunk!);
      curHunk = null;
      state = 'between';
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('@@')) {
        startHunk(lineNo, line);
        i += 1;
        continue;
      }
      if (line.startsWith('diff --git ')) {
        const m = diffGitHead.exec(line);
        if (m === null) throw new Exit2(`error: parse ${lineNo}`);
        finishSection();
        startSection(m[1]!, m[2]!);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${lineNo + 1}`);
        if (pairOld === undefined) {
          pairOld = headerPath(line);
          pairNew = headerPath(lines[i + 1]!);
        }
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (renOld === undefined) renOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (renNew === undefined) renNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (/^new file mode(\s|$)/.test(line)) {
        cur!.isCreate = true;
        i += 1;
        continue;
      }
      if (/^deleted file mode(\s|$)/.test(line)) {
        cur!.isDelete = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'between') {
      if (line.startsWith('@@')) {
        startHunk(lineNo, line);
        i += 1;
        continue;
      }
      if (line.startsWith('diff --git ')) {
        const m = diffGitHead.exec(line);
        if (m === null) throw new Exit2(`error: parse ${lineNo}`);
        finishSection();
        startSection(m[1]!, m[2]!);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finishSection();
        startSection('', '');
        continue;
      }
      i += 1;
      continue;
    }
    // state === 'out'
    if (line.startsWith('diff --git ')) {
      const m = diffGitHead.exec(line);
      if (m === null) throw new Exit2(`error: parse ${lineNo}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection('', '');
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${lineNo}`);
    i += 1;
  }
  finishSection();
  return sections.map((sec) => makeUnifiedEdit(sec, strict));
}

/** One unified section as an edit. */
function makeUnifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.isCreate || oldP === null) {
      // Creation: the old path is /dev/null, or a `new file mode` line is present.
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const item of h.body) if (item.kind === 'new') plus.push(item.text);
      let fb = true;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const h = sec.hunks[hi]!;
        for (let bi = h.body.length - 1; bi >= 0; bi -= 1) {
          if (h.body[bi]!.kind === 'new') {
            fb = !(bi + 1 < h.body.length && h.body[bi + 1]!.kind === 'bs');
            break outer;
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (fb ? '\n' : ''));
      return;
    }
    if (sec.isDelete || newP === null) {
      // Deletion: the new path is /dev/null, or a `deleted file mode` line is present.
      if (oldP === null) throw new Fail('unsafe', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    const target = (isMove ? oldP : oldP ?? newP)!;
    if (isMove) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
    } else if (tree.get(target) === null) throw new Fail('missing', target);
    const before = tree.get(isMove ? oldP! : target)!;
    const f = splitFile(before);
    let lines = f.lines;
    let finalBreak = f.finalBreak;
    let d = 0;
    for (const h of sec.hunks) {
      const { o, n } = hunkLines(h);
      if (o.length === 0) {
        const at = Math.max(0, Math.min(h.a + d, lines.length));
        const touchedEnd = at === lines.length;
        const made = n.map((x) => x.text);
        lines = [...lines.slice(0, at), ...made, ...lines.slice(at)];
        if (touchedEnd) finalBreak = !backslashAfterLast(h);
      } else {
        const found = firstTier(lines, o, strict, 0);
        if (found === null) throw new Fail('no-match', target);
        const want = h.a - 1 + d;
        let at = found.occ[0]!;
        for (const pos of found.occ) {
          if (Math.abs(pos - want) < Math.abs(at - want)) at = pos;
        }
        const touchedEnd = at + o.length === lines.length;
        lines = spliceMatch(lines, at, o, n, found.tier);
        if (touchedEnd) finalBreak = !backslashAfterLast(h);
      }
      d += n.length - o.length;
    }
    const out = joinFile({ lines, br: f.br, finalBreak });
    if (isMove) {
      tree.now.set(oldP!, null);
      tree.now.set(newP!, out);
      tree.moves.push([oldP!, newP!]);
    } else {
      tree.now.set(target, out);
    }
  };
}

/** Section 7: SEARCH/REPLACE blocks. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    let si = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        si = j;
        break;
      }
    }
    if (si < 0) break;
    let path: string | null = null;
    for (let k = si - 1; k >= prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${si + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let k = si + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        sep = k;
        break;
      }
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${si + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${si + 1}`);
    const oldLines = lines.slice(si + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(makeSearchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = firstTier(f.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const nItems: NewLine[] = newLines.map((t) => ({ text: t, oIndex: null }));
    const made = spliceMatch(f.lines, found.occ[0]!, oldLines, nItems, found.tier);
    tree.now.set(path, joinFile({ lines: made, br: f.br, finalBreak: f.finalBreak }));
  };
}

/** Section 8: V4A patches. */
interface V4Chunk {
  anchor: string | null;
  body: BodyItem[];
  eof: boolean;
}

const v4SectionStart = (line: string): 'add' | 'del' | 'upd' | null => {
  if (line.startsWith('*** Add File: ')) return 'add';
  if (line.startsWith('*** Delete File: ')) return 'del';
  if (line.startsWith('*** Update File: ')) return 'upd';
  return null;
};

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = v4SectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(line.indexOf(':') + 1).trim();
    i += 1;
    if (kind === 'del') {
      edits.push(makeV4DeleteEdit(path));
      continue;
    }
    if (kind === 'add') {
      const fileLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (v4SectionStart(l) !== null) break;
        if (blank(l)) {
          // Blank lines at the end of a section are not part of it; inside, they are empty lines.
          let k = i;
          while (k < last && blank(lines[k]!)) k += 1;
          if (k >= last || v4SectionStart(lines[k]!) !== null) {
            i = k;
            break;
          }
          for (; i < k; i += 1) fileLines.push('');
          continue;
        }
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(makeV4AddEdit(path, fileLines));
      continue;
    }
    // Update File section.
    let moveTo: string | null = null;
    if (i < last && lines[i]!.startsWith('*** Move to:')) {
      moveTo = lines[i]!.slice('*** Move to:'.length).trim();
      i += 1;
    }
    const chunks: V4Chunk[] = [];
    let chunk: V4Chunk | null = null;
    const sectionLine = i - (moveTo === null ? 1 : 2);
    while (i < last) {
      const l = lines[i]!;
      if (v4SectionStart(l) !== null) break;
      if (l.startsWith('@@')) {
        chunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), body: [], eof: false };
        chunks.push(chunk);
        i += 1;
        continue;
      }
      if (l.trim() === '*** End of File') {
        if (chunk === null) {
          chunk = { anchor: null, body: [], eof: true };
          chunks.push(chunk);
        } else chunk.eof = true;
        i += 1;
        continue;
      }
      if (blank(l)) {
        // Blank lines at the end of a section are not part of it; inside, empty context lines.
        let k = i;
        while (k < last && blank(lines[k]!)) k += 1;
        if (k >= last || v4SectionStart(lines[k]!) !== null) {
          i = k;
          break;
        }
        if (chunk === null) {
          chunk = { anchor: null, body: [], eof: false };
          chunks.push(chunk);
        }
        for (; i < k; i += 1) chunk.body.push({ kind: 'ctx', text: '', rawEmpty: true });
        continue;
      }
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        if (chunk === null) {
          chunk = { anchor: null, body: [], eof: false };
          chunks.push(chunk);
        }
        const bkind: BodyItem['kind'] = l === '' ? 'ctx' : l.startsWith(' ') ? 'ctx' : l.startsWith('-') ? 'old' : 'new';
        chunk.body.push({ kind: bkind, text: l === '' ? '' : l.slice(1), rawEmpty: l === '' ? true : undefined });
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // Trailing blank body lines of the last chunk are not part of the section, unless it ends with End of File.
    if (chunks.length > 0) {
      const tail = chunks[chunks.length - 1]!;
      if (!tail.eof) {
        while (tail.body.length > 0) {
          const lastItem = tail.body[tail.body.length - 1]!;
          if (lastItem.kind === 'ctx' && lastItem.text.trim() === '') tail.body.pop();
          else break;
        }
      }
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine + 1}`);
    edits.push(makeV4UpdateEdit(path, moveTo, chunks, strict));
  }
  return edits;
}

function makeV4AddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
  };
}

function makeV4DeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** First line at or after `from` equal to the anchor at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = Math.max(0, from); i < lines.length; i += 1) {
      if (tierEqual(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

function makeV4UpdateEdit(path: string, moveTo: string | null, chunks: V4Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(cur);
    let lines = f.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const ai = findAnchor(lines, chunk.anchor, cursor, strict);
        if (ai === null) throw new Fail('no-match', path);
        cursor = ai + 1;
      }
      const { o, n } = hunkLines({ a: 0, body: chunk.body });
      if (o.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        const made = n.map((x) => x.text);
        lines = [...lines.slice(0, at), ...made, ...lines.slice(at)];
        cursor = at + made.length;
      } else {
        let found: { tier: number; occ: number[] } | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const occ = occurrencesAt(lines, o, t, cursor).filter((pos) => !chunk.eof || pos + o.length === lines.length);
          if (occ.length > 0) {
            found = { tier: t, occ };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', path);
        const at = found.occ[0]!;
        lines = spliceMatch(lines, at, o, n, found.tier);
        cursor = at + n.length;
      }
    }
    const out = joinFile({ lines, br: f.br, finalBreak: f.finalBreak });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A successful move prints one `R <old> -> <new>` line (sorted by <new>) instead of the pair's D and A lines.
  const moved = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outRows = rows.map((r) => r.line);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
