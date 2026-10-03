// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsForm } from '@/app/app/settings/SettingsForm';
import type { SettingsView } from '@/lib/bff';

// jsdom lacks CSS.escape, which user-event uses to walk radio groups with arrow keys.
if (!globalThis.CSS?.escape) {
  (globalThis as unknown as { CSS: { escape: (v: string) => string } }).CSS = { escape: (v) => v.replace(/[^\w-]/g, (c) => `\\${c}`) };
}

const view = (revision: number, settings: Partial<SettingsView['settings']> = {}): SettingsView => ({
  revision,
  schemaVersion: 1,
  settings: { theme: 'system', language: 'th', cellularPolicy: 'allow', ...settings },
  updatedAt: revision ? '2026-10-03T12:00:00.000Z' : null,
});

const reply = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SettingsForm', () => {
  it('groups each setting as a labelled radio group and shows the pending device state', () => {
    render(<SettingsForm initial={view(0)} csrfToken="csrf-1" />);
    expect(screen.getByRole('group', { name: 'ธีมของแอป' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'ภาษา' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'ฟังวิทยุผ่านเน็ตมือถือ' })).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'ตามระบบ' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('รอซิงก์')).toBeTruthy();
    expect(screen.getByText(/ยังไม่เคยบันทึก/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'บันทึก' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('can be changed and saved with the keyboard alone, sending CSRF and If-Match', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => reply(200, view(1, { theme: 'dark' })));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<SettingsForm initial={view(0)} csrfToken="csrf-1" />);

    await user.tab(); // sign-out button
    await user.tab(); // theme radio group
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'ตามระบบ' }));
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect((screen.getByRole('radio', { name: 'มืด' }) as HTMLInputElement).checked).toBe(true);
    await user.tab(); // language
    await user.tab(); // cellular policy
    await user.tab(); // save
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'บันทึก' }));
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByTestId('saved-revision').textContent).toBe('บันทึกแล้ว · revision 1'));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/bff/settings');
    expect(init?.method).toBe('PATCH');
    expect(init?.headers).toMatchObject({ 'if-match': '"0"', 'x-csrf-token': 'csrf-1' });
    expect(JSON.parse(init?.body as string)).toEqual({ theme: 'dark' });
  });

  it('on a conflict, explains it, moves focus to the alert and offers both choices', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => reply(412, { code: 'REVISION_MISMATCH', details: { currentRevision: 4 } }))
      .mockImplementationOnce(() => reply(200, view(4, { theme: 'light' })))
      .mockImplementationOnce(() => reply(200, view(5, { theme: 'dark' })));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<SettingsForm initial={view(3)} csrfToken="csrf-1" />);
    await user.click(screen.getByRole('radio', { name: 'มืด' }));
    await user.click(screen.getByRole('button', { name: 'บันทึก' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('revision 4');
    expect(document.activeElement).toBe(alert);
    expect(screen.getByRole('button', { name: 'ใช้ค่าล่าสุดจากเซิร์ฟเวอร์' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'บันทึกค่าของฉันทับ' }));
    await waitFor(() => expect(screen.getByTestId('saved-revision').textContent).toBe('บันทึกแล้ว · revision 5'));
    const third = fetchMock.mock.calls[2][1] as RequestInit;
    expect((third.headers as Record<string, string>)['if-match']).toBe('"4"');
    expect(JSON.parse(third.body as string)).toEqual({ theme: 'dark' });
  });

  it('can take the server values after a conflict without saving', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => reply(412, { code: 'REVISION_MISMATCH', details: { currentRevision: 2 } }))
        .mockImplementationOnce(() => reply(200, view(2, { cellularPolicy: 'wifi_only' }))),
    );
    const user = userEvent.setup();
    render(<SettingsForm initial={view(1)} csrfToken="c" />);
    await user.click(screen.getByRole('radio', { name: 'มืด' }));
    await user.click(screen.getByRole('button', { name: 'บันทึก' }));
    await user.click(await screen.findByRole('button', { name: 'ใช้ค่าล่าสุดจากเซิร์ฟเวอร์' }));
    expect((screen.getByRole('radio', { name: 'เฉพาะ Wi-Fi' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: 'ตามระบบ' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('tells the user to sign in again when the session has ended', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply(401, { code: 'SESSION_EXPIRED' })));
    const user = userEvent.setup();
    render(<SettingsForm initial={view(1)} csrfToken="c" />);
    await user.click(screen.getByRole('radio', { name: 'เฉพาะ Wi-Fi' }));
    await user.click(screen.getByRole('button', { name: 'บันทึก' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('หมดเวลาเข้าใช้งาน');
    expect(screen.getByRole('link', { name: 'เข้าสู่ระบบ' }).getAttribute('href')).toBe('/auth/login?returnTo=/app/settings');
  });

  it('shows invalid and unavailable errors without claiming a save', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply(503, { code: 'UPSTREAM_UNAVAILABLE' })));
    const user = userEvent.setup();
    render(<SettingsForm initial={view(1)} csrfToken="c" />);
    await user.click(screen.getByRole('radio', { name: 'มืด' }));
    await user.click(screen.getByRole('button', { name: 'บันทึก' }));
    expect((await screen.findByRole('alert')).textContent).toContain('ยังไม่ได้บันทึก');
    expect(screen.getByTestId('saved-revision').textContent).toBe('บันทึกแล้ว · revision 1');
  });

  it('switches its labels to English after saving language = en', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply(200, view(2, { language: 'en' }))));
    const user = userEvent.setup();
    render(<SettingsForm initial={view(1)} csrfToken="c" />);
    await user.click(screen.getByRole('radio', { name: 'English' }));
    await user.click(screen.getByRole('button', { name: 'บันทึก' }));
    await screen.findByRole('heading', { name: 'Settings' });
    expect(document.documentElement.lang).toBe('en');
  });
});
