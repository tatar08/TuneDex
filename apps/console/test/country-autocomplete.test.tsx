// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { CountryAutocomplete } from '@/app/app/explore/CountryAutocomplete';
import type { Lang } from '@/lib/i18n';
afterEach(cleanup);
function mount(lang:Lang='th',initial=''){
 const changed=vi.fn();
 function Harness(){const [value,setValue]=useState(initial);return <><CountryAutocomplete lang={lang} value={value} onChange={c=>{changed(c);setValue(c)}}/><button>Outside</button></>}
 render(<Harness/>);return changed;
}
it('searches Thai, English and ISO codes without committing while typing; Enter selects',async()=>{
 const changed=mount();const user=userEvent.setup();const input=screen.getByRole('combobox',{name:'ประเทศ'});
 await user.click(input);await user.type(input,'japan');expect(screen.getAllByRole('option')).toHaveLength(1);expect(changed).not.toHaveBeenCalled();
 await user.keyboard('{Enter}');expect(changed).toHaveBeenLastCalledWith('JP');expect((input as HTMLInputElement).value).toBe('ญี่ปุ่น');expect(input.getAttribute('aria-expanded')).toBe('false');
 await user.click(input);await user.type(input,'ไทย');expect(screen.getAllByRole('option')).toHaveLength(1);await user.keyboard('{Enter}');expect(changed).toHaveBeenLastCalledWith('TH');
 await user.click(input);await user.type(input,'TH');await user.keyboard('{Enter}');expect(changed).toHaveBeenLastCalledWith('TH');
 await user.click(input);await user.type(input,'GB');expect(screen.getAllByRole('option')).toHaveLength(1);await user.keyboard('{Enter}');expect(changed).toHaveBeenLastCalledWith('GB');
});
it('keeps the chosen country after invalid input, Escape or outside click',async()=>{
 const changed=mount('th','TH');const user=userEvent.setup();const input=screen.getByRole('combobox');
 await user.click(input);await user.type(input,'zzzzzz');expect(screen.queryAllByRole('option')).toHaveLength(0);await user.keyboard('{Enter}');expect(changed).not.toHaveBeenCalled();
 await user.keyboard('{Escape}');expect((input as HTMLInputElement).value).toBe('ไทย');expect(screen.queryByRole('listbox')).toBeNull();
 await user.click(input);await user.type(input,'japan');await user.click(screen.getByRole('button',{name:'Outside'}));expect((input as HTMLInputElement).value).toBe('ไทย');expect(changed).not.toHaveBeenCalled();
});
it('supports arrow-key navigation and an explicit Worldwide reset with pointer',async()=>{
 const changed=mount('en','JP');const user=userEvent.setup();const input=screen.getByRole('combobox',{name:'Country'});
 await user.click(input);await user.type(input,'united');const id=input.getAttribute('aria-activedescendant');await user.keyboard('{ArrowDown}');expect(input.getAttribute('aria-activedescendant')).not.toBe(id);await user.keyboard('{Enter}');expect(changed).toHaveBeenCalledTimes(1);
 await user.click(input);await user.click(screen.getByRole('option',{name:/Worldwide/}));expect(changed).toHaveBeenLastCalledWith('');expect((input as HTMLInputElement).value).toBe('Worldwide');expect(screen.queryByRole('listbox')).toBeNull();
});
