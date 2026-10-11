'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { countryName } from '@/lib/names';
import type { Lang } from '@/lib/i18n';
import { ExplorerIcon } from '../ExplorerUI';
import { COUNTRY_CODES } from './countries';

export const countryFlag = (code: string) => /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map(c => 127397 + c.charCodeAt(0))) : '';

/** Typing only searches options; only an explicit choice changes the directory request. */
export function CountryAutocomplete({ lang, value, onChange }: { lang: Lang; value: string; onChange: (code: string) => void }) {
  const th = lang === 'th';
  const world = th ? 'ทั่วโลก' : 'Worldwide';
  const label = th ? 'ประเทศ' : 'Country';
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const countries = useMemo(() => COUNTRY_CODES.map(code => ({ code, name: countryName(code, lang), english: countryName(code, 'en') })).sort((a, b) => a.name.localeCompare(b.name, lang)), [lang]);
  const q = query.trim().toLocaleLowerCase();
  const options = useMemo(() => [
    ...(!q || [world, 'worldwide', 'whole world', 'all', 'ทั่วโลก', 'ทั้งโลก'].some(n => n.toLocaleLowerCase().includes(q)) ? [{code:'', name:world, english:th?'ทุกประเทศ':'All countries'}] : []),
    ...countries.filter(c => !q || [c.name, c.english, c.code].some(n => n.toLocaleLowerCase().includes(q))).sort((a,b) => (a.code.toLowerCase()===q?-1:0)-(b.code.toLowerCase()===q?-1:0)),
  ], [countries, q, world, th]);
  const selectedName = value ? countryName(value, lang) : world;
  const close = () => { setOpen(false); setQuery(''); setActive(0); };
  const choose = (code: string) => { onChange(code); close(); input.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setOpen(false); setQuery(''); setActive(0); } };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (open) root.current?.querySelector(`[data-country-index="${active}"]`)?.scrollIntoView?.({block:'nearest'});
  }, [open, active]);
  return <div ref={root} className="explorer-country-autocomplete">
    <label htmlFor={`${id}-input`}>{label}<span>{th?'ไม่บังคับ':'Optional'}</span></label>
    <div className="explorer-country-field" data-open={open}>
      <span className="explorer-country-flag" aria-hidden="true">{value ? countryFlag(value) : <ExplorerIcon kind="globe"/>}</span>
      <input ref={input} id={`${id}-input`} role="combobox" aria-label={label} aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-list`} aria-activedescendant={open&&options[active]?`${id}-option-${options[active].code||'world'}`:undefined} autoComplete="off" spellCheck={false} value={open?query:selectedName} placeholder={th?'พิมพ์ชื่อประเทศ หรือรหัส…':'Type a country or code…'} onFocus={()=>{setOpen(true);setActive(0)}} onClick={()=>{if(!open){setOpen(true);setActive(0)}}} onBlur={close} onChange={e=>{setQuery(e.target.value);setOpen(true);setActive(0)}} onKeyDown={e=>{
        if(e.key==='Escape'&&open){e.preventDefault();e.stopPropagation();close();}
        else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(!open){setOpen(true);setActive(e.key==='ArrowUp'?Math.max(0,options.length-1):0)}else if(options.length)setActive(i=>(i+(e.key==='ArrowDown'?1:-1)+options.length)%options.length);}
        else if(e.key==='Enter'&&open){e.preventDefault();if(options[active])choose(options[active].code);}
      }}/>
      <button type="button" className="explorer-country-toggle" aria-label={th?'แสดงตัวเลือกประเทศ':'Show country options'} aria-expanded={open} onPointerDown={e=>e.preventDefault()} onClick={()=>{if(open)close();else{input.current?.focus();setOpen(true);setActive(0)}}}><ExplorerIcon kind={open?'up':'down'}/></button>
    </div>
    {open&&<div className="explorer-country-popup"><ul id={`${id}-list`} role="listbox" aria-label={label}>{options.map((c,i)=><li key={c.code} id={`${id}-option-${c.code||'world'}`} role="option" aria-selected={value===c.code} data-country-index={i} data-active={active===i} onPointerDown={e=>e.preventDefault()} onClick={()=>choose(c.code)}>
      <span className="explorer-country-flag" aria-hidden="true">{c.code?countryFlag(c.code):<ExplorerIcon kind="globe"/>}</span><span className="explorer-country-name">{c.name}<small>{c.code?`${c.english} · ${c.code}`:c.english}</small></span>{value===c.code&&<span className="explorer-country-check" aria-hidden="true">✓</span>}
    </li>)}</ul>{!options.length&&<p role="status">{th?'ไม่พบประเทศ ลองชื่อภาษาอังกฤษหรือรหัสประเทศ':'No countries found. Try an English name or country code.'}</p>}</div>}
  </div>;
}
