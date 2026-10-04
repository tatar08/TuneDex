import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ADMIN_EN, translator } from '@/lib/admin-i18n';

const THAI = /[฀-๿]/;
const ROOT = join(__dirname, '..', 'src');
/** Shown as is in both languages: the switch back to Thai is written in Thai. */
const ALWAYS_THAI = new Set(['ภาษาไทย']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

/** Every piece of Thai text in a file: string literals must have English; Thai in JSX text or `${}` templates is never translatable. */
function scan(path: string): { literals: string[]; untranslatable: string[] } {
  const src = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const literals: string[] = [];
  const untranslatable: string[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && THAI.test(n.text)) literals.push(n.text);
    else if (ts.isTemplateExpression(n) && THAI.test(n.getText())) untranslatable.push(n.getText());
    else if (ts.isJsxText(n) && THAI.test(n.text)) untranslatable.push(n.text.trim());
    ts.forEachChild(n, visit);
  };
  visit(src);
  return { literals, untranslatable };
}

const ADMIN_FILES = [...files(join(ROOT, 'app', 'admin')), join(ROOT, 'lib', 'admin.ts')];

describe('staff console English (Doc 17 Thai/English on every page)', () => {
  it.each(ADMIN_FILES.map((p) => [p.slice(ROOT.length + 1), p]))('%s has English for all its Thai text', (_name, path) => {
    const { literals, untranslatable } = scan(path);
    expect(untranslatable, 'wrap Thai in t() with {0} placeholders instead of JSX text or template literals').toEqual([]);
    expect(literals.filter((l) => !(l in ADMIN_EN) && !ALWAYS_THAI.has(l))).toEqual([]);
  });

  it('keeps every placeholder in the English text', () => {
    for (const [th, en] of Object.entries(ADMIN_EN)) {
      const holes = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join();
      expect([th, holes(en)]).toEqual([th, holes(th)]);
      expect(THAI.test(en), `English for "${th}" still has Thai`).toBe(false);
    }
  });

  it('fills placeholders and falls back to Thai', () => {
    const en = translator('en');
    expect(translator('th')('รุ่น {0}', 3)).toBe('รุ่น 3');
    expect(en('ข้อความที่ไม่มีในตาราง')).toBe('ข้อความที่ไม่มีในตาราง');
  });
});
